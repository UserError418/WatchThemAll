import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaSummary } from '@shared/types'

/**
 * Federated search behaviour.
 *
 * Both backends are mocked: these tests are about the *merge*, which is where
 * the interesting mistakes live. The network behaviour of each client is its
 * own concern and untestable without hitting live, undocumented endpoints.
 */

vi.mock('./tmdb', () => ({
  search: vi.fn(),
  findByImdb: vi.fn(),
}))
vi.mock('./imdb', () => ({
  search: vi.fn(),
}))

const tmdb = await import('./tmdb')
const imdb = await import('./imdb')
const { search, resolve } = await import('./search')

function summary(overrides: Partial<MediaSummary> = {}): MediaSummary {
  return {
    tmdbId: 1,
    type: 'tv',
    title: 'Breaking Bad',
    posterPath: null,
    backdropPath: null,
    overview: '',
    rating: 0,
    releaseDate: '2008-01-20',
    genreIds: [],
    ...overrides,
  }
}

const mockTmdb = (items: MediaSummary[], totalPages = 1): void => {
  vi.mocked(tmdb.search).mockResolvedValue({ items, page: 1, totalPages })
}
const mockImdb = (items: MediaSummary[]): void => {
  vi.mocked(imdb.search).mockResolvedValue({ items, page: 1, totalPages: 1 })
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('merging the two backends', () => {
  it('keeps the TMDB record when both backends return the same title', async () => {
    mockTmdb([summary({ tmdbId: 1396, posterPath: '/poster.jpg', source: 'tmdb' })])
    mockImdb([summary({ tmdbId: 0, imdbId: 'tt0903747', source: 'imdb' })])

    const result = await search('breaking bad')

    expect(result.items).toHaveLength(1)
    // TMDB's record is the richer one — it has artwork.
    expect(result.items[0]!.tmdbId).toBe(1396)
    expect(result.items[0]!.posterPath).toBe('/poster.jpg')
  })

  it('never copies an IMDB id onto a TMDB record across a fuzzy match', async () => {
    mockTmdb([summary({ tmdbId: 1396, source: 'tmdb' })])
    mockImdb([summary({ tmdbId: 0, imdbId: 'tt0903747', source: 'imdb' })])

    const result = await search('breaking bad')

    // Title+year matching is good enough to dedupe a display list and NOT good
    // enough to assign an id. Getting this wrong plays the wrong programme.
    expect(result.items[0]!.imdbId).toBeUndefined()
  })

  it('keeps IMDB results TMDB does not have, which is the whole point', async () => {
    mockTmdb([summary({ title: 'Breaking Bad', tmdbId: 1396 })])
    mockImdb([
      summary({ title: 'Breaking Bad', tmdbId: 0, imdbId: 'tt0903747' }),
      summary({ title: 'Some Obscure Film', tmdbId: 0, imdbId: 'tt9999999', releaseDate: '1974-01-01' }),
    ])

    const result = await search('breaking bad')
    const titles = result.items.map((i) => i.title)

    expect(titles).toContain('Some Obscure Film')
    expect(result.items.find((i) => i.title === 'Some Obscure Film')?.imdbId).toBe('tt9999999')
  })

  it('treats a remake as a distinct title rather than a duplicate', async () => {
    mockTmdb([summary({ title: 'Suspiria', type: 'movie', releaseDate: '2018-10-11', tmdbId: 1 })])
    mockImdb([
      summary({ title: 'Suspiria', type: 'movie', releaseDate: '1977-02-01', tmdbId: 0, imdbId: 'tt0076786' }),
    ])

    const result = await search('suspiria')
    expect(result.items).toHaveLength(2)
  })

  it('does not merge a film and a series that share a title', async () => {
    mockTmdb([summary({ title: 'Fargo', type: 'movie', releaseDate: '1996-03-08' })])
    mockImdb([summary({ title: 'Fargo', type: 'tv', releaseDate: '1996-03-08', tmdbId: 0 })])

    const result = await search('fargo')
    expect(result.items).toHaveLength(2)
  })

  it('ignores punctuation differences between the two sources', async () => {
    mockTmdb([summary({ title: 'WALL·E', type: 'movie', releaseDate: '2008-06-27' })])
    mockImdb([summary({ title: 'WALL-E', type: 'movie', releaseDate: '2008-06-27', tmdbId: 0 })])

    const result = await search('wall e')
    expect(result.items).toHaveLength(1)
  })
})

/**
 * Every merged result must be uniquely identifiable.
 *
 * This is not academic. The search view keys its list on a composite of type
 * and id, and every IMDB-sourced result carries `tmdbId: 0` — so keying on the
 * TMDB id alone gave every IMDB result the same key, Svelte refused to render
 * the keyed block, and the entire search surface went blank. The backend was
 * returning 23 correct results the whole time.
 */
describe('result identity', () => {
  it('gives every result a unique (type, tmdbId, imdbId) key', async () => {
    mockTmdb([summary({ title: 'A', tmdbId: 1, releaseDate: '2001-01-01' })])
    mockImdb([
      summary({ title: 'B', tmdbId: 0, imdbId: 'tt1', releaseDate: '2002-01-01' }),
      summary({ title: 'C', tmdbId: 0, imdbId: 'tt2', releaseDate: '2003-01-01' }),
      summary({ title: 'D', tmdbId: 0, imdbId: 'tt3', releaseDate: '2004-01-01' }),
    ])

    const result = await search('x')
    const keys = result.items.map((i) => `${i.type}-${i.tmdbId || i.imdbId}`)

    expect(keys).toHaveLength(4)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('leaves every IMDB-sourced result with an id to key on', async () => {
    mockTmdb([])
    mockImdb([
      summary({ title: 'B', tmdbId: 0, imdbId: 'tt1', releaseDate: '2002-01-01' }),
      summary({ title: 'C', tmdbId: 0, imdbId: 'tt2', releaseDate: '2003-01-01' }),
    ])

    const result = await search('x')
    // A result with neither id would collide with every other such result.
    expect(result.items.every((i) => i.tmdbId > 0 || Boolean(i.imdbId))).toBe(true)
  })
})

describe('resilience', () => {
  it('returns TMDB results when IMDB is down', async () => {
    mockTmdb([summary({ title: 'Breaking Bad' })])
    vi.mocked(imdb.search).mockRejectedValue(new Error('IMDB suggestion responded 503'))

    const result = await search('breaking bad')
    expect(result.items).toHaveLength(1)
  })

  it('returns IMDB results when TMDB is down', async () => {
    vi.mocked(tmdb.search).mockRejectedValue(new Error('TMDB responded 401'))
    mockImdb([summary({ title: 'Breaking Bad', tmdbId: 0, imdbId: 'tt0903747' })])

    const result = await search('breaking bad')
    expect(result.items).toHaveLength(1)
    expect(result.items[0]!.imdbId).toBe('tt0903747')
  })

  it('returns an empty result rather than throwing when both are down', async () => {
    vi.mocked(tmdb.search).mockRejectedValue(new Error('down'))
    vi.mocked(imdb.search).mockRejectedValue(new Error('down'))

    await expect(search('anything')).resolves.toEqual({ items: [], page: 1, totalPages: 1 })
  })

  it('does not call either backend for a blank query', async () => {
    await search('   ')
    expect(tmdb.search).not.toHaveBeenCalled()
    expect(imdb.search).not.toHaveBeenCalled()
  })
})

describe('paging', () => {
  it('federates only the first page', async () => {
    mockTmdb([summary()], 5)
    mockImdb([summary({ tmdbId: 0, imdbId: 'tt1' })])

    await search('x', 2)

    // IMDB returns one un-paginated batch; merging it into page 2 would repeat
    // the same results all the way down the list.
    expect(imdb.search).not.toHaveBeenCalled()
    expect(tmdb.search).toHaveBeenCalledWith('x', 2)
  })
})

describe('relevance ordering', () => {
  it('puts an exact title match above a partial one', async () => {
    mockTmdb([
      summary({ title: 'The Bad Guys: Breaking In', tmdbId: 2, releaseDate: '2025-01-01' }),
      summary({ title: 'Breaking Bad', tmdbId: 1396 }),
    ])
    mockImdb([])

    const result = await search('breaking bad')
    expect(result.items[0]!.title).toBe('Breaking Bad')
  })
})

describe('resolve', () => {
  it('passes through a summary that already has a TMDB id', async () => {
    const item = summary({ tmdbId: 1396 })
    await expect(resolve(item)).resolves.toBe(item)
    expect(tmdb.findByImdb).not.toHaveBeenCalled()
  })

  it('bridges an IMDB-sourced summary to its TMDB id', async () => {
    vi.mocked(tmdb.findByImdb).mockResolvedValue({ tmdbId: 1396, type: 'tv' })

    const result = await resolve(summary({ tmdbId: 0, imdbId: 'tt0903747' }))
    expect(result?.tmdbId).toBe(1396)
  })

  it("trusts TMDB's type over IMDB's guess", async () => {
    // IMDB's `qid` vocabulary defaults to TV for anything unrecognised, so
    // TMDB knowing it as a film is the better evidence.
    vi.mocked(tmdb.findByImdb).mockResolvedValue({ tmdbId: 550, type: 'movie' })

    const result = await resolve(summary({ tmdbId: 0, imdbId: 'tt0137523', type: 'tv' }))
    expect(result?.type).toBe('movie')
  })

  it('returns null when TMDB has never heard of the title', async () => {
    vi.mocked(tmdb.findByImdb).mockResolvedValue(null)
    await expect(resolve(summary({ tmdbId: 0, imdbId: 'tt0000001' }))).resolves.toBeNull()
  })

  it('returns null when there is no id to bridge from', async () => {
    await expect(resolve(summary({ tmdbId: 0, imdbId: null }))).resolves.toBeNull()
  })
})
