import { describe, expect, it, vi } from 'vitest'
import type { MediaSummary } from '@shared/types'
import type { ForYouRow } from '@shared/ipc'
import { buildProfile } from './profile'
import {
  blend,
  buildRow,
  EXPLORE_EVERY,
  MIXED_PER_PAGE,
  mixedLanes,
  roundRobin,
  shelfGenres,
  TOP_PICKS_PER_PAGE,
  withExploration,
} from './rows'
import type { ForYouDeps } from './deps'
import { laneOf } from './lanes'
import { anime, DAY, deps, library, media, NOW, page, rated, store, wideLibrary } from './testing'

/** Top picks for TV shows, over the favourites the library fixture's tests recommend from. */
const TOP: ForYouRow = {
  kind: 'topPicks',
  key: 'for-you:top:series',
  title: 'Top TV show picks for you',
  lane: 'series',
  seeds: [1, 2, 3, 4, 5].map((tmdbId) => ({ tmdbId, type: 'tv' as const })),
}

type Discover = ForYouDeps['discover']

const ids = (items: readonly MediaSummary[]) => items.map((m) => m.tmdbId)

describe('Top picks', () => {
  it('ranks a title several favourites agree on above one only one mentions', async () => {
    const profile = buildProfile(library(), NOW)
    const result = await buildRow(TOP, 1, profile, deps({
      1: [media(100), media(200)],
      2: [media(200)],
      3: [media(200)],
    }))
    expect(result.items[0]?.tmdbId).toBe(200)
  })

  it('pushes down what the titles the user disliked also point at', async () => {
    const profile = buildProfile(library(), NOW)
    const recs = { 1: [media(100), media(101)], 6: [media(100)], 7: [media(100)] }
    const out = ids((await buildRow(TOP, 1, profile, deps(recs))).items)
    expect(out.indexOf(101)).toBeLessThan(out.indexOf(100) === -1 ? Infinity : out.indexOf(100))
  })

  it('leaves the rest of the pool to the rows below it', async () => {
    const profile = buildProfile(library(), NOW)
    const many = Array.from({ length: 20 }, (_, i) => media(1000 + i))
    const recs = { 1: many, 2: many.map((m) => media(m.tmdbId + 100)), 3: many.map((m) => media(m.tmdbId + 200)) }
    const result = await buildRow(TOP, 1, profile, deps(recs))
    expect(result.items).toHaveLength(TOP_PICKS_PER_PAGE)
  })

  it('ranks a candidate lower when a dislike also points at it, short of dropping it', async () => {
    const profile = buildProfile(library(), NOW)
    // Both favourites recommend 100 slightly ahead of 101; one disliked title
    // also recommends 100 — less strongly than the favourites do, so it stays,
    // but it should no longer lead.
    const recs = { 1: [media(100), media(101)], 2: [media(100), media(101)], 7: [media(100)] }
    expect(ids((await buildRow(TOP, 1, profile, deps(recs))).items)).toEqual([101, 100])
  })

  it('never recommends what the user already has', async () => {
    const profile = buildProfile(library(), NOW)
    const result = await buildRow(TOP, 1, profile, deps({ 1: [media(2), media(3), media(300)] }))
    expect(ids(result.items)).toEqual([300])
  })

  it('treats a film and a series with the same number as different titles', async () => {
    const profile = buildProfile(library(), NOW)
    // tv:1 is owned; movie:1 is not.
    const films: ForYouRow = { ...TOP, key: 'for-you:top:films', lane: 'films' }
    const result = await buildRow(films, 1, profile, deps({ 2: [media(1, [16], { type: 'movie' })] }))
    expect(ids(result.items)).toEqual([1])
  })

  it('reorders when the profile changes', async () => {
    // Same candidates, same seeds — only the ratings differ, so only the
    // profile can be responsible for the different order.
    const recs = { 1: [media(100, [80]), media(101, [16])], 2: [media(100, [80]), media(101, [16])] }
    const likesAnimation = buildProfile(store({
      ratings: [rated(1, 9, [16]), rated(2, 9, [16]), rated(3, 3, [80]), rated(4, 3, [80])],
    }), NOW)
    const likesCrime = buildProfile(store({
      ratings: [rated(1, 9, [80]), rated(2, 9, [80]), rated(3, 3, [16]), rated(4, 3, [16])],
    }), NOW)
    expect((await buildRow(TOP, 1, likesAnimation, deps(recs))).items[0]?.tmdbId).toBe(101)
    expect((await buildRow(TOP, 1, likesCrime, deps(recs))).items[0]?.tmdbId).toBe(100)
  })

  it('shows its own lane only, whatever the favourites recommend', async () => {
    const profile = buildProfile(library(), NOW)
    const recs = { 1: [anime(100), media(101), media(102, [16])], 2: [anime(103), media(104, [18], { type: 'movie' })] }
    const result = await buildRow(TOP, 1, profile, deps(recs))
    expect(ids(result.items)).toEqual(expect.arrayContaining([101, 102]))
    expect(result.items.every((m) => laneOf(m) === 'series')).toBe(true)
  })

  it("tops a thin lane up from the chart in the lane's favourite genres", async () => {
    const profile = buildProfile(library(), NOW)
    const discover = vi.fn<Discover>(async () => page([media(900, [80]), media(901, [80])]))
    const result = await buildRow(TOP, 1, profile, deps({ 1: [media(100)] }, { discover }))
    expect(ids(result.items)).toEqual([100, 900, 901])
    expect(discover).toHaveBeenCalledTimes(1)
    const [type, query] = discover.mock.calls[0]!
    expect(type).toBe('tv')
    expect(query.withGenres).toMatch(/^\d+(\|\d+)*$/)
  })

  it('makes a lane with no favourites of its own from its genres alone', async () => {
    const profile = buildProfile(library(), NOW)
    const films: ForYouRow = { ...TOP, key: 'for-you:top:films', lane: 'films', seeds: [] }
    const discover = vi.fn<Discover>(async (type) => page(type === 'movie' ? [media(900, [80], { type: 'movie' })] : []))
    const result = await buildRow(films, 1, profile, deps({}, { discover }))
    expect(ids(result.items)).toEqual([900])
  })

  it('asks for anime whole, in both catalogues', async () => {
    const profile = buildProfile(library(), NOW)
    const row: ForYouRow = { ...TOP, key: 'for-you:top:anime', lane: 'anime', seeds: [] }
    const discover = vi.fn<Discover>(async () => page([]))
    await buildRow(row, 1, profile, deps({}, { discover }))
    expect(discover).toHaveBeenCalledWith('tv', { withGenres: '16', language: 'ja' }, 1)
    expect(discover).toHaveBeenCalledWith('movie', { withGenres: '16', language: 'ja' }, 1)
  })
})

