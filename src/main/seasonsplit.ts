/**
 * Split whole-series "watched" entries into one entry per season.
 *
 * ## Why this exists
 *
 * Until 1.5.7 the Watched list held whole titles: marking a nine-season show
 * watched said "all nine", and the episode browser then ticked off every
 * episode of every season the user opened. 1.5.7 scopes both to a season, and
 * `migrate.ts` gives every pre-existing entry `season: null` — which is
 * faithful to what those entries meant, and is *not* what a library full of
 * them should look like afterwards. A shelf of one-card-per-series under a
 * per-season model is the old state wearing new clothes.
 *
 * So this is a second, one-time pass that rewrites them. It is separate from
 * `migrate.ts` for a reason that is not stylistic: `migrate` runs synchronously
 * on every load and must never need the network, and knowing how many seasons
 * a series has sometimes does.
 *
 * ## How a series' seasons are decided
 *
 * In order of how much the evidence is worth:
 *
 * 1. **Seasons with watched episodes**, from the watchlist entry's own marks.
 *    This is the only per-season record the old model kept, and where it exists
 *    it is a direct statement about what was watched rather than an inference.
 * 2. **Every season TMDB reports**, when there are no marks at all — a
 *    MyAnimeList import, or a title marked watched without ever being opened.
 *    The old entry did claim the whole series, so claiming every season of it
 *    is the faithful reading rather than a guess.
 *
 * A title with neither — no marks, and no TMDB id to ask about — is left
 * exactly as it is. Inventing seasons for it would be worse than a stale card.
 *
 * ## Films filed as series
 *
 * Asking TMDB turns up a third case that has nothing to do with seasons. A
 * MyAnimeList import files compilation films, OVAs and specials as `type:
 * 'tv'`, so `/tv/{id}` answers 404 while `/movie/{id}` returns the title — six
 * such entries were in the library this was written against. They have no
 * seasons to split because they are not series, and left alone they stay in
 * Watched as cards that cannot be opened, seed the recommender with a `/tv`
 * request that always 404s, and cost a wasted lookup on every launch.
 *
 * Since the pass has already asked the question, it corrects the type rather
 * than reporting the title as unrepairable. That is evidence, not inference:
 * TMDB answering `/movie/{id}` and refusing `/tv/{id}` is as definite as this
 * gets. The id stays the same, so nothing is re-identified.
 *
 * ## Why the new ids are derived rather than random
 *
 * `${id}:s3`, not a fresh uuid. Two devices running this pass independently —
 * which is precisely what a desktop and a phone both updating *is* — produce
 * the same ids, so the sync merge recognises them as one record. Random ids
 * would leave the user with every season twice.
 *
 * ## Why there is no "already done" flag
 *
 * The remaining work is defined by the data: a legacy entry is a `tv` entry
 * with `season === null`, and splitting one removes it. Once the app stopped
 * creating that shape (`markTitleSeen` no longer files whole-series entries),
 * a finished library simply has none left and the pass finds nothing. A flag
 * would add a second source of truth that could disagree with the first — and
 * would wrongly skip a legacy entry arriving later from a device still on an
 * older build.
 */

import type { EpisodeMark, TitleRating, WatchedEntry, WatchlistEntry } from '@shared/types'

/** Pause between TMDB lookups. Nothing waits on this work; being polite is free. */
const GAP_MS = 250

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Which seasons this watchlist entry has at least one watched episode in. */
export function seasonsWithProgress(
  entry: Pick<WatchlistEntry, 'episodeMarks' | 'watchedEpisodes'> | undefined,
): number[] {
  if (!entry) return []

  // Both fields are consulted because they can disagree: `episodeMarks` is the
  // mergeable record and `watchedEpisodes` the rendered one, and an entry
  // written before marks existed has only the latter.
  const keys = new Set<string>()
  for (const [key, mark] of Object.entries(entry.episodeMarks ?? {})) {
    if ((mark as EpisodeMark | undefined)?.watched) keys.add(key)
  }
  for (const key of entry.watchedEpisodes ?? []) keys.add(key)

  const seasons = new Set<number>()
  for (const key of keys) {
    const season = Number(key.split(':')[0])
    // Seasons are 1-based everywhere. A 0 is a specials bucket or a key that
    // failed to parse long ago, and neither is a season anyone watched.
    if (Number.isInteger(season) && season >= 1) seasons.add(season)
  }
  return [...seasons].sort((a, b) => a - b)
}

