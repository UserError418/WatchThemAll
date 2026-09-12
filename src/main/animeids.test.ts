/**
 * The mapping's failure mode is silent and specific: ask AniSkip about the
 * wrong MAL entry and it answers confidently with a different season's
 * opening, which is a skip button that jumps somewhere arbitrary. So the
 * season-matching rules get most of the attention here.
 *
 * The fixtures are the real published shape, copied from
 * `Fribb/anime-lists/anime-list-mini.json`.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { load, lookup, malIdFor, reduce, resetForTests, type FetchLike } from './animeids'

afterEach(() => resetForTests())

const PUBLISHED = [
  {
    type: 'TV',
    anidb_id: 1,
    mal_id: 16498,
    imdb_id: ['tt2560140'],
    themoviedb_id: { tv: 1429 },
    tvdb_id: 267440,
    season: { tvdb: 1, tmdb: 1 },
  },
  { type: 'TV', mal_id: 25777, themoviedb_id: { tv: 1429 }, season: { tvdb: 2, tmdb: 2 } },
  { type: 'TV', mal_id: 21, themoviedb_id: { tv: 37854 }, season: { tvdb: 1, tmdb: null } },
  // A film: `themoviedb_id` is a bare number and there is no season to skip in.
  { type: 'MOVIE', mal_id: 32281, themoviedb_id: 372058 },
  // An entry with no TMDB id at all, which is common in the published file.
  { type: 'OVA', mal_id: 999, themoviedb_id: null },
]

function stub(body: unknown, ok = true): { fetchImpl: FetchLike; calls: number } {
  const state = { calls: 0 }
  const fetchImpl = (async () => {
    state.calls += 1
    return { ok, status: ok ? 200 : 500, json: async () => body } as Response
  }) as FetchLike
  return {
    get fetchImpl() {
      return fetchImpl
    },
    get calls() {
      return state.calls
    },
  }
}

describe('reducing the published file', () => {
  it('keeps only TV entries that have both ids', () => {
    // 5.8 MB in, three rows out. The film and the id-less OVA are dropped
    // because neither can ever produce a MAL lookup from a TMDB series.
    expect(reduce(PUBLISHED)).toEqual([
      [16498, 1429, 1],
      [25777, 1429, 2],
      [21, 37854, null],
    ])
  })

  it('returns nothing for a body that is not the expected array', () => {
    expect(reduce({ error: 'rate limited' })).toEqual([])
    expect(reduce(null)).toEqual([])
  })
})

describe('picking the right MAL entry', () => {
  const rows = reduce(PUBLISHED)

  it('matches the season exactly when the mapping names one', () => {
    expect(lookup(rows, 1429, 1)).toBe(16498)
    expect(lookup(rows, 1429, 2)).toBe(25777)
  })

  it('uses an unseasoned mapping for season one', () => {
    // One Piece: MAL has a single entry, TMDB has many seasons.
    expect(lookup(rows, 37854, 1)).toBe(21)
  })

  it('refuses an unseasoned mapping for a later season', () => {
    // This is the dangerous case. AniSkip would answer for the entry given,
    // so guessing here produces a confidently wrong skip rather than none.
    expect(lookup(rows, 37854, 4)).toBeNull()
  })

  it('has no answer for a series that is not anime', () => {
    expect(lookup(rows, 1396, 1)).toBeNull()
  })

  it('does not return a film entry for a series lookup', () => {
    expect(lookup(rows, 372058, 1)).toBeNull()
  })
})

describe('the cache', () => {
  it('downloads once, then answers from memory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wta-anime-'))
    const source = stub(PUBLISHED)

    expect(await malIdFor(dir, 1429, 2, source.fetchImpl)).toBe(25777)
    expect(await malIdFor(dir, 1429, 1, source.fetchImpl)).toBe(16498)
    expect(source.calls).toBe(1)
  })

  it('writes only the reduction, not the 5.8 MB it came from', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wta-anime-'))
    await malIdFor(dir, 1429, 1, stub(PUBLISHED).fetchImpl)

    const written = JSON.parse(await readFile(join(dir, 'anime-ids.json'), 'utf8')) as {
      rows: unknown[]
    }
    expect(written.rows).toEqual([
      [16498, 1429, 1],
      [25777, 1429, 2],
      [21, 37854, null],
    ])
  })

  it('reads a fresh cache from disk without going to the network', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wta-anime-'))
    await writeFile(
      join(dir, 'anime-ids.json'),
      JSON.stringify({ fetchedAt: Date.now(), rows: [[123, 456, 1]] }),
      'utf8',
    )
    const source = stub(PUBLISHED)

    expect(await malIdFor(dir, 456, 1, source.fetchImpl)).toBe(123)
    expect(source.calls).toBe(0)
  })

  it('keeps using a stale cache when the refresh fails', async () => {
    // Last month's ids are right about every anime that existed last month.
    // Dropping them because GitHub was briefly unreachable would turn a
    // network blip into a missing feature.
    const dir = await mkdtemp(join(tmpdir(), 'wta-anime-'))
    const ancient = Date.now() - 400 * 24 * 60 * 60 * 1000
    await writeFile(
      join(dir, 'anime-ids.json'),
      JSON.stringify({ fetchedAt: ancient, rows: [[123, 456, 1]] }),
      'utf8',
    )

    const failing = (async () => {
      throw new Error('offline')
    }) as unknown as FetchLike
    expect(await malIdFor(dir, 456, 1, failing)).toBe(123)
  })

  it('does not download twice when two episodes ask at the same moment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wta-anime-'))
    const source = stub(PUBLISHED)

    const [a, b] = await Promise.all([load(dir, source.fetchImpl), load(dir, source.fetchImpl)])
    expect(a).toBe(b)
    expect(source.calls).toBe(1)
  })

  it('answers null rather than throwing when there is no cache and no network', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wta-anime-'))
    expect(await malIdFor(dir, 1429, 1, stub({}, false).fetchImpl)).toBeNull()
  })
})