describe('Because rows', () => {
  it("re-ranks one favourite's recommendations by the profile", async () => {
    const profile = buildProfile(library(), NOW)
    const row: ForYouRow = { kind: 'because', key: 'k', title: 't', lane: 'series', seed: { tmdbId: 1, type: 'tv' } }
    // TMDB lists the romance first; the user dislikes romance.
    const result = await buildRow(row, 1, profile, deps({ 1: [media(500, [10749]), media(501, [80])] }))
    expect(result.items[0]?.tmdbId).toBe(501)
  })

  it("keeps to its lane: an anime's live-action recommendations are another lane's", async () => {
    const profile = buildProfile(library(), NOW)
    const row: ForYouRow = { kind: 'because', key: 'k', title: 't', lane: 'anime', seed: { tmdbId: 1, type: 'tv' } }
    const result = await buildRow(row, 1, profile, deps({ 1: [media(500), anime(501), media(502, [16])] }))
    expect(ids(result.items)).toEqual([501])
  })
})

describe('genre shelves', () => {
  const romanceHater = () => buildProfile(store({
    ratings: [
      ...Array.from({ length: 4 }, (_, i) => rated(i + 1, 9, [10765])),
      ...Array.from({ length: 4 }, (_, i) => rated(i + 10, 2, [10749], { type: 'movie' })),
    ],
  }), NOW)

  it("asks the lane's catalogue in its own genres, and excludes the user's avoided ones", async () => {
    const discover = vi.fn<Discover>(async () => page([]))
    const series: ForYouRow = { kind: 'genre', key: 'k', title: 't', lane: 'series', concepts: [10765] }
    await buildRow(series, 1, romanceHater(), deps({}, { discover }))
    // Series have no Romance genre, so there is nothing to exclude there.
    expect(discover.mock.calls).toEqual([['tv', { withGenres: '10765' }, 1]])

    discover.mockClear()
    const films: ForYouRow = { ...series, lane: 'films' }
    await buildRow(films, 1, romanceHater(), deps({}, { discover }))
    expect(discover.mock.calls).toEqual([['movie', { withGenres: '878|14', withoutGenres: '10749' }, 1]])
  })

  it("fills a shelf from the user's own favourites in that genre and lane before the chart", async () => {
    const profile = buildProfile(library(), NOW)
    // Titles 1 and 5 are the liked Action & Adventure anime.
    const recs: Record<number, MediaSummary[]> = {
      1: Array.from({ length: 8 }, (_, i) => anime(700 + i)),
      5: [...Array.from({ length: 6 }, (_, i) => anime(720 + i)), anime(799, [16, 18]), media(798, [10759])],
    }
    const discover = vi.fn<Discover>(async () => page([anime(900)]))
    const row: ForYouRow = { kind: 'genre', key: 'k', title: 't', lane: 'anime', concepts: [10759] }
    const out = ids((await buildRow(row, 1, profile, deps(recs, { discover }))).items)

    expect(out).toHaveLength(14)
    expect(out.every((id) => id >= 700 && id < 730)).toBe(true)
    // Outside the genre, or outside the lane, would make the heading false.
    expect(out).not.toContain(799)
    expect(out).not.toContain(798)
    expect(discover).not.toHaveBeenCalled()
  })

  it('tops a thin shelf up from the chart, holding anime to Animation in Japanese', async () => {
    const profile = buildProfile(library(), NOW)
    const discover = vi.fn<Discover>(async (type) => page(type === 'tv' ? [anime(900)] : []))
    const row: ForYouRow = { kind: 'genre', key: 'k', title: 't', lane: 'anime', concepts: [10759] }
    const out = ids((await buildRow(row, 1, profile, deps({ 1: [anime(700)] }, { discover }))).items)
    expect(out).toEqual([700, 900])
    expect(discover).toHaveBeenCalledWith('tv', { withGenres: '16,10759', language: 'ja' }, 1)
    expect(discover).toHaveBeenCalledWith('movie', { withGenres: '16,28', language: 'ja' }, 1)
  })

  it('maps a pair shelf to AND in both catalogues', () => {
    expect(shelfGenres([16, 10759], 'tv')).toBe('16,10759')
    expect(shelfGenres([16, 10759], 'movie')).toBe('16,28')
    expect(shelfGenres([27], 'tv')).toBeNull()
  })

  it('leaves out titles the user has', async () => {
    const profile = buildProfile(library(), NOW)
    const row: ForYouRow = { kind: 'genre', key: 'k', title: 't', lane: 'series', concepts: [18] }
    const discover = vi.fn<Discover>(async () => page([media(3), media(600)]))
    const result = await buildRow(row, 1, profile, deps({}, { discover }))
    expect(ids(result.items)).toEqual([600])
  })
})

