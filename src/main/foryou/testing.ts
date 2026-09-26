/**
 * Fixtures for the `foryou/` tests: small libraries, TMDB results, and a fake
 * network. Imported by tests only.
 */

import { vi } from 'vitest'
import type { HistoryEntry, MediaSummary, MediaType, RatingValue, Synced, TitleRating, WatchedEntry, WatchlistEntry } from '@shared/types'
import type { Paged } from '@shared/ipc'
import { stamp } from '@shared/store/core'
import { legacyRatingOf } from '@shared/rating'
import type { TasteStore } from '../taste'
import type { ForYouDeps, ForYouNetwork } from './deps'

export const NOW = Date.UTC(2026, 8, 25)
export const DAY = 86_400_000

export const GENRE_NAMES: Record<number, string> = {
  16: 'Animation',
  18: 'Drama',
  35: 'Comedy',
  80: 'Crime',
  9648: 'Mystery',
  10759: 'Action & Adventure',
  10765: 'Sci-Fi & Fantasy',
  10749: 'Romance',
}
export const genreName = (c: number): string | undefined => GENRE_NAMES[c]

export function store(over: Partial<TasteStore> = {}): TasteStore {
  return { ratings: [], watched: [], watchlist: [], history: [], trackers: [], ...over }
}

export function rated(
  tmdbId: number,
  value: RatingValue,
  genreIds: number[] = [18],
  opts: { coarse?: boolean; type?: MediaType } = {},
): Synced<TitleRating> {
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

/**
 * A title seen, so it has a name and counts as watched. From a MyAnimeList
 * import by default, which makes an animated title anime without asking TMDB.
 */
export function seen(
  tmdbId: number,
  genreIds: number[] = [18],
  type: MediaType = 'tv',
  source: 'mal' | 'user' = 'mal',
): Synced<WatchedEntry> {
  return stamp({
    id: `s${type}${tmdbId}`,
    tmdbId,
    type,
    season: null,
    title: `Show ${tmdbId}`,
    posterPath: null,
    imdbId: null,
    genreIds,
    addedAt: 0,
    rating: 0,
    source,
    malId: null,
  })
}

export function played(tmdbId: number, minutes: number, watchedAt: number): Synced<HistoryEntry> {
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

export function saved(tmdbId: number, genreIds: number[] = [18], addedAt = 0, type: MediaType = 'tv'): Synced<WatchlistEntry> {
  return stamp({
    id: `w${tmdbId}`,
    tmdbId,
    type,
    title: `Saved ${tmdbId}`,
    posterPath: null,
    imdbId: null,
    lastSeason: 1,
    lastEpisode: 1,
    watchedEpisodes: [],
    episodeMarks: {},
    genreIds,
    episodeCount: null,
    rating: 0,
    addedAt,
    providerId: null,
  })
}

/** A TMDB result: a live-action series in Drama unless told otherwise. */
export function media(tmdbId: number, genreIds: number[] = [18], over: Partial<MediaSummary> = {}): MediaSummary {
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
    originalLanguage: 'en',
    ...over,
  }
}

/** A TMDB result that is anime: Animation, in Japanese. */
export function anime(tmdbId: number, genreIds: number[] = [16, 10759], over: Partial<MediaSummary> = {}): MediaSummary {
  return media(tmdbId, genreIds, { originalLanguage: 'ja', ...over })
}

export const page = (items: MediaSummary[], totalPages = 1): Paged<MediaSummary> => ({ items, page: 1, totalPages })

/** A fake network: recommendations from a table, everything else empty unless given. */
export function deps(
  recs: Record<number, MediaSummary[]>,
  over: Partial<ForYouDeps> = {},
): ForYouDeps {
  return {
    recommendations: vi.fn(async (id: number) => page(recs[id] ?? [])),
    discover: vi.fn(async () => page([])),
    keywords: vi.fn(async () => []),
    originalLanguage: vi.fn(async () => null),
    ...over,
  }
}

export function network(recs: Record<number, MediaSummary[]>, over: Partial<ForYouNetwork> = {}): ForYouNetwork {
  return { ...deps(recs, over), genres: async () => [], ...over }
}

/**
 * A library across the three lanes, each named and watched:
 * - anime: 1, 2, 5 (animated and from MyAnimeList),
 * - series: 3, 4 liked; 6, 7 disliked (romance),
 * - films: none.
 */
export function library(): TasteStore {
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
    watched: [1, 2, 3, 4, 5, 6, 7].map((id) => seen(id, id === 1 || id === 2 || id === 5 ? [16] : [18])),
  })
}

/**
 * A library with enough of every lane to stand on its own (`MIN_LANE_TITLES`),
 * shaped like the real one the lanes were tuned on: mostly anime.
 * - anime: 1–8, from MyAnimeList,
 * - series: 11–15,
 * - films: 21–24,
 * - disliked romance films: 31–33.
 */
export function wideLibrary(): TasteStore {
  const anime: Array<[number, number[]]> = [
    [1, [16, 10759]], [2, [16, 10765]], [3, [16, 18]], [4, [16, 35]],
    [5, [16, 10759, 10765]], [6, [16, 9648]], [7, [16, 18, 10765]], [8, [16, 10759, 35]],
  ]
  const series: Array<[number, number[]]> = [[11, [80, 18]], [12, [9648, 18]], [13, [35]], [14, [10765, 18]], [15, [80]]]
  const films: Array<[number, number[]]> = [[21, [28, 878]], [22, [53]], [23, [35, 18]], [24, [878]]]
  const romance = [31, 32, 33]
  return store({
    ratings: [
      ...anime.map(([id, g]) => rated(id, id % 2 ? 10 : 9, g)),
      ...series.map(([id, g]) => rated(id, 9, g)),
      ...films.map(([id, g]) => rated(id, 9, g, { type: 'movie' })),
      ...romance.map((id) => rated(id, 2, [10749], { type: 'movie' })),
    ],
    watched: [
      ...anime.map(([id, g]) => seen(id, g)),
      ...series.map(([id, g]) => seen(id, g, 'tv', 'user')),
      ...films.map(([id, g]) => seen(id, g, 'movie', 'user')),
      ...romance.map((id) => seen(id, [10749], 'movie', 'user')),
    ],
  })
}