/** One watched entry per season, derived from the whole-series one. */
export function splitWatchedEntry(entry: WatchedEntry, seasons: number[]): WatchedEntry[] {
  return seasons.map((season) => ({ ...entry, id: `${entry.id}:s${season}`, season }))
}

/**
 * Season ratings derived from a whole-series one.
 *
 * The series rating is kept as well — it is a real opinion about a real thing,
 * and 1.5.7 still stores and shows it. This copies it down so the new season
 * cards do not all appear unrated, which would read as the migration having
 * lost every rating the user ever gave. A season the user later rates
 * differently simply overwrites its copy.
 *
 * Seasons that already carry their own opinion are left alone: the user having
 * said something specific about season 3 outranks a copy of what they said
 * about the series.
 */
export function splitTitleRating(
  rating: TitleRating,
  seasons: number[],
  existingKeys: ReadonlySet<string>,
): TitleRating[] {
  return seasons
    .map((season) => ({ ...rating, key: `${rating.key}:s${season}`, season }))
    .filter((copy) => !existingKeys.has(copy.key))
}

/**
 * What TMDB knows about an id, which is what decides how an entry is repaired.
 *
 * One question rather than two calls with separate meanings: the caller asks
 * once and gets back the only three answers that lead anywhere — a series with
 * a season count, a film, or nothing TMDB will serve.
 */
export type TitleShape =
  | { kind: 'series'; seasons: number }
  | { kind: 'film' }
  | { kind: 'unknown' }

/**
 * The TMDB-backed `identify`, so both platforms ask the question the same way.
 *
 * Takes the detail function rather than importing a client, which keeps this
 * module free of any network dependency and lets the test drive it directly.
 *
 * The order matters. `/tv/{id}` is asked first because that is what the entry
 * claims to be, and only its failure justifies the second call — so a library
 * of genuine series costs exactly one request per title, and the extra lookup
 * is paid only by the handful that were mis-filed.
 */
export function tmdbIdentify(
  detail: (tmdbId: number, type: 'tv' | 'movie') => Promise<{ seasonCount: number } | null>,
): (tmdbId: number) => Promise<TitleShape> {
  return async (tmdbId) => {
    try {
      const series = await detail(tmdbId, 'tv')
      // A series TMDB serves but reports no seasons for is not a usable answer;
      // it falls through to the film check like any other failure.
      if (series && series.seasonCount > 0) return { kind: 'series', seasons: series.seasonCount }
    } catch {
      // Either not a series or not reachable. The film check tells them apart:
      // a 404 here plus a hit below is a mis-filed film, and two failures is an
      // id nothing can resolve.
    }

    try {
      if (await detail(tmdbId, 'movie')) return { kind: 'film' }
    } catch {
      // Nothing TMDB will serve under either type.
    }
    return { kind: 'unknown' }
  }
}

export interface SeasonSplitDeps {
  /** Live watched entries. Read once; the pass does not re-read as it writes. */
  watched: () => WatchedEntry[]
  /** Live title ratings, for finding the series-level opinion to copy down. */
  ratings: () => TitleRating[]
  watchlistEntry: (tmdbId: number) => WatchlistEntry | undefined
  /** What TMDB says the id is. Never throws; `unknown` covers every failure. */
  identify: (tmdbId: number) => Promise<TitleShape>
  /** Persist one title's seasons. Batched so the UI redraws once per title. */
  putWatched: (entries: WatchedEntry[]) => void
  /** Tombstone the legacy entry, so the deletion reaches other devices. */
  removeWatched: (id: string) => void
  putRatings: (ratings: TitleRating[]) => void
  /** Tombstone a rating by key, for the one case that has to be re-keyed. */
  removeRating: (key: string) => void
  wait?: (ms: number) => Promise<void>
}

