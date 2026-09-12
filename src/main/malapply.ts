/**
 * Turning a reviewed MyAnimeList export into store entries.
 *
 * Split from `malimport.ts`, which is the parser and stays pure. This half has
 * to reach TMDB — a MAL entry is a title string, and everything the app does
 * needs a TMDB id — so the lookup is *injected* rather than imported. That is
 * what makes the assembly testable: the interesting logic here is which list
 * each title lands in, what happens when a title cannot be matched, and not
 * double-adding something already saved, none of which should require a network
 * to exercise.
 */

import type { MediaType, StoreShape, TitleRating, WatchedEntry, WatchlistEntry, ReleaseTracker } from '@shared/types'
import type { ImportTarget, MalEntry, MalStatus } from './malimport'
import { mediaTypeFor, ratingFromScore } from './malimport'
import { stamp } from '@shared/store/core'

/** What the user chose in the preview dialog. */
export interface ImportDecisions {
  /** Where each status group goes. `skip` drops the group. */
  targets: Record<MalStatus, ImportTarget>
  /** MAL ids the user unticked. Everything not listed is imported. */
  excludedMalIds: number[]
  /** Whether to seed like/dislike from MAL scores. */
  applyScores: boolean
}

/** Enough of a TMDB match to build an entry. Null when nothing matched. */
export interface ResolvedTitle {
  tmdbId: number
  imdbId: string | null
  title: string
  posterPath: string | null
  genreIds: number[]
}

export type Resolver = (title: string, type: MediaType) => Promise<ResolvedTitle | null>

export interface ImportSummary {
  watchlist: number
  watched: number
  releases: number
  ratings: number
  /** Selected, but TMDB had no match. Reported rather than silently dropped. */
  unmatched: string[]
  skipped: number
}

const newId = (): string => `mal-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`

/**
 * Apply an import to a store document, returning a new one.
 *
 * Pure apart from the injected resolver, and it never mutates `store` — the
 * caller writes the result in one go. Three hundred separate writes for a
 * three-hundred-title import would be three hundred disk flushes and three
 * hundred change events to the renderer.
 */
export async function applyMalImport(
  store: StoreShape,
  entries: MalEntry[],
  decisions: ImportDecisions,
  resolve: Resolver,
  onProgress?: (done: number, total: number) => void,
): Promise<{ store: StoreShape; summary: ImportSummary }> {
  const excluded = new Set(decisions.excludedMalIds)
  const selected = entries.filter(
    (e) => !excluded.has(e.malId) && decisions.targets[e.status] !== 'skip',
  )

  const summary: ImportSummary = {
    watchlist: 0,
    watched: 0,
    releases: 0,
    ratings: 0,
    unmatched: [],
    skipped: entries.length - selected.length,
  }

  const watchlist = [...store.watchlist]
  const watched = [...store.watched]
  const trackers = [...store.trackers]
  const ratings = [...store.ratings]

  const haveWatchlist = new Set(watchlist.map((w) => w.tmdbId))
  const haveWatched = new Set(watched.map((w) => w.tmdbId))
  const haveTracker = new Set(trackers.map((t) => t.tmdbId))
  const haveRating = new Set(ratings.map((r) => r.tmdbId))

  let done = 0
  for (const entry of selected) {
    const type = mediaTypeFor(entry.seriesType)
    const target = decisions.targets[entry.status]

    let match: ResolvedTitle | null
    try {
      match = await resolve(entry.title, type)
    } catch {
      // A single failed lookup must not abandon the other 300. It lands in
      // `unmatched` exactly as a genuine miss would.
      match = null
    }

    done += 1
    onProgress?.(done, selected.length)

    /**
     * An unmatched title is still worth keeping — but only in Watched.
     *
     * Watched is the one list that means something without a TMDB id: it is a
     * record that the user saw this, and the title alone carries that. A
     * watchlist entry or a release tracker without an id cannot be played or
     * checked, so it would be a row that does nothing forever.
     */
    if (!match) {
      summary.unmatched.push(entry.title)
      if (target !== 'watched') continue

      watched.push(stamp({
        id: newId(),
        tmdbId: 0,
        type,
        title: entry.title,
        posterPath: null,
        imdbId: null,
        genreIds: [],
        addedAt: Date.now(),
        source: 'mal',
        malId: entry.malId,
      }))
      summary.watched += 1
      continue
    }

    if (target === 'watched' && !haveWatched.has(match.tmdbId)) {
      haveWatched.add(match.tmdbId)
      watched.push(stamp({
        id: newId(),
        tmdbId: match.tmdbId,
        type,
        title: match.title,
        posterPath: match.posterPath,
        imdbId: match.imdbId,
        genreIds: match.genreIds,
        addedAt: Date.now(),
        source: 'mal',
        malId: entry.malId,
      }))
      summary.watched += 1
    }

    if (target === 'watchlist' && !haveWatchlist.has(match.tmdbId)) {
      haveWatchlist.add(match.tmdbId)
      watchlist.push(stamp({
        id: newId(),
        tmdbId: match.tmdbId,
        type,
        title: match.title,
        posterPath: match.posterPath,
        imdbId: match.imdbId,
        /**
         * Resume where MAL says they got to.
         *
         * Season 1 because MAL models each season as its own entry while TMDB
         * models them as seasons of one show — so a MAL "2nd Season" record
         * resolves to the same TMDB series and its episode count is season-1
         * relative. Guessing a season number from the title would be worse
         * than being consistently wrong in a way the user can correct.
         */
        lastSeason: type === 'tv' ? 1 : null,
        lastEpisode: type === 'tv' ? Math.max(1, entry.watchedEpisodes) : null,
        watchedEpisodes: [],
        episodeMarks: {},
        genreIds: match.genreIds,
        episodeCount: entry.totalEpisodes || null,
        addedAt: Date.now(),
        providerId: null,
      } satisfies WatchlistEntry))
      summary.watchlist += 1
    }

    if (target === 'releases' && type === 'tv' && !haveTracker.has(match.tmdbId)) {
      haveTracker.add(match.tmdbId)
      trackers.push(stamp({
        id: newId(),
        tmdbId: match.tmdbId,
        title: match.title,
        posterPath: match.posterPath,
        status: '',
        nextEpisode: null,
        lastNotified: null,
        addedAt: Date.now(),
        // Zero rather than now, so the next sweep checks it immediately instead
        // of waiting a full interval to find out what is airing.
        lastChecked: 0,
      } satisfies ReleaseTracker))
      summary.releases += 1
    }

    /**
     * Scores become ratings, but never overwrite one the user already set.
     *
     * An import is bulk and old; a rating made in the app is deliberate and
     * recent. Letting the first silently replace the second is the kind of data
     * loss nobody notices until the recommendations stop making sense.
     */
    if (decisions.applyScores && !haveRating.has(match.tmdbId)) {
      const rating = ratingFromScore(entry.score)
      if (rating) {
        haveRating.add(match.tmdbId)
        ratings.push(stamp({
          key: `${type}:${match.imdbId || match.tmdbId}`,
          tmdbId: match.tmdbId,
          type,
          rating,
          genreIds: match.genreIds,
          at: Date.now(),
        } satisfies TitleRating))
        summary.ratings += 1
      }
    }
  }

  return {
    store: { ...store, watchlist, watched, trackers, ratings },
    summary,
  }
}

export type { WatchedEntry }