describe('micro-genre rows', () => {
  it('asks for the keyword in the lane, with a lower vote floor than a shelf', async () => {
    const profile = buildProfile(library(), NOW)
    const discover = vi.fn<Discover>(async () => page([media(600), anime(601), media(602, [18], { type: 'movie' })]))
    const row: ForYouRow = { kind: 'theme', key: 'k', title: 't', lane: 'series', keyword: 42 }
    const result = await buildRow(row, 1, profile, deps({}, { discover }))
    expect(discover.mock.calls).toEqual([['tv', { withKeywords: '42', minVotes: 20 }, 1]])
    expect(ids(result.items)).toEqual([600])
  })

  it('holds an anime micro-genre to anime in both catalogues', async () => {
    const profile = buildProfile(library(), NOW)
    const discover = vi.fn<Discover>(async () => page([]))
    const row: ForYouRow = { kind: 'theme', key: 'k', title: 't', lane: 'anime', keyword: 42 }
    await buildRow(row, 1, profile, deps({}, { discover }))
    const anime = { withKeywords: '42', minVotes: 20, withGenres: '16', language: 'ja' }
    expect(discover).toHaveBeenCalledWith('tv', anime, 1)
    expect(discover).toHaveBeenCalledWith('movie', anime, 1)
  })
})