export interface SeasonSplitReport {
  /** Whole-series entries rewritten. */
  split: number
  /** Season entries created. */
  created: number
  /** Season ratings copied down from a series rating. */
  ratings: number
  /** Entries that were not series at all, corrected to films. */
  retyped: number
  /** Entries left alone because nothing could say what seasons they had. */
  skipped: number
}

/**
 * Rewrite every legacy whole-series watched entry. Safe to run repeatedly.
 *
 * Deliberately *not* transactional. Each title is finished before the next is
 * started, so a run interrupted by the app closing leaves a consistent library
 * — some titles split, the rest still legacy — and the next launch picks up
 * exactly where it stopped, because what remains is defined by the data rather
 * than by a cursor.
 */
export async function runSeasonSplit(deps: SeasonSplitDeps): Promise<SeasonSplitReport> {
  const wait = deps.wait ?? sleep
  const report: SeasonSplitReport = { split: 0, created: 0, ratings: 0, retyped: 0, skipped: 0 }

  const legacy = deps.watched().filter((entry) => entry.type === 'tv' && entry.season === null)
  if (legacy.length === 0) return report

  const ratings = deps.ratings()
  const takenKeys = new Set(ratings.map((rating) => rating.key))
  const seriesRatingFor = (tmdbId: number): TitleRating | undefined =>
    ratings.find((rating) => rating.tmdbId === tmdbId && rating.season === null)

  for (const entry of legacy) {
    let seasons = seasonsWithProgress(deps.watchlistEntry(entry.tmdbId))

    if (seasons.length === 0) {
      // No per-season evidence. Asking TMDB is the only way to honour what the
      // entry claimed, and an unresolved import has no id to ask with.
      if (entry.tmdbId <= 0) {
        report.skipped += 1
        continue
      }

      const shape = await deps.identify(entry.tmdbId)
      await wait(GAP_MS)

      if (shape.kind === 'unknown') {
        // Unreachable, or an id TMDB no longer serves. Either way it is legacy
        // again next launch, which beats inventing a season count from nothing.
        report.skipped += 1
        continue
      }

      if (shape.kind === 'film') {
        retypeAsFilm(entry, seriesRatingFor(entry.tmdbId), deps)
        report.retyped += 1
        continue
      }

      seasons = Array.from({ length: shape.seasons }, (_, index) => index + 1)
    }

    const created = splitWatchedEntry(entry, seasons)
    deps.putWatched(created)
    // Only after the replacements are persisted: the reverse order would lose
    // the title entirely if the process stopped between the two writes.
    deps.removeWatched(entry.id)
    report.split += 1
    report.created += created.length

    const seriesRating = seriesRatingFor(entry.tmdbId)
    if (seriesRating) {
      const copies = splitTitleRating(seriesRating, seasons, takenKeys)
      if (copies.length > 0) {
        deps.putRatings(copies)
        for (const copy of copies) takenKeys.add(copy.key)
        report.ratings += copies.length
      }
    }
  }

  return report
}

/**
 * Correct an entry that TMDB serves as a film, not a series.
 *
 * The watched entry keeps its id and only changes type, so no record is
 * re-identified and `season: null` goes from meaning "all of a series" to
 * meaning what it means for every film in the library.
 *
 * Its rating cannot be edited in place the same way. The key encodes the type
 * (`tv:tt123`), and it *is* the merge identity for ratings — so correcting the
 * type means writing the record under `movie:tt123` and tombstoning the old
 * key. Leaving it would keep seeding the recommender with a `/tv` request that
 * answers 404 for exactly these titles.
 */
function retypeAsFilm(
  entry: WatchedEntry,
  rating: TitleRating | undefined,
  deps: Pick<SeasonSplitDeps, 'putWatched' | 'putRatings' | 'removeRating'>,
): void {
  deps.putWatched([{ ...entry, type: 'movie' }])

  if (!rating || !rating.key.startsWith('tv:')) return
  const corrected = `movie:${rating.key.slice('tv:'.length)}`
  deps.putRatings([{ ...rating, key: corrected, type: 'movie' }])
  deps.removeRating(rating.key)
}
