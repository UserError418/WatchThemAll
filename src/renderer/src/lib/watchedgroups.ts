/**
 * The Watched tab, folded from one row per season into one row per title.
 *
 * 194 titles arrive as 367 entries because 1.5.7 made "watched" a per-season
 * statement, and a nine-season series is therefore nine records. That model is
 * right — it is what lets the app say you finished season 3 and not season 4 —
 * but rendering it directly turns a library into a wall of near-identical
 * posters. So the records stay per-season and the *view* folds them.
 *
 * ## Why the group key is not just `tmdbId`
 *
 * Every import that never resolved carries `tmdbId: 0`. Grouping on that field
 * alone would collapse every unresolved title in the library into a single row
 * claiming to be one series with N seasons. They each get their own group,
 * keyed by record id instead.
 *
 * ## Why the summary is a mean now, and was a tally before
 *
 * Until the 1–10 scale a collapsed row showed `18 liked, 2 disliked`, and this
 * header said it must never be an average: there is no average of a like and
 * a dislike, and inventing one would be the same class of lie as drawing
 * TMDB's "nobody has rated this" zero as a score of 0.0.
 *
 * That reason was about the values, not about averaging, and the values have
 * changed. Seasons now carry numbers the user chose, and the mean of those is
 * a plain fact about them — so a series row shows it, to one decimal, over the
 * seasons actually rated. What survives of the old rule is its point: an
 * unrated season is left out of the mean rather than counted as anything, and
 * a title with nothing rated has no mean at all rather than a zero.
 *
 * The band counts (liked · mixed · disliked · unrated) are kept alongside it,
 * because the filters, the header and the meter are built on bands.
 */

import type { MediaType, RatingValue, WatchedEntry } from '@shared/types'
import { isRatingValue, ratingBand, type RatingBand } from '@shared/rating'

export interface SeasonRow {
  entry: WatchedEntry
  /** The rating held at this entry's own scope. Null when there is none. */
  rating: RatingValue | null
}

/** How many seasons fall in each band, and how many have no rating yet. */
export interface BandCounts {
  liked: number
  mixed: number
  disliked: number
  unrated: number
}

export interface TitleGroup extends BandCounts {
  /** Stable `{#each}` key. Not the tmdbId — see the module header. */
  key: string
  tmdbId: number
  title: string
  type: MediaType
  posterPath: string | null
  /** TMDB score, taken from whichever season carries one. 0 when unknown. */
  score: number
  /** True when any season came from a MyAnimeList import. */
  imported: boolean
  /** Newest season first, matching the order the library already renders in. */
  seasons: SeasonRow[]
  /**
   * The mean of the rated seasons' values, unrounded. Null when none is
   * rated — never 0, which would read as a verdict.
   */
  mean: number | null
  /** The most recent time any of these seasons was filed. */
  addedAt: number
  /** A single row with nothing to expand: a film, or one season. */
  flat: boolean
}

export type WatchedSort = 'recent' | 'title' | 'rating' | 'score' | 'seasons'

/**
 * Sort options, in menu order, with the labels the view draws.
 *
 * Here rather than in the view so the id and the label cannot drift apart, and
 * so adding one is a single edit.
 */
export const WATCHED_SORTS: Array<{ id: WatchedSort; label: string }> = [
  { id: 'recent', label: 'Recently added' },
  { id: 'title', label: 'Title A–Z' },
  { id: 'rating', label: 'Your rating' },
  // Named for whose score it is: "Highest score" beside a list the user rates
  // 1–10 read as their own, and it was TMDB's.
  { id: 'score', label: 'TMDB rating' },
  { id: 'seasons', label: 'Most seasons' },
]

/** Whether a stored value is one of the sorts, for reading it back from storage. */
export function isWatchedSort(value: unknown): value is WatchedSort {
  return WATCHED_SORTS.some((option) => option.id === value)
}

/**
 * Fold entries into one group per title.
 *
 * Takes entries that have *already* been filtered, so a group's counts and
 * mean describe what is on screen rather than what exists — under the
 * "Unrated" filter a row should say how many of its seasons still need a
 * rating, not how many it has in total.
 */