/* ── Rows that mix the lanes ─────────────────────────────────────────────── */

describe('discovery rows', () => {
  const acclaimed: ForYouRow = { kind: 'mixed', key: 'k', title: 't', flavour: 'acclaimed' }
  const great = { rating: 8.6, voteCount: 5000 }
  const series = (id: number) => media(id, [80], great)
  const film = (id: number) => media(id, [28], { ...great, type: 'movie' })
  const cartoon = (id: number) => anime(id, [16, 10759], great)
  /** Every favourite in wideLibrary recommends twelve of its own lane's acclaimed titles. */
  const recs: Record<number, MediaSummary[]> = {
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((id) => [id, Array.from({ length: 12 }, (_, i) => cartoon(3000 + i))])),
    ...Object.fromEntries([11, 12, 13, 14, 15].map((id) => [id, Array.from({ length: 12 }, (_, i) => series(1000 + i))])),
    ...Object.fromEntries([21, 22, 23, 24].map((id) => [id, Array.from({ length: 12 }, (_, i) => film(2000 + i))])),
  }

  it('draws on every lane the user has a taste in', () => {
    expect(mixedLanes(buildProfile(wideLibrary(), NOW))).toEqual(['series', 'films', 'anime'])
  })

  it('takes the lanes in turn, card by card, and rotates the lead each page', async () => {
    const profile = buildProfile(wideLibrary(), NOW)
    const first = (await buildRow(acclaimed, 1, profile, deps(recs))).items.map(laneOf)
    expect(first.slice(0, 6)).toEqual(['series', 'films', 'anime', 'series', 'films', 'anime'])
    expect(first).toHaveLength(MIXED_PER_PAGE)

    const second = (await buildRow(acclaimed, 2, profile, deps(recs))).items.map(laneOf)
    expect(second.slice(0, 3)).toEqual(['films', 'anime', 'series'])
  })

  it('keeps only what fits the flavour', async () => {
    const profile = buildProfile(wideLibrary(), NOW)
    const mixed = { ...recs, 11: [media(900, [80], { rating: 6.1, voteCount: 5000 }), ...recs[11]!] }
    const result = await buildRow(acclaimed, 1, profile, deps(mixed))
    expect(ids(result.items)).not.toContain(900)
  })

  it('holds films to a higher vote count than series and anime', async () => {
    const profile = buildProfile(wideLibrary(), NOW)
    // 1,000 votes is acclaim for a series, not for a film.
    const modest = { rating: 8.6, voteCount: 1000 }
    const result = await buildRow(acclaimed, 1, profile, deps({
      11: [media(900, [80], modest)],
      21: [media(901, [28], { ...modest, type: 'movie' })],
    }))
    expect(ids(result.items)).toContain(900)
    expect(ids(result.items)).not.toContain(901)
  })

  it('tops a lane its favourites say too little for up from the chart, flavour and all', async () => {
    const profile = buildProfile(wideLibrary(), NOW)
    const discover = vi.fn<Discover>(async () => page([]))
    const gems: ForYouRow = { kind: 'mixed', key: 'k', title: 't', flavour: 'gems' }
    await buildRow(gems, 1, profile, deps({}, { discover }))
    const films = discover.mock.calls.find((c) => c[0] === 'movie' && !c[1].language)
    expect(films?.[1]).toMatchObject({ minVotes: 50, maxVotes: 700, minRating: 7.4, sortBy: 'vote_average.desc' })
    const series = discover.mock.calls.find((c) => c[0] === 'tv' && !c[1].language)
    expect(series?.[1]).toMatchObject({ minVotes: 20, maxVotes: 250 })
    // Romance is avoided, so it is kept out of the film chart.
    expect(films?.[1]).toMatchObject({ withoutGenres: '10749' })
  })

  it('means the last year by "new", asked and checked', async () => {
    const profile = buildProfile(wideLibrary(), NOW)
    const discover = vi.fn<Discover>(async () => page([]))
    const fresh = new Date(NOW - 30 * DAY).toISOString().slice(0, 10)
    const stale = new Date(NOW - 400 * DAY).toISOString().slice(0, 10)
    const row: ForYouRow = { kind: 'mixed', key: 'k', title: 't', flavour: 'new' }
    const result = await buildRow(row, 1, profile, deps({
      11: [media(900, [80], { releaseDate: fresh }), media(901, [80], { releaseDate: stale }), media(902, [80])],
    }, { discover }), NOW)
    expect(ids(result.items)).toEqual([900])
    const since = new Date(NOW - 365 * DAY).toISOString().slice(0, 10)
    expect(discover).toHaveBeenCalled()
    expect(discover.mock.calls.every((c) => c[1].releasedAfter === since)).toBe(true)
  })
})

