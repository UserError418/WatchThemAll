import { describe, expect, it } from 'vitest'
import {
  avoidedConcepts,
  centred,
  conceptAffinity,
  conceptOf,
  engagementByTitle,
  genresFor,
  investment,
  IMPLICIT,
  IMPLICIT_CAP,
  MIN_PAIR_TITLES,
  ownedTitles,
  ratingScale,
  SCALE_PRIOR,
  titleAffinity,
  titleVerdicts,
  type TasteStore,
} from './taste'
import type {
  HistoryEntry,
  MediaType,
  RatingValue,
  Synced,
  TitleRating,
  WatchedEntry,
  WatchlistEntry,
} from '@shared/types'
import { stamp } from '@shared/store/core'
import { legacyRatingOf } from '@shared/rating'

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const NOW = Date.UTC(2026, 8, 25)
const DAY = 86_400_000

function store(over: Partial<TasteStore> = {}): TasteStore {
  return { ratings: [], watched: [], watchlist: [], history: [], trackers: [], ...over }
}

function rated(
  tmdbId: number,
  value: RatingValue,
  opts: { season?: number | null; coarse?: boolean; type?: MediaType; genreIds?: number[] } = {},
): Synced<TitleRating> {
  const season = opts.season ?? null
  const type = opts.type ?? 'tv'
  return stamp({
    key: season === null ? `${type}:${tmdbId}` : `${type}:${tmdbId}:s${season}`,
    tmdbId,
    type,
    season,
    value,
    coarse: opts.coarse ?? false,
    rating: legacyRatingOf(value),
    genreIds: opts.genreIds ?? [18],
    at: 0,
  })
}

function watched(
  tmdbId: number,
  opts: { season?: number | null; type?: MediaType; source?: 'user' | 'mal'; addedAt?: number; genreIds?: number[] } = {},
): Synced<WatchedEntry> {
  return stamp({
    id: `s${tmdbId}-${opts.season ?? 'all'}`,
    tmdbId,
    type: opts.type ?? 'tv',
    season: opts.season ?? null,
    title: `title ${tmdbId}`,
    posterPath: null,
    imdbId: null,
    genreIds: opts.genreIds ?? [18],
    addedAt: opts.addedAt ?? 0,
    rating: 0,
    source: opts.source ?? 'user',
    malId: null,
  })
}

function saved(tmdbId: number, marks: Record<string, number> = {}): Synced<WatchlistEntry> {
  return stamp({
    id: `w${tmdbId}`,
    tmdbId,
    type: 'tv',
    title: `title ${tmdbId}`,
    posterPath: null,
    imdbId: null,
    lastSeason: 1,
    lastEpisode: 1,
    watchedEpisodes: [],
    episodeMarks: Object.fromEntries(Object.entries(marks).map(([k, at]) => [k, { watched: true, at }])),
    genreIds: [18],
    episodeCount: null,
    rating: 0,
    addedAt: 0,
    providerId: null,
  })
}

function played(tmdbId: number, minutes: number, watchedAt: number, type: MediaType = 'tv'): Synced<HistoryEntry> {
  return stamp({
    id: `h${tmdbId}-${watchedAt}`,
    tmdbId,
    type,
    title: `title ${tmdbId}`,
    posterPath: null,
    season: 1,
    episode: 1,
    watchedAt,
    playedMs: minutes * 60_000,
  })
}

function scoreOf(s: TasteStore, tmdbId: number, type: MediaType = 'tv'): number | undefined {
  return titleAffinity(s, NOW).find((t) => t.tmdbId === tmdbId && t.type === type)?.score
}

/* ── Verdicts ────────────────────────────────────────────────────────────── */

describe('titleVerdicts', () => {
  it('prefers a rating chosen on the scale over converted thumbs for the same title', () => {
    const v = titleVerdicts([
      rated(1, 8, { coarse: true }),
      rated(1, 6, { season: 3 }),
    ])
    expect(v.get('tv:1')).toEqual({ value: 6, coarse: false })
  })

  it("prefers the user's whole-title rating over a mean of the seasons", () => {
    const v = titleVerdicts([rated(1, 9), rated(1, 5, { season: 1 }), rated(1, 5, { season: 2 })])
    expect(v.get('tv:1')?.value).toBe(9)
  })

  it('averages the seasons when there is no whole-title rating', () => {
    const v = titleVerdicts([rated(1, 9, { season: 1 }), rated(1, 6, { season: 2 })])
    expect(v.get('tv:1')?.value).toBe(7.5)
  })

  it('still reads a record an old build wrote, as a converted thumb', () => {
    const legacy = { ...rated(1, 8), value: undefined, rating: 'dislike' } as unknown as TitleRating
    expect(titleVerdicts([legacy]).get('tv:1')).toEqual({ value: 4, coarse: true })
  })

  it('keeps a film and a series with the same TMDB number apart', () => {
    const v = titleVerdicts([rated(7, 9, { type: 'movie' }), rated(7, 3)])
    expect(v.get('movie:7')?.value).toBe(9)
    expect(v.get('tv:7')?.value).toBe(3)
  })
})

