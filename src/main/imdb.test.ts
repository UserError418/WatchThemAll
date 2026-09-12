import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The IMDB suggestion client.
 *
 * The endpoint is undocumented and unversioned, so these tests pin the two
 * things that decide whether a result is usable at all: what counts as a
 * playable title, and which of the provider URL templates it gets routed to.
 * Both have produced silent, user-visible failures — a person appearing as a
 * film, and a TV movie asked for season 1 episode 1 that does not exist.
 *
 * `fetch` is stubbed rather than hit: the live endpoint is rate-limited and its
 * ranking changes daily, so a test against it would fail for reasons unrelated
 * to this code.
 */

const { search } = await import('./imdb')

interface Suggestion {
  id?: string
  l?: string
  qid?: string
  y?: number
}

/** Feed the client one canned suggestion payload. */
function respond(items: Suggestion[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ d: items }),
    })),
  )
}

beforeEach(() => {
  // Each test uses a distinct query so the module's 10-minute response cache
  // never serves a previous test's payload.
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('what counts as a result', () => {
  it('keeps titles and drops people and franchises', async () => {
    respond([
      { id: 'tt38268282', l: 'Steel Ball Run', qid: 'tvSeries', y: 2026 },
      { id: 'nm17175965', l: 'Stainless Steel Ball Performers' },
      { id: 'in0000123', l: 'Some Franchise' },
    ])

    const result = await search('q-titles-only')
    expect(result.items.map((i) => i.imdbId)).toEqual(['tt38268282'])
  })

  it('gives every result an IMDB id, which is the only id it has', async () => {
    respond([{ id: 'tt0903747', l: 'Breaking Bad', qid: 'tvSeries', y: 2008 }])

    const result = await search('q-has-id')
    expect(result.items[0]!.imdbId).toBe('tt0903747')
    // TMDB's id is unknown here and filled in on demand by `resolve`.
    expect(result.items[0]!.tmdbId).toBe(0)
  })

  it('reports a single un-paginated page', async () => {
    respond([{ id: 'tt1', l: 'A', qid: 'movie' }])

    const result = await search('q-paging')
    // The endpoint returns one batch. Claiming more pages would make the search
    // view offer a "next page" that repeats the same results.
    expect(result.totalPages).toBe(1)
    expect(result.page).toBe(1)
  })
})

/**
 * The media type decides which provider URL template is used, and getting it
 * wrong is not a cosmetic error: a film routed through `/tv/{id}/{s}/{e}`
 * requests an episode that does not exist and the provider returns a 404.
 */
describe('routing a result to the right URL template', () => {
  it('treats an ongoing series as tv', async () => {
    respond([{ id: 'tt1', l: 'Series', qid: 'tvSeries' }])
    expect((await search('q-series')).items[0]!.type).toBe('tv')
  })

  it('treats a mini-series as tv', async () => {
    respond([{ id: 'tt1', l: 'Mini', qid: 'tvMiniSeries' }])
    expect((await search('q-mini')).items[0]!.type).toBe('tv')
  })

  it('treats a TV movie as a film, not a series', async () => {
    // It aired on television but has no seasons — the distinction the `tv`
    // prefix in the qid invites you to get wrong.
    respond([{ id: 'tt1', l: 'A TV Movie', qid: 'tvMovie' }])
    expect((await search('q-tvmovie')).items[0]!.type).toBe('movie')
  })

  it('treats a TV special as a film, not a series', async () => {
    respond([{ id: 'tt1', l: 'A Special', qid: 'tvSpecial' }])
    expect((await search('q-tvspecial')).items[0]!.type).toBe('movie')
  })

  it('treats a cinema release as a film', async () => {
    respond([{ id: 'tt1', l: 'A Film', qid: 'movie' }])
    expect((await search('q-movie')).items[0]!.type).toBe('movie')
  })
})

describe('tolerating an undocumented shape', () => {
  it('skips entries with no id rather than throwing', async () => {
    respond([{ l: 'No id at all', qid: 'movie' }, { id: 'tt1', l: 'Fine', qid: 'movie' }])

    const result = await search('q-missing-id')
    expect(result.items).toHaveLength(1)
  })

  it('falls back to a placeholder title rather than rendering "undefined"', async () => {
    respond([{ id: 'tt1', qid: 'movie' }])
    expect((await search('q-no-label')).items[0]!.title).toBe('Untitled')
  })

  it('defaults an unrecognised qid to tv rather than dropping the result', async () => {
    // A new vocabulary term should degrade to a usable guess, not a blank list.
    respond([{ id: 'tt1', l: 'Something New', qid: 'holoSeries' }])
    expect((await search('q-unknown-qid')).items[0]!.type).toBe('tv')
  })

  it('returns nothing for a blank query without calling the endpoint', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)

    const result = await search('   ')
    expect(result.items).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })
})
