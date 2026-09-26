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

import type {
  MediaType,
  RatingValue,
  ReleaseTracker,
  StoreShape,
  Synced,
  TitleRating,
  WatchedEntry,
  WatchlistEntry,
} from '@shared/types'
import type { ImportTarget, MalEntry, MalStatus } from './malimport'
import { mediaTypeFor, ratingFromScore } from './malimport'
import { isRatingValue, legacyRatingOf } from '@shared/rating'
import { stamp } from '@shared/store/core'

/** What the user chose in the preview dialog. */
export interface ImportDecisions {
  /** Where each status group goes. `skip` drops the group. */
  targets: Record<MalStatus, ImportTarget>
  /** MAL ids the user unticked. Everything not listed is imported. */
  excludedMalIds: number[]
  /** Whether to turn MAL scores into ratings. */
  applyScores: boolean
}

/** Enough of a TMDB match to build an entry. Null when nothing matched. */
export interface ResolvedTitle {
  tmdbId: number
  imdbId: string | null
  title: string
  posterPath: string | null
  genreIds: number[]
  /** TMDB `vote_average`; 0 when the match came from somewhere without one. */
  rating: number
}

export type Resolver = (title: string, type: MediaType) => Promise<ResolvedTitle | null>

export interface ImportSummary {
  watchlist: number
  watched: number
  releases: number
  /** New title ratings created from MAL scores. */
  ratings: number
  /**
   * Converted thumbs (`coarse` ratings) replaced by the exact MAL score.
   * Counted per rating, so a series whose five season thumbs were all
   * sharpened counts five.
   */
  refined: number
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
    refined: 0,
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

  /** Every MAL score that resolved to a title, collected before any is applied. */
  const scored = new Map<number, ScoredTitle>()

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
        // A MyAnimeList export says "watched", not "watched season 2", so an
        // import means the whole title — the same thing it has always meant.
        season: null,
        title: entry.title,
        posterPath: null,
        rating: 0,
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
        season: null,
        title: match.title,
        posterPath: match.posterPath,
        rating: match.rating ?? 0,
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
        rating: match.rating ?? 0,
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

    if (decisions.applyScores) {
      const title = scored.get(match.tmdbId) ?? { match, type, scores: [] }
      title.scores.push(entry.score)
      scored.set(match.tmdbId, title)
    }
  }

  for (const title of scored.values()) {
    const outcome = applyScore(ratings, title)
    if (outcome.created) summary.ratings += 1
    summary.refined += outcome.refined
  }

  return {
    store: { ...store, watchlist, watched, trackers, ratings },
    summary,
  }
}

export type { WatchedEntry }

/** One TMDB title and every MAL score that resolved to it. */
interface ScoredTitle {
  match: ResolvedTitle
  type: MediaType
  scores: number[]
}

/**
 * The one score a title gets from the MAL entries that resolved to it.
 *
 * Several usually do: MAL files "2nd Season" as an entry of its own while TMDB
 * files it as a season of one show (see `lastSeason` above), so a three-season
 * anime is three scores for one TMDB title. They are averaged, ignoring MAL's
 * 0 for "not scored", and rounded to the nearest whole value — a half rounds
 * up, which with integer inputs only ever happens between two neighbours.
 *
 * Averaged rather than first-wins, which is what this replaced. First-wins made
 * the title's rating depend on the order of entries in the export file: the
 * same library imported twice could come out a 9 or a 6 depending on which
 * season MAL happened to list first. A mean has no order.
 *
 * Null when none of the entries carries a score.
 */
function titleScore(scores: readonly number[]): RatingValue | null {
  const values = scores.map(ratingFromScore).filter((v): v is RatingValue => v !== null)
  if (values.length === 0) return null
  const mean = Math.round(values.reduce<number>((sum, v) => sum + v, 0) / values.length)
  return isRatingValue(mean) ? mean : null
}

/**
 * How far a MAL score may sit from a converted thumb (an 8 or a 4) and still be
 * the same opinion, only stated more precisely.
 *
 * Three reaches every score a thumb plausibly rounded: a like (8) covers 5–10
 * and a dislike (4) covers 1–7. Beyond that the two contradict each other — a
 * like against a MAL 3 — which means the user changed their mind at some
 * point, and the thumb in the app is the newer statement.
 *
 * This replaced a same-side-of-6 test (`legacyRatingOf`), which assumed every
 * user drew the like/dislike line where the app does. On the library this was
 * built for, all 22 thumbs that test rejected were a MAL 6 or 7 thumbed down
 * (a stricter line than the app's, not a change of mind), and none was a
 * contradiction.
 */
export const REFINE_REACH = 3

/**
 * Turn one title's MAL score into a rating, or refine converted ones with it.
 * Mutates `ratings` in place; the caller owns that copy.
 *
 * **A title with no rating** gets one, at the title scope — a MyAnimeList
 * score is about the entry as a whole, and MAL cannot tell seasons apart.
 * Any existing rating on the title, season ratings included, still counts as
 * "the user already has an opinion here" and blocks a new one, as it always
 * has.
 *
 * **Every `coarse` rating on the title** — an 8 or a 4 converted from a thumb,
 * whole title and each season alike — is replaced by the exact MAL score when
 * the two are within `REFINE_REACH`. Seasons are included because that is
 * where most converted thumbs live: splitting a series into seasons (1.5.8)
 * copied its thumb onto every season, so a like on a five-season anime is five
 * season 8s and often no title rating at all. Leaving those alone left 201 of
 * one library's thumbs unrefined. Every season gets the one title score
 * because MAL's per-season entries cannot be matched to TMDB's seasons
 * reliably (`lastSeason` above has the reason). The user can rate a season
 * differently afterwards, and that rating is no longer coarse, so a later
 * import leaves it alone.
 *
 * **A rating chosen on the 1–10 scale is never touched.** It is deliberate and
 * newer than any export. An import is bulk and old, and letting it silently
 * replace a deliberate rating is the kind of data loss nobody notices until
 * the recommendations stop making sense.
 */
function applyScore(
  ratings: Synced<TitleRating>[],
  title: ScoredTitle,
): { created: boolean; refined: number } {
  const value = titleScore(title.scores)
  if (value === null) return { created: false, refined: 0 }

  const { match, type } = title
  const onTitle = (r: TitleRating): boolean => r.tmdbId === match.tmdbId && r.type === type

  if (!ratings.some(onTitle)) {
    ratings.push(
      stamp({
        key: `${type}:${match.imdbId || match.tmdbId}`,
        tmdbId: match.tmdbId,
        type,
        season: null,
        value,
        coarse: false,
        rating: legacyRatingOf(value),
        genreIds: match.genreIds,
        at: Date.now(),
      } satisfies TitleRating),
    )
    return { created: true, refined: 0 }
  }

  let refined = 0
  ratings.forEach((existing, i) => {
    if (!onTitle(existing) || !existing.coarse) return
    if (Math.abs(existing.value - value) > REFINE_REACH) return
    // The same record, under the same key, with the exact value in place of
    // the conversion. Stamped like every other write here, so it wins the merge.
    ratings[i] = stamp({
      ...existing,
      value,
      coarse: false,
      rating: legacyRatingOf(value),
      at: Date.now(),
    })
    refined += 1
  })
  return { created: false, refined }
}
