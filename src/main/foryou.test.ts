import { describe, expect, it, vi } from 'vitest'
import {
  becauseSeeds,
  becauseVerb,
  blend,
  buildProfile,
  buildRow,
  genreShelves,
  isForYouRow,
  planRows,
  shelfGenres,
  topPickSeeds,
  withExploration,
  forYouPlan,
  EXPLORE_EVERY,
  TOP_PICKS_PER_PAGE,
  type ForYouDeps,
} from './foryou'
import type { TasteStore } from './taste'
import type { HistoryEntry, MediaSummary, MediaType, RatingValue, Synced, TitleRating, WatchedEntry } from '@shared/types'
import type { ForYouRow, Paged } from '@shared/ipc'
import { stamp } from '@shared/store/core'
import { legacyRatingOf } from '@shared/rating'

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const NOW = Date.UTC(2026, 8, 25)
const DAY = 86_400_000

const GENRE_NAMES: Record<number, string> = {
  16: 'Animation',
  18: 'Drama',
  35: 'Comedy',
  80: 'Crime',
  10759: 'Action & Adventure',
  10765: 'Sci-Fi & Fantasy',
  10749: 'Romance',
}
const name = (c: number): string | undefined => GENRE_NAMES[c]

function store(over: Partial<TasteStore> = {}): TasteStore {
  return { ratings: [], watched: [], watchlist: [], history: [], trackers: [], ...over }
}

function rated(tmdbId: number, value: RatingValue, genreIds: number[] = [18], opts: { coarse?: boolean; type?: MediaType } = {}): Synced<TitleRating> {
  const type = opts.type ?? 'tv'
  return stamp({
    key: `${type}:${tmdbId}`,
    tmdbId,
    type,
    season: null,
    value,
    coarse: opts.coarse ?? false,
    rating: legacyRatingOf(value),
    genreIds,
    at: 0,
  })
}

/** A title seen, so it has a name and counts as watched. */
function seen(tmdbId: number, genreIds: number[] = [18], type: MediaType = 'tv'): Synced<WatchedEntry> {
  return stamp({
    id: `s${tmdbId}`,
    tmdbId,
    type,
    season: null,
    title: `Show ${tmdbId}`,
    posterPath: null,
    imdbId: null,
    genreIds,
    addedAt: 0,
    rating: 0,
    source: 'mal',
    malId: null,
  })
}

function played(tmdbId: number, minutes: number, watchedAt: number): Synced<HistoryEntry> {
  return stamp({
    id: `h${tmdbId}-${watchedAt}`,
    tmdbId,
    type: 'tv',
    title: `Show ${tmdbId}`,
    posterPath: null,
    season: 1,
    episode: 1,
    watchedAt,
    playedMs: minutes * 60_000,
  })
}

function media(tmdbId: number, genreIds: number[] = [18], over: Partial<MediaSummary> = {}): MediaSummary {
  return {
    tmdbId,
    type: 'tv',
    title: `rec ${tmdbId}`,
    posterPath: null,
    backdropPath: null,
    overview: '',
    rating: 7,
    voteCount: 500,
    releaseDate: null,
    genreIds,
    ...over,
  }
}

const page = (items: MediaSummary[], totalPages = 1): Paged<MediaSummary> => ({ items, page: 1, totalPages })

function deps(recs: Record<number, MediaSummary[]>, discover?: ForYouDeps['discover']): ForYouDeps {
  return {
    recommendations: vi.fn(async (id: number) => page(recs[id] ?? [])),
    discover: discover ?? vi.fn(async () => page([])),
  }
}

/** A library of liked, named titles with a couple of clear dislikes. */
function library(): TasteStore {
  return store({
    ratings: [
      rated(1, 10, [16, 10759]),
      rated(2, 9, [16, 10765]),
      rated(3, 9, [80, 18]),
      rated(4, 8, [35]),
      rated(5, 8, [16, 10759]),
      rated(6, 3, [10749, 18]),
      rated(7, 2, [10749]),
    ],
    watched: [1, 2, 3, 4, 5, 6, 7].map((id) => seen(id)),
  })
}

/* ── Seeds ───────────────────────────────────────────────────────────────── */