/* ── The user's scale ────────────────────────────────────────────────────── */

describe('ratingScale', () => {
  it('is the prior for someone who has rated nothing', () => {
    expect(ratingScale(new Map())).toEqual({ mean: SCALE_PRIOR.mean, spread: SCALE_PRIOR.spread })
  })

  it('moves towards the user with every rating, without three ratings defining it', () => {
    const three = titleVerdicts([rated(1, 9), rated(2, 9), rated(3, 9)])
    const fifty = titleVerdicts(Array.from({ length: 50 }, (_, i) => rated(i + 1, 9)))
    const few = ratingScale(three).mean
    const many = ratingScale(fifty).mean
    expect(few).toBeGreaterThan(SCALE_PRIOR.mean)
    expect(few).toBeLessThan(8)
    expect(many).toBeGreaterThan(8.7)
  })

  it('caps how far one outlier can count', () => {
    expect(centred(1, { mean: 9, spread: 0.5 })).toBe(-2.5)
  })
})

/* ── Engagement ──────────────────────────────────────────────────────────── */

describe('engagementByTitle', () => {
  it('adds up hours per title and type', () => {
    const e = engagementByTitle(store({
      history: [played(1, 30, NOW), played(1, 90, NOW), played(1, 60, NOW, 'movie')],
    }))
    expect(e.get('tv:1')?.hours).toBe(2)
    expect(e.get('movie:1')?.hours).toBe(1)
  })

  it("does not date a watch by an import's addedAt", () => {
    const e = engagementByTitle(store({
      watched: [watched(1, { source: 'mal', addedAt: NOW }), watched(2, { source: 'user', addedAt: NOW })],
    }))
    expect(e.get('tv:1')?.lastActive).toBe(0)
    expect(e.get('tv:2')?.lastActive).toBe(NOW)
  })

  it('counts seasons and ticked-off episodes', () => {
    const e = engagementByTitle(store({
      watched: [watched(1, { season: 1 }), watched(1, { season: 2 })],
      watchlist: [saved(1, { '3:1': NOW, '3:2': NOW })],
    }))
    expect(e.get('tv:1')).toMatchObject({ seasons: 2, episodes: 2, onWatchlist: true, lastActive: NOW })
  })

  it('counts the ticks on an unlisted entry, but not as the title being on the watchlist', () => {
    const e = engagementByTitle(store({
      watchlist: [{ ...saved(1, { '1:1': NOW, '1:2': NOW }), listed: false }],
    }))
    expect(e.get('tv:1')).toMatchObject({ episodes: 2, onWatchlist: false, lastActive: NOW })
  })
})

describe('investment', () => {
  const base = { seasons: 0, hours: 0, episodes: 0, onWatchlist: false, tracked: false, lastActive: 0 }

  it('grows with watching, with diminishing returns, and is capped', () => {
    const one = investment({ ...base, hours: 10 })
    const four = investment({ ...base, hours: 40 })
    expect(four).toBeGreaterThan(one)
    expect(four).toBeLessThan(one * 4)
    expect(investment({ ...base, hours: 10_000, seasons: 40 })).toBe(3)
  })

  it('does not count an episode twice when it was both played and ticked off', () => {
    const played = investment({ ...base, hours: 6.6 })
    const both = investment({ ...base, hours: 6.6, episodes: 10 })
    expect(both).toBe(played)
  })
})

/* ── Affinity ────────────────────────────────────────────────────────────── */

