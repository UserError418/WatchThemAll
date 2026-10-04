/**
 * Where a series in the library picks up, from the season listings at hand.
 *
 * The rule is `pickUp` in `shared/progress.ts`; this feeds it from the
 * episode cache and fetches what it says is missing. The Watchlist card,
 * Continue Watching and a Browse card's ▶ all read it, so they name and play
 * the same episode the detail view's Resume does.
 */

import type { Episode, WatchlistEntry } from '@shared/types'
import { pickUp, type EpisodeRef, type PickUp } from '@shared/progress'
import { resumeAnchor } from '@shared/watchlistrank'
import { library } from './library.svelte'
import { loadSeason, peekSeason } from './episodecache'

/**
 * Bumped whenever a listing lands, so whatever peeked at the cache reads it
 * again. The cache is a plain Map shared with code that needs no reactivity;
 * one counter here is cheaper than making every entry in it a proxy.
 */
const listings = $state({ revision: 0 })

/** A season's listing if it has been fetched this session, reactively. */
export function peekListing(tmdbId: number, season: number): readonly Episode[] | null {
  void listings.revision
  return peekSeason(tmdbId, season)
}

/** Fetch a season's listing (once per session), and tell every reader it is in. */
export async function loadListing(tmdbId: number, season: number): Promise<void> {
  if (peekSeason(tmdbId, season) !== null) return
  await loadSeason(tmdbId, season)
  listings.revision += 1
}

/** Where this series picks up with the listings fetched so far; see `PickUp.need`. */
export function seriesPickUp(entry: WatchlistEntry, seasonCount: number | null = null): PickUp {
  const anchor = resumeAnchor(entry)
  return pickUp({
    anchor,
    anchorSeason: peekListing(entry.tmdbId, anchor.season),
    nextSeason: peekListing(entry.tmdbId, anchor.season + 1),
    seasonCount,
    isWatched: (season, episode) => library.isWatched(entry, season, episode),
  })
}

/**
 * Fetch what the answer still needs and return it settled: at most two
 * listings, the anchor's season and, at its end, the next. Nothing is
 * fetched for a series whose answer needs no listing.
 */
export async function settlePickUp(entry: WatchlistEntry): Promise<EpisodeRef> {
  let answer = seriesPickUp(entry)
  for (let fetched = 0; answer.need !== null && fetched < 2; fetched++) {
    await loadListing(entry.tmdbId, answer.need)
    answer = seriesPickUp(entry)
  }
  return answer.target
}