describe('More like your watchlist', () => {
  it('pools the saved titles, then takes the lanes in turn', async () => {
    const profile = buildProfile(library(), NOW)
    const row: ForYouRow = {
      kind: 'watchlist',
      key: 'k',
      title: 't',
      seeds: [{ tmdbId: 50, type: 'tv' }, { tmdbId: 51, type: 'movie' }],
    }
    const result = await buildRow(row, 1, profile, deps({
      50: [anime(600), anime(601), anime(602), media(603)],
      51: [media(604, [18], { type: 'movie' })],
    }))
    expect(result.items.map(laneOf)).toEqual(['series', 'films', 'anime', 'anime', 'anime'])
  })
})

/* ── Building blocks ─────────────────────────────────────────────────────── */

describe('blend', () => {
  it('keeps the requested share of the second list', () => {
    const merged = blend(Array(80).fill('tv'), Array(80).fill('film'), 0.25).slice(0, 40)
    const films = merged.filter((x) => x === 'film').length
    expect(films).toBeGreaterThanOrEqual(9)
    expect(films).toBeLessThanOrEqual(11)
  })

  it('uses up both lists', () => {
    expect(blend([1, 2], [3], 0.5).sort()).toEqual([1, 2, 3])
  })
})

describe('roundRobin', () => {
  it('takes one from each list in turn until all are spent', () => {
    expect(roundRobin([[1, 2, 3], [4], [5, 6]])).toEqual([1, 4, 5, 2, 6, 3])
    expect(roundRobin([])).toEqual([])
  })
})

describe('withExploration', () => {
  it("gives every sixth slot to a candidate from the edge of the user's taste", () => {
    const ranked = Array.from({ length: 12 }, (_, i) => ({
      item: media(i),
      score: 12 - i,
      // The six best fit the profile; the six worst do not.
      fit: i < 6 ? 1 : -0.2,
    }))
    const out = ids(withExploration(ranked))
    expect(out[EXPLORE_EVERY - 1]).toBe(6)
    expect(out.slice(0, EXPLORE_EVERY - 1)).toEqual([0, 1, 2, 3, 4])
    expect(new Set(out).size).toBe(12)
  })
})