export function groupWatched(
  entries: readonly WatchedEntry[],
  ratingOf: (entry: WatchedEntry) => RatingValue | null,
  sort: WatchedSort = 'recent',
): TitleGroup[] {
  const groups = new Map<string, TitleGroup>()
  /** Running totals for the means, kept off the group so it stays plain data. */
  const sums = new Map<string, number>()

  for (const entry of entries) {
    const key = entry.tmdbId ? `t${entry.tmdbId}` : `e${entry.id}`
    const rating = ratingOf(entry)

    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        tmdbId: entry.tmdbId,
        title: entry.title,
        type: entry.type,
        posterPath: entry.posterPath,
        score: 0,
        imported: false,
        seasons: [],
        liked: 0,
        mixed: 0,
        disliked: 0,
        unrated: 0,
        mean: null,
        addedAt: 0,
        flat: true,
      }
      groups.set(key, group)
    }

    group.seasons.push({ entry, rating })
    if (rating === null) {
      group.unrated += 1
    } else {
      group[ratingBand(rating)] += 1
      sums.set(key, (sums.get(key) ?? 0) + rating)
    }

    group.addedAt = Math.max(group.addedAt, entry.addedAt)
    // Artwork and score can be missing on one season and present on another —
    // an entry filed by hand carries less than one filed from a detail page.
    group.posterPath ??= entry.posterPath
    if (entry.rating > group.score) group.score = entry.rating
    if (entry.source === 'mal') group.imported = true
  }

  for (const group of groups.values()) {
    // Newest season first. Legacy whole-series entries have no season at all
    // and sort last, where they read as the odd one out that they are.
    group.seasons.sort((a, b) => (b.entry.season ?? -1) - (a.entry.season ?? -1))
    group.flat = group.seasons.length === 1
    const rated = group.seasons.length - group.unrated
    group.mean = rated > 0 ? (sums.get(group.key) ?? 0) / rated : null
  }

  return [...groups.values()].sort(comparator(sort))
}

function comparator(sort: WatchedSort): (a: TitleGroup, b: TitleGroup) => number {
  switch (sort) {
    case 'title':
      return (a, b) => a.title.localeCompare(b.title)
    case 'seasons':
      // Ties broken by title rather than left to insertion order, so the list
      // does not reshuffle its long tail of one-season titles on every render.
      return (a, b) => b.seasons.length - a.seasons.length || a.title.localeCompare(b.title)
    case 'score':
      return (a, b) => b.score - a.score || a.title.localeCompare(b.title)
    case 'rating':
      // The user's own verdict: the mean of the rated seasons. Unrated titles
      // go last rather than being read as a zero, then TMDB's score orders the
      // equal ones, because "which of my 9s" is best answered by everyone else.
      return (a, b) =>
        (b.mean ?? -1) - (a.mean ?? -1) || b.score - a.score || a.title.localeCompare(b.title)
    case 'recent':
    default:
      return (a, b) => b.addedAt - a.addedAt || a.title.localeCompare(b.title)
  }
}

/** A mean as the row prints it: one decimal, so a 7.5 and an 8 look different. */
export function formatMean(mean: number): string {
  return mean.toFixed(1)
}

/**
 * `avg 7.8 · 2 unrated`, for a collapsed series row, omitting what is absent.
 *
 * The mean covers only the seasons that are rated, which is why the unrated
 * count sits beside it rather than being folded in.
 */
export function summaryLabel(group: Pick<TitleGroup, 'mean' | 'unrated'>): string {
  const parts: string[] = []
  if (group.mean !== null) parts.push(`avg ${formatMean(group.mean)}`)
  if (group.unrated) parts.push(`${group.unrated} unrated`)
  return parts.join(' · ')
}

/** The band of one season's rating, or null for an unrated one. */
export function bandOf(rating: RatingValue | null): RatingBand | null {
  return rating === null ? null : ratingBand(rating)
}

/**
 * Which way the row's edge is tinted: the band its mean falls in.
 *
 * The mean is rounded to the nearest value first — the band it would be if it
 * were a rating — so a 7.6 tints as liked and a 7.4 as mixed, agreeing with
 * the one-decimal number printed beside it.
 *
 * This replaced a majority vote of likes against dislikes, which returned null
 * on a tie because a series split evenly is not "liked". A mean says that on
 * its own: seasons of 9 and 3 average 6, and 6 is mixed. Null only when
 * nothing is rated.
 */
export function leaning(group: Pick<TitleGroup, 'mean'>): RatingBand | null {
  if (group.mean === null) return null
  const nearest = Math.round(group.mean)
  return isRatingValue(nearest) ? ratingBand(nearest) : null
}

/** Totals for the header, counted from what is on screen. */
export interface WatchedTotals extends BandCounts {
  titles: number
  seasons: number
}

