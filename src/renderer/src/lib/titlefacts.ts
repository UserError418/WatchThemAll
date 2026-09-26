/**
 * The few facts about a title that a list row shows and the library does not
 * store: its wide artwork, its year, its genres, how many seasons have aired.
 *
 * The Watched tab needs these for every row, and a watched record carries only
 * what was known when it was marked — a poster path and a title. Storing more
 * on the record would put artwork into the synced document and into every
 * device's merge for something that is only ever drawn. So the facts are
 * looked up from TMDB when a row first appears, and kept in `localStorage`
 * so the next visit draws them at once.
 *
 * Everything in this file is pure; the reactive store that fetches is
 * `titlefacts.svelte.ts`.
 */

import type { MediaDetail, MediaType } from '@shared/types'

export interface TitleFacts {
  backdropPath: string | null
  /** Four digits, or null when TMDB has no date. */
  year: string | null
  /** At most three, most prominent first, as TMDB lists them. */
  genres: string[]
  /** "Ended", "Returning Series", "Released"… as TMDB says it. */
  status: string
  /**
   * Seasons that have begun airing, for a series; null for a film.
   *
   * From the last aired episode rather than `number_of_seasons`, which counts
   * a season as soon as it is announced — a series renewed yesterday would
   * otherwise report a season nobody can have watched.
   */
  airedSeasons: number | null
  /** Minutes, for a film; null when unknown or for a series. */
  runtime: number | null
  /**
   * The synopsis, cut to a length two lines can show.
   *
   * A film has no season ribbon, so this is what fills its row instead.
   */
  overview: string
  /** When this was fetched, for expiry. */
  at: number
}

/**
 * How long facts are trusted before they are fetched again.
 *
 * A week, because what can change — a new season airing, a series ending —
 * changes on that scale, and what matters most, the artwork, hardly changes
 * at all. Stale facts are still drawn while the fresh ones load.
 */
export const FACTS_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** The most entries kept, oldest dropped first: a library, not the catalogue. */
export const FACTS_LIMIT = 2000

export const FACTS_STORAGE_KEY = 'wta.titleFacts.v1'

export function factsKey(type: MediaType, tmdbId: number): string {
  return `${type}:${tmdbId}`
}

export function factsFromDetail(detail: MediaDetail, now: number): TitleFacts {
  const year = detail.releaseDate?.slice(0, 4) ?? null
  return {
    backdropPath: detail.backdropPath,
    year: year && /^\d{4}$/.test(year) ? year : null,
    genres: detail.genres.slice(0, 3),
    status: detail.status,
    airedSeasons:
      detail.type === 'tv'
        ? (detail.lastEpisode?.season ?? (detail.seasonCount > 0 ? detail.seasonCount : null))
        : null,
    runtime: detail.type === 'movie' ? detail.runtime : null,
    overview: clip(detail.overview ?? '', OVERVIEW_LIMIT),
    at: now,
  }
}

/** Long enough for two lines of a wide row; the cache holds a library of these. */
const OVERVIEW_LIMIT = 320

/** Cut at a word boundary with an ellipsis, rather than mid-word. */
function clip(text: string, limit: number): string {
  const clean = text.trim()
  if (clean.length <= limit) return clean
  const cut = clean.slice(0, limit)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), limit - 40)).trimEnd()}…`
}

export function isStale(facts: TitleFacts, now: number): boolean {
  return now - facts.at > FACTS_TTL_MS
}

/**
 * Read the stored map, or an empty one.
 *
 * Anything unreadable is treated as absent rather than as an error: this is a
 * cache, and the worst a bad one can cost is a round of refetching.
 */
export function parseFacts(raw: string | null): Map<string, TitleFacts> {
  if (!raw) return new Map()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return new Map()
    const out = new Map<string, TitleFacts>()
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const facts = value as Partial<TitleFacts> | null
      if (
        facts &&
        typeof facts.at === 'number' &&
        Array.isArray(facts.genres) &&
        typeof facts.overview === 'string'
      ) {
        out.set(key, facts as TitleFacts)
      }
    }
    return out
  } catch {
    return new Map()
  }
}

/** Serialise, keeping the most recently fetched `limit` entries. */
export function serialiseFacts(facts: ReadonlyMap<string, TitleFacts>, limit = FACTS_LIMIT): string {
  const kept = [...facts.entries()].sort(([, a], [, b]) => b.at - a.at).slice(0, limit)
  return JSON.stringify(Object.fromEntries(kept))
}