describe('topPickSeeds', () => {
  it('takes the strongest titles, but not several of the same kind first', () => {
    const profile = buildProfile(store({
      ratings: [
        rated(1, 10, [16, 10759]),
        rated(2, 10, [16, 10759]),
        rated(3, 10, [16, 10759]),
        rated(4, 9, [80, 18]),
        rated(5, 4, [35]),
      ],
    }), NOW)
    const ids = topPickSeeds(profile, 2).map((s) => s.tmdbId)
    expect(ids).toContain(4)
  })

  it('is empty for a library with nothing positive in it', () => {
    expect(topPickSeeds(buildProfile(store(), NOW))).toEqual([])
  })
})

describe('becauseSeeds', () => {
  it('is stable for one session seed and rotates across sessions', () => {
    const profile = buildProfile(library(), NOW)
    expect(becauseSeeds(profile, 42, NOW)).toEqual(becauseSeeds(profile, 42, NOW))

    const distinct = new Set(
      Array.from({ length: 30 }, (_, s) => becauseSeeds(profile, s, NOW).map((t) => t.tmdbId).join()),
    )
    expect(distinct.size).toBeGreaterThan(3)
  })

  it('favours what the user watched recently', () => {
    // Two equal favourites; one was played yesterday, one a year ago.
    const s = store({
      ratings: [rated(1, 9, [16]), rated(2, 9, [80]), rated(3, 5, [35]), rated(4, 6, [35])],
      watched: [seen(1), seen(2)],
      history: [played(1, 60, NOW - DAY), played(2, 60, NOW - 365 * DAY)],
    })
    const profile = buildProfile(s, NOW)
    let recent = 0
    for (let seed = 0; seed < 200; seed += 1) {
      if (becauseSeeds(profile, seed, NOW, 1)[0]?.tmdbId === 1) recent += 1
    }
    expect(recent).toBeGreaterThan(110)
  })

  it('never claims "because you watched" about something only saved', () => {
    const s = store({
      watchlist: [stamp({
        id: 'w1', tmdbId: 1, type: 'tv' as const, title: 'Saved', posterPath: null, imdbId: null,
        lastSeason: 1, lastEpisode: 1, watchedEpisodes: [], episodeMarks: {}, genreIds: [18],
        episodeCount: null, rating: 0, addedAt: 0, providerId: null,
      })],
    })
    expect(becauseSeeds(buildProfile(s, NOW), 1, NOW)).toEqual([])
  })
})

describe('becauseVerb', () => {
  const at = (value: number, coarse: boolean) =>
    ({ verdict: { value, coarse } }) as Parameters<typeof becauseVerb>[0]

  it('says loved only for a 9 or 10 actually chosen on the scale', () => {
    expect(becauseVerb(at(10, false))).toBe('loved')
    expect(becauseVerb(at(8, true))).toBe('liked')
    expect(becauseVerb(at(8, false))).toBe('liked')
    expect(becauseVerb(at(7, false))).toBe('watched')
    expect(becauseVerb({ verdict: null } as Parameters<typeof becauseVerb>[0])).toBe('watched')
  })
})

/* ── Shelves and the plan ────────────────────────────────────────────────── */

describe('genreShelves', () => {
  it('does not let one genre take over every shelf', () => {
    const s = store({
      ratings: [
        ...Array.from({ length: 6 }, (_, i) => rated(i + 1, 10, [16, 10759])),
        ...Array.from({ length: 6 }, (_, i) => rated(i + 20, 10, [16, 10765])),
        ...Array.from({ length: 6 }, (_, i) => rated(i + 40, 10, [16, 35])),
        ...Array.from({ length: 3 }, (_, i) => rated(i + 60, 8, [80])),
        rated(99, 3, [10749]),
      ],
    })
    const shelves = genreShelves(buildProfile(s, NOW))
    const animationShelves = shelves.filter((sh) => sh.concepts.includes(16))
    expect(animationShelves.length).toBeLessThanOrEqual(2)
    expect(shelves.filter((sh) => sh.concepts.length > 1).length).toBeLessThanOrEqual(2)
  })
})

describe('planRows', () => {
  it('plans nothing for an empty library', () => {
    expect(planRows(buildProfile(store(), NOW), 1, name, NOW)).toEqual([])
  })

  it('leads with Top picks, then the Because rows, then genre shelves', () => {
    const rows = planRows(buildProfile(library(), NOW), 7, name, NOW)
    const kinds = rows.map((r) => r.kind)
    expect(kinds[0]).toBe('topPicks')
    expect(kinds.filter((k) => k === 'because')).toHaveLength(3)
    expect(kinds.lastIndexOf('because')).toBeLessThan(kinds.indexOf('genre'))
    for (const row of rows) expect(isForYouRow(row)).toBe(true)
  })

  it('names the reason in the heading', () => {
    const rows = planRows(buildProfile(library(), NOW), 7, name, NOW)
    const because = rows.filter((r) => r.kind === 'because').map((r) => r.title)
    for (const title of because) expect(title).toMatch(/^Because you (loved|liked|watched) Show \d+$/)
  })

  it('drops a shelf it cannot name rather than heading it with a number', () => {
    const rows = planRows(buildProfile(library(), NOW), 7, () => undefined, NOW)
    expect(rows.some((r) => r.kind === 'genre')).toBe(false)
  })
})