export function summarise(groups: readonly TitleGroup[]): WatchedTotals {
  return groups.reduce<WatchedTotals>(
    (acc, g) => ({
      titles: acc.titles + 1,
      seasons: acc.seasons + g.seasons.length,
      liked: acc.liked + g.liked,
      mixed: acc.mixed + g.mixed,
      disliked: acc.disliked + g.disliked,
      unrated: acc.unrated + g.unrated,
    }),
    { titles: 0, seasons: 0, liked: 0, mixed: 0, disliked: 0, unrated: 0 },
  )
}

/**
 * The title with the most seasons behind it, for the header's last tile.
 *
 * A library of two hundred rows has no single fact in it worth a headline, so
 * this is the nearest thing: the series the user has put the most of their
 * life into. Ties go to the title, so the tile does not change on every
 * render.
 */
export function deepest(groups: readonly TitleGroup[]): TitleGroup | null {
  let best: TitleGroup | null = null
  for (const group of groups) {
    if (group.seasons.length < 2) continue
    if (
      best === null ||
      group.seasons.length > best.seasons.length ||
      (group.seasons.length === best.seasons.length && group.title.localeCompare(best.title) < 0)
    ) {
      best = group
    }
  }
  return best
}

/* ── The season ribbon ──────────────────────────────────────────────────── */

export interface RibbonSegment {
  key: string
  /** "Season 3", or "Whole series" for a 1.5.8 survivor with no season. */
  label: string
  rating: RatingValue | null
  /** A season that has aired and is not marked watched: drawn hollow. */
  pending?: boolean
}

/**
 * How many seasons a ribbon draws before it starts hiding the early ones.
 *
 * Twenty-four covers all but the outliers in a real library — the longest
 * here is twenty — while staying narrow enough that each segment is still a
 * target rather than a hairline.
 */
export const RIBBON_LIMIT = 24

/**
 * A title's seasons as a left-to-right strip, each tinted by the band of its
 * rating (`bandOf`).
 *
 * Runs **oldest first**, which is the opposite of the expanded list. That is
 * deliberate: a list is read top-down as "what is here", newest first like
 * every other list in the app, while a strip is read left-to-right as a run of
 * time, and a run of time that starts at the end is a puzzle.
 *
 * When there are more seasons than fit, the *recent* ones are kept. An opinion
 * about season 19 says more about whether the user is still enjoying it than
 * an opinion about season 1.
 */
export function ribbon(
  group: TitleGroup,
  limit = RIBBON_LIMIT,
  airedSeasons: number | null = null,
): { segments: RibbonSegment[]; hidden: number } {
  const all: RibbonSegment[] = withPending(
    [...group.seasons].reverse().map((row) => ({
      key: row.entry.id,
      label:
        row.entry.season === null || row.entry.season === undefined
          ? 'Whole series'
          : `Season ${row.entry.season}`,
      rating: row.rating,
    })),
    group,
    airedSeasons,
  )

  if (all.length <= limit) return { segments: all, hidden: 0 }
  return { segments: all.slice(all.length - limit), hidden: all.length - limit }
}

/**
 * The seasons that have aired and are not watched, slotted in where they fall.
 *
 * What turns the ribbon from "what I thought of it" into "where I am with
 * it": a series watched to season 5 of 7 shows two hollow segments at the
 * end, which is the one thing about it worth knowing at a glance.
 *
 * Left out for an import from MyAnimeList, which numbers seasons its own way
 * — one anime's "season 6" is TMDB's season 2 — so the gaps it would draw
 * would be invented. Left out too wherever a season has no number, because a
 * whole-series entry already claims all of them.
 */
function withPending(
  watched: RibbonSegment[],
  group: TitleGroup,
  airedSeasons: number | null,
): RibbonSegment[] {
  if (airedSeasons === null || group.imported || group.type !== 'tv') return watched
  const numbers = group.seasons.map((row) => row.entry.season)
  if (numbers.some((n) => n === null || n === undefined || n < 1)) return watched

  // `watched` runs oldest first, the reverse of `group.seasons` and `numbers`.
  const seen = new Map(watched.map((segment, i) => [numbers[numbers.length - 1 - i]!, segment]))
  const last = Math.max(airedSeasons, ...(numbers as number[]))
  const out: RibbonSegment[] = []
  for (let season = 1; season <= last; season += 1) {
    out.push(
      seen.get(season) ?? {
        key: `pending-${season}`,
        label: `Season ${season} · not watched`,
        rating: null,
        pending: true,
      },
    )
  }
  return out
}

/** How many aired seasons of a series are not marked watched — "2 to go". */
export function seasonsToGo(group: TitleGroup, airedSeasons: number | null): number {
  return ribbon(group, Number.MAX_SAFE_INTEGER, airedSeasons).segments.filter((s) => s.pending)
    .length
}
