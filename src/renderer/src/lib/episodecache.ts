/**
 * Season episode lists, fetched once and kept.
 *
 * The Watchlist card shows the still for the episode you are on, which means a
 * season listing per hovered title. Three things make that affordable, and all
 * three have to hold:
 *
 * 1. **The caller gates on hover intent.** A pointer crossing the grid must
 *    start no requests at all, so nothing here is called until the card's
 *    260ms timer has already fired. That is the card's job, not this module's,
 *    but it is the reason this module can be as simple as it is.
 * 2. **One request per season, ever.** A resolved list is kept for the life of
 *    the session. Air dates and stills for a season already published do not
 *    change while the app is open, and the main process caches for ten minutes
 *    anyway — this is what stops the eleventh minute costing anything.
 * 3. **In-flight requests are shared.** Hovering away and back before the
 *    first response lands must not start a second one.
 *
 * Failure is remembered too, as an empty list. A title TMDB has forgotten
 * would otherwise be re-requested on every hover for the rest of the session,
 * which is the one case that could actually storm.
 */

import type { Episode } from '@shared/types'

const cache = new Map<string, Episode[]>()
const inFlight = new Map<string, Promise<Episode[]>>()

const keyOf = (tmdbId: number, season: number): string => `${tmdbId}:${season}`

/** What is already known, without starting anything. Null when unfetched. */
export function peekSeason(tmdbId: number, season: number): Episode[] | null {
  return cache.get(keyOf(tmdbId, season)) ?? null
}

/**
 * The episodes of one season.
 *
 * Never rejects: a failure resolves to an empty list, because every caller's
 * fallback for "no episodes" and for "the request failed" is the same — draw
 * the poster instead of a still — and a rejection would only give them a
 * second way to express it.
 */
export async function loadSeason(tmdbId: number, season: number): Promise<Episode[]> {
  if (!tmdbId || season < 1) return []

  const key = keyOf(tmdbId, season)
  const hit = cache.get(key)
  if (hit) return hit

  const pending = inFlight.get(key)
  if (pending) return pending

  const request = window.wta.tmdb
    .season(tmdbId, season)
    .then((result) => result?.episodes ?? [])
    .catch(() => [] as Episode[])
    .then((episodes) => {
      cache.set(key, episodes)
      inFlight.delete(key)
      return episodes
    })

  inFlight.set(key, request)
  return request
}

/** One episode out of an already-fetched season. */
export function findEpisode(
  episodes: readonly Episode[],
  season: number,
  episode: number,
): Episode | null {
  return episodes.find((e) => e.season === season && e.episode === episode) ?? null
}

/** Drop everything. Exists for the tests; nothing in the app calls it. */
export function clearEpisodeCache(): void {
  cache.clear()
  inFlight.clear()
}
