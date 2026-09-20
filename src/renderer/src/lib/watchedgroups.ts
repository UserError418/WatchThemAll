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
 * ## Why the summary is a tally and never an average
 *
 * A collapsed row shows `18 liked, 2 disliked`, not a score. There is no
 * average of a like and a dislike, and inventing one — a percentage, a star
 * count — would be the same class of lie as drawing TMDB's "nobody has rated
 * this" zero as a score of 0.0. The tally states what is actually known.
 */

import type { MediaType, Rating, WatchedEntry } from '@shared/types'

export interface SeasonRow {
  entry: WatchedEntry
  /** The opinion held at this entry's own scope. Null when there is none. */
  rating: Rating | null
}

export interface TitleGroup {
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
  likes: number
  dislikes: number
  unrated: number
  /** The most recent time any of these seasons was filed. */
  addedAt: number
  /** A single row with nothing to expand: a film, or one season. */
  flat: boolean
}

export type WatchedSort = 'recent' | 'title' | 'seasons' | 'score'

/**
 * Sort options, in menu order, with the labels the view draws.
 *
 * Here rather than in the view so the id and the label cannot drift apart, and
 * so adding one is a single edit.
 */
export const WATCHED_SORTS: Array<{ id: WatchedSort; label: string }> = [
  { id: 'recent', label: 'Recently added' },
  { id: 'title', label: 'A–Z' },
  { id: 'seasons', label: 'Most seasons' },
  { id: 'score', label: 'Highest score' },
]

/**
 * Fold entries into one group per title.
 *
 * Takes entries that have *already* been filtered, so a group's tally counts
 * what is on screen rather than what exists — under the "Unrated" filter a row
 * should say how many of its seasons still need an opinion, not how many it
 * has in total.
 */
export function groupWatched(
  entries: readonly WatchedEntry[],
  ratingOf: (entry: WatchedEntry) => Rating | null,
  sort: WatchedSort = 'recent',
): TitleGroup[] {
  const groups = new Map<string, TitleGroup>()

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
        likes: 0,
        dislikes: 0,
        unrated: 0,
        addedAt: 0,
        flat: true,
      }
      groups.set(key, group)
    }

    group.seasons.push({ entry, rating })
    if (rating === 'like') group.likes += 1
    else if (rating === 'dislike') group.dislikes += 1
    else group.unrated += 1

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
    case 'recent':
    default:
      return (a, b) => b.addedAt - a.addedAt || a.title.localeCompare(b.title)
  }
}

/** `18 liked · 2 disliked · 1 unrated`, omitting whatever is zero. */
export function tallyLabel(group: Pick<TitleGroup, 'likes' | 'dislikes' | 'unrated'>): string {
  const parts: string[] = []
  if (group.likes) parts.push(`${group.likes} liked`)
  if (group.dislikes) parts.push(`${group.dislikes} disliked`)
  if (group.unrated) parts.push(`${group.unrated} unrated`)
  return parts.join(' · ')
}

/**
 * Which way the row's edge is tinted: what the user mostly thought of it.
 *
 * Returns null on a genuine tie as well as on nothing-rated, because a series
 * split evenly is not "liked" and painting it either colour would assert
 * something the tally right next to it contradicts.
 */
export function leaning(
  group: Pick<TitleGroup, 'likes' | 'dislikes'>,
): 'like' | 'dislike' | null {
  if (group.likes === group.dislikes) return null
  return group.likes > group.dislikes ? 'like' : 'dislike'
}

/** Totals for the header, counted from what is on screen. */
export interface WatchedTotals {
  titles: number
  seasons: number
  likes: number
  dislikes: number
  unrated: number
}

export function summarise(groups: readonly TitleGroup[]): WatchedTotals {
  return groups.reduce<WatchedTotals>(
    (acc, g) => ({
      titles: acc.titles + 1,
      seasons: acc.seasons + g.seasons.length,
      likes: acc.likes + g.likes,
      dislikes: acc.dislikes + g.dislikes,
      unrated: acc.unrated + g.unrated,
    }),
    { titles: 0, seasons: 0, likes: 0, dislikes: 0, unrated: 0 },
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
  rating: Rating | null
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
 * A title's seasons as a left-to-right strip, tinted by what was thought of
 * each one.
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
): { segments: RibbonSegment[]; hidden: number } {
  const all: RibbonSegment[] = [...group.seasons].reverse().map((row) => ({
    key: row.entry.id,
    label:
      row.entry.season === null || row.entry.season === undefined
        ? 'Whole series'
        : `Season ${row.entry.season}`,
    rating: row.rating,
  }))

  if (all.length <= limit) return { segments: all, hidden: 0 }
  return { segments: all.slice(all.length - limit), hidden: all.length - limit }
}