describe('titleAffinity', () => {
  it('reads the same number differently for a generous and a harsh rater', () => {
    // The whole reason for centring: a 7 is a disappointment from someone who
    // gives everything a 9, and praise from someone who gives everything a 4.
    const filler = (value: RatingValue) => Array.from({ length: 20 }, (_, i) => rated(100 + i, value))
    const generous = store({ ratings: [...filler(9), rated(1, 7)] })
    const harsh = store({ ratings: [...filler(4), rated(1, 7)] })
    expect(scoreOf(generous, 1)).toBeLessThan(0)
    expect(scoreOf(harsh, 1)).toBeGreaterThan(0)
  })

  it('ranks a 10 above a 9 above an 8 — the scale reaches the profile', () => {
    const s = store({ ratings: [rated(1, 8), rated(2, 10), rated(3, 9), rated(4, 5), rated(5, 6)] })
    const order = titleAffinity(s, NOW).map((t) => t.tmdbId)
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(3))
    expect(order.indexOf(3)).toBeLessThan(order.indexOf(1))
  })

  it('amplifies a liked title the user put hours into', () => {
    const ratings = [rated(1, 9), rated(2, 9), rated(3, 5), rated(4, 6)]
    const s = store({ ratings, history: [played(1, 600, NOW)] })
    expect(scoreOf(s, 1)).toBeGreaterThan(scoreOf(s, 2)!)
  })

  it('softens a dislike of something the user sat through', () => {
    const ratings = [rated(1, 3), rated(2, 3), rated(3, 9), rated(4, 8)]
    const s = store({ ratings, history: [played(1, 600, NOW)] })
    expect(scoreOf(s, 1)).toBeLessThan(0)
    expect(scoreOf(s, 1)).toBeGreaterThan(scoreOf(s, 2)!)
  })

  it('never lets behaviour alone outrank a strong explicit rating', () => {
    const s = store({
      ratings: [rated(1, 10), rated(2, 5), rated(3, 6), rated(4, 7)],
      watched: Array.from({ length: 20 }, (_, i) => watched(9, { season: i + 1 })),
      history: [played(9, 6000, NOW)],
      trackers: [stamp({ id: 't9', tmdbId: 9, title: 'x', posterPath: null, status: '', nextEpisode: null, lastNotified: null, addedAt: 0, lastChecked: 0 })],
    })
    expect(scoreOf(s, 9)).toBeLessThanOrEqual(IMPLICIT_CAP)
    expect(scoreOf(s, 1)).toBeGreaterThan(scoreOf(s, 9)!)
  })

  it('counts a started-and-abandoned title against its kind', () => {
    const s = store({ history: [played(1, 10, NOW - 30 * DAY)] })
    expect(scoreOf(s, 1)).toBe(IMPLICIT.abandoned)
  })

  it('does not call a failed source, or a show started this week, abandoned', () => {
    const s = store({ history: [played(1, 1, NOW - 30 * DAY), played(2, 10, NOW - 2 * DAY)] })
    expect(scoreOf(s, 1)).toBeGreaterThanOrEqual(0)
    expect(scoreOf(s, 2)).toBeGreaterThan(0)
  })

  it('produces a different ordering from a different history', () => {
    // The acceptance test from CYCLE-3 §6: not that the function returns
    // something, but that what it returns follows the history.
    const ratings = [rated(1, 8), rated(2, 8), rated(3, 5)]
    const a = titleAffinity(store({ ratings, history: [played(1, 900, NOW)] }), NOW)
    const b = titleAffinity(store({ ratings, history: [played(2, 900, NOW)] }), NOW)
    expect(a[0]?.tmdbId).toBe(1)
    expect(b[0]?.tmdbId).toBe(2)
  })
})

/* ── Genres ──────────────────────────────────────────────────────────────── */

describe('genre concepts', () => {
  it("folds a film's Action and a series' Action & Adventure into one concept", () => {
    expect(conceptOf(28)).toBe(10759)
    expect(conceptOf(12)).toBe(10759)
    expect(conceptOf(10759)).toBe(10759)
    expect(conceptOf(18)).toBe(18)
  })

  it('asks each catalogue in its own genre ids, or not at all', () => {
    expect(genresFor(10765, 'movie')).toEqual([878, 14])
    expect(genresFor(10765, 'tv')).toEqual([10765])
    expect(genresFor(27, 'tv')).toBeNull() // Horror: films only
    expect(genresFor(10764, 'movie')).toBeNull() // Reality: series only
  })
})

describe('conceptAffinity', () => {
  it('only proposes a pair once enough liked titles share it', () => {
    const titles = (n: number) =>
      titleAffinity(store({
        ratings: [
          ...Array.from({ length: n }, (_, i) => rated(i + 1, 9, { genreIds: [16, 10759] })),
          rated(900, 4, { genreIds: [18] }),
        ],
      }), NOW)
    expect(conceptAffinity(titles(MIN_PAIR_TITLES - 1)).pairs).toEqual([])
    expect(conceptAffinity(titles(MIN_PAIR_TITLES)).pairs[0]?.concepts).toEqual([16, 10759])
  })

  it('names a genre the user has clearly turned against', () => {
    const t = titleAffinity(store({
      ratings: [
        ...Array.from({ length: 4 }, (_, i) => rated(i + 1, 2, { genreIds: [10749] })),
        ...Array.from({ length: 4 }, (_, i) => rated(i + 10, 9, { genreIds: [16] })),
      ],
    }), NOW)
    expect(avoidedConcepts(conceptAffinity(t).singles)).toEqual([10749])
  })
})

describe('ownedTitles', () => {
  it('covers every collection, keyed by type', () => {
    const owned = ownedTitles(store({
      ratings: [rated(1, 8)],
      watched: [watched(2)],
      watchlist: [saved(3)],
      history: [played(4, 5, NOW, 'movie')],
    }))
    expect([...owned].sort()).toEqual(['movie:4', 'tv:1', 'tv:2', 'tv:3'])
  })
})