describe('forYouPlan', () => {
  const genres = async () => [] as Array<{ id: number; name: string }>

  it('passes over a favourite TMDB has nothing to recommend for', async () => {
    // Enough fresh recommendations for every seed but title 1.
    const plenty = (base: number) => Array.from({ length: 10 }, (_, i) => media(base + i))
    const recs: Record<number, MediaSummary[]> = { 2: plenty(200), 3: plenty(300), 4: plenty(400), 5: plenty(500) }
    const net = { ...deps(recs), genres }
    for (let seed = 0; seed < 20; seed += 1) {
      const plan = await forYouPlan(library(), seed, net, NOW)
      const because = plan.rows.filter((r) => r.kind === 'because')
      expect(because).toHaveLength(3)
      expect(because.some((r) => r.kind === 'because' && r.seed.tmdbId === 1)).toBe(false)
    }
  })

  it('still plans Top picks and Because rows when genre names fail to load', async () => {
    const plenty = (base: number) => Array.from({ length: 10 }, (_, i) => media(base + i))
    const recs = Object.fromEntries([1, 2, 3, 4, 5].map((id) => [id, plenty(id * 100)]))
    const net = { ...deps(recs), genres: async () => { throw new Error('offline') } }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const plan = await forYouPlan(library(), 3, net, NOW)
    spy.mockRestore()
    expect(plan.rows.map((r) => r.kind)).toEqual(['topPicks', 'because', 'because', 'because'])
  })
})

describe('isForYouRow', () => {
  it('refuses rows main could not have planned', () => {
    expect(isForYouRow({ kind: 'topPicks', key: 'k', title: 't' })).toBe(true)
    expect(isForYouRow({ kind: 'because', key: 'k', title: 't', seed: { tmdbId: 1, type: 'tv' } })).toBe(true)
    expect(isForYouRow({ kind: 'because', key: 'k', title: 't', seed: { tmdbId: -1, type: 'tv' } })).toBe(false)
    expect(isForYouRow({ kind: 'because', key: 'k', title: 't', seed: { tmdbId: 1, type: 'person' } })).toBe(false)
    expect(isForYouRow({ kind: 'genre', key: 'k', title: 't', concepts: [1, 2, 3] })).toBe(false)
    expect(isForYouRow({ kind: 'url', key: 'k', title: 't' })).toBe(false)
    expect(isForYouRow(null)).toBe(false)
  })
})

/* ── Rows ────────────────────────────────────────────────────────────────── */

const TOP: ForYouRow = { kind: 'topPicks', key: 'for-you:top', title: 'Top picks for you' }

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
    const ids = (await buildRow(TOP, 1, profile, deps(recs))).items.map((m) => m.tmdbId)
    expect(ids.indexOf(101)).toBeLessThan(ids.indexOf(100) === -1 ? Infinity : ids.indexOf(100))
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
    const ids = (await buildRow(TOP, 1, profile, deps(recs))).items.map((m) => m.tmdbId)
    expect(ids).toEqual([101, 100])
  })

  it('never recommends what the user already has', async () => {
    const profile = buildProfile(library(), NOW)
    const result = await buildRow(TOP, 1, profile, deps({ 1: [media(2), media(3), media(300)] }))
    expect(result.items.map((m) => m.tmdbId)).toEqual([300])
  })

  it('treats a film and a series with the same number as different titles', async () => {
    const profile = buildProfile(library(), NOW)
    // tv:1 is owned; movie:1 is not.
    const result = await buildRow(TOP, 1, profile, deps({ 2: [media(1, [16], { type: 'movie' })] }))
    expect(result.items).toHaveLength(1)
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
    const a = (await buildRow(TOP, 1, likesAnimation, deps(recs))).items.map((m) => m.tmdbId)
    const b = (await buildRow(TOP, 1, likesCrime, deps(recs))).items.map((m) => m.tmdbId)
    expect(a[0]).toBe(101)
    expect(b[0]).toBe(100)
  })
})

describe('Because rows', () => {
  it("re-ranks one favourite's recommendations by the profile", async () => {
    const profile = buildProfile(library(), NOW)
    const row: ForYouRow = { kind: 'because', key: 'k', title: 't', seed: { tmdbId: 1, type: 'tv' } }
    // TMDB lists the romance first; the user avoids romance.
    const result = await buildRow(row, 1, profile, deps({ 1: [media(500, [10749]), media(501, [16, 10759])] }))
    expect(result.items[0]?.tmdbId).toBe(501)
  })
})

describe('genre shelves', () => {
  it("asks each catalogue in its own genres and excludes the user's avoided ones", async () => {
    const discover = vi.fn(async () => page([]))
    const profile = buildProfile(store({
      ratings: [
        ...Array.from({ length: 4 }, (_, i) => rated(i + 1, 9, [10765])),
        ...Array.from({ length: 4 }, (_, i) => rated(i + 10, 2, [10749])),
      ],
    }), NOW)
    const row: ForYouRow = { kind: 'genre', key: 'k', title: 't', concepts: [10765] }
    await buildRow(row, 1, profile, deps({}, discover))
    expect(discover).toHaveBeenCalledWith('tv', '10765', '', 1)
    expect(discover).toHaveBeenCalledWith('movie', '878|14', '10749', 1)
  })

  it("fills a shelf from the user's own favourites in that genre before the chart", async () => {
    const profile = buildProfile(library(), NOW)
    // Titles 1 and 5 are the liked Animation · Action & Adventure titles.
    const recs: Record<number, MediaSummary[]> = {
      1: Array.from({ length: 8 }, (_, i) => media(700 + i, [16, 10759])),
      5: [...Array.from({ length: 6 }, (_, i) => media(720 + i, [16, 10759])), media(799, [18])],
    }
    const discover = vi.fn(async () => page([media(900, [16, 10759])]))
    const row: ForYouRow = { kind: 'genre', key: 'k', title: 't', concepts: [16, 10759] }
    const ids = (await buildRow(row, 1, profile, deps(recs, discover))).items.map((m) => m.tmdbId)

    expect(ids.slice(0, 14).every((id) => id >= 700 && id < 730)).toBe(true)
    // A recommendation outside the shelf's genres would make the heading false.
    expect(ids).not.toContain(799)
    expect(discover).not.toHaveBeenCalled()
  })

  it('tops a thin shelf up from the chart', async () => {
    const profile = buildProfile(library(), NOW)
    const discover = vi.fn(async (type: MediaType) => page(type === 'tv' ? [media(900, [16, 10759])] : []))
    const row: ForYouRow = { kind: 'genre', key: 'k', title: 't', concepts: [16, 10759] }
    const ids = (await buildRow(row, 1, profile, deps({ 1: [media(700, [16, 10759])] }, discover))).items.map((m) => m.tmdbId)
    expect(ids).toEqual([700, 900])
  })

  it('maps a pair shelf to AND in both catalogues', () => {
    expect(shelfGenres([16, 10759], 'tv')).toBe('16,10759')
    expect(shelfGenres([16, 10759], 'movie')).toBe('16,28')
    expect(shelfGenres([27], 'tv')).toBeNull()
  })

  it('leaves out titles the user has', async () => {
    const profile = buildProfile(library(), NOW)
    const row: ForYouRow = { kind: 'genre', key: 'k', title: 't', concepts: [16] }
    const discover = vi.fn(async (type: MediaType) => page(type === 'tv' ? [media(1), media(600)] : []))
    const result = await buildRow(row, 1, profile, deps({}, discover))
    expect(result.items.map((m) => m.tmdbId)).toEqual([600])
  })
})

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

describe('withExploration', () => {
  it("gives every sixth slot to a candidate from the edge of the user's taste", () => {
    const ranked = Array.from({ length: 12 }, (_, i) => ({
      item: media(i),
      score: 12 - i,
      // The six best fit the profile; the six worst do not.
      fit: i < 6 ? 1 : -0.2,
    }))
    const out = withExploration(ranked).map((m) => m.tmdbId)
    expect(out[EXPLORE_EVERY - 1]).toBe(6)
    expect(out.slice(0, EXPLORE_EVERY - 1)).toEqual([0, 1, 2, 3, 4])
    expect(new Set(out).size).toBe(12)
  })
})
