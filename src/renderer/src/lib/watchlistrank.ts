/**
 * How the Watchlist orders and groups itself.
 *
 * The brief was "sorted dynamically by how much and when each entry was last
 * watched". Those are two dimensions and a single sorted list can only express
 * one of them, so they are split: **the band says how far through you are, the
 * order inside the band says when you last touched it.**
 *
 * ## Why both `episodeMarks` and `history` are read
 *
 * Neither is sufficient alone, and picking one is how this would quietly get
 * the wrong answer for half the library:
 *
 * - `episodeMarks` covers everything — a MyAnimeList import, a season ticked
 *   off by hand, a play through the app — and every mark carries its own
 *   timestamp. It is the *only* signal for anything watched outside this app,
 *   which for an imported library is most of it.
 * - `history` carries `playedMs`, the only honest measure of how much time
 *   actually went in, but it exists only for plays made through this app.
 *
 * So `watched`, `total` and `lastAt` come from the marks, `minutes` comes from
 * history, and a title with marks but no history ranks on its marks rather
 * than being treated as untouched.
 *
 * ## Why this is a module and not a `$derived` in the view
 *
 * The interesting cases are all boundaries — exactly at the "nearly finished"
 * threshold, exactly at the staleness cutoff, a series whose episode count
 * TMDB has not supplied yet, a film that has no episodes at all. Those are
 * cheap to pin in a test and nearly impossible to see in a grid.
 */

import type { HistoryEntry, WatchlistEntry } from '@shared/types'
import { playedMs } from './historystats'

/**
 * Past this fraction, a title is "nearly finished" rather than "in progress".
 *
 * 0.85 rather than something tighter because the interesting case is the one
 * where finishing is a single evening's decision, and for a 24-episode season
 * that is the last three or four episodes. A 0.95 threshold would only ever
 * catch the final episode, which nobody needs a band to find.
 */
export const NEARLY = 0.85

/**
 * Days of silence after which a title has been put down rather than paused.
 *
 * Three weeks. Short enough that the "continue" band stays about things
 * genuinely in flight, long enough to survive a holiday or a busy fortnight —
 * which is the failure mode that would matter, because a title demoted while
 * the user still considers it current reads as the app forgetting.
 */
export const STALE_DAYS = 21

const DAY_MS = 24 * 60 * 60 * 1000

/** What is known about the user's engagement with one title. */
export interface Activity {
  /** When anything last happened for this title. 0 when nothing ever has. */
  lastAt: number
  /** Episodes marked watched. Always 0 for a film. */
  watched: number
  /** Episodes in the series, or null until TMDB has said. Null for a film. */
  total: number | null
  /** Real minutes played through this app. 0 for imports and manual marks. */
  minutes: number
  /**
   * How far through, 0–1, or null when it cannot be known.
   *
   * Null is a real answer and not a zero: a 40-episode series with 12 marked
   * but no `episodeCount` yet is not 0% watched, it is *unknown* — and drawing
   * it as 0% would file it under "not started" next to things never opened.
   */
  fraction: number | null
}

export type Band = 'nearly' | 'continue' | 'stalled' | 'fresh'

/** Per-title totals from the play log, built once for the whole list. */
export interface HistoryIndex {
  minutes: Map<number, number>
  lastAt: Map<number, number>
}

/**
 * Summarise the play log by title.
 *
 * Built once and passed in rather than filtered per entry: the log grows
 * without bound while the watchlist does not, so the per-entry scan is the one
 * that gets slow, and it is the one that is easy to avoid.
 */
export function indexHistory(history: readonly HistoryEntry[]): HistoryIndex {
  const minutes = new Map<number, number>()
  const lastAt = new Map<number, number>()

  for (const entry of history) {
    if (!entry.tmdbId) continue
    // `playedMs` clamps implausible durations — a session left open overnight
    // is not eight hours of watching, and would otherwise dominate the sort.
    const ms = playedMs(entry)
    if (ms > 0) minutes.set(entry.tmdbId, (minutes.get(entry.tmdbId) ?? 0) + ms / 60_000)
    lastAt.set(entry.tmdbId, Math.max(lastAt.get(entry.tmdbId) ?? 0, entry.watchedAt))
  }

  return { minutes, lastAt }
}

/** The fields of a watchlist entry this module actually reads. */
export type RankableEntry = Pick<
  WatchlistEntry,
  'tmdbId' | 'type' | 'episodeMarks' | 'watchedEpisodes' | 'episodeCount'
>

/**
 * What is known about one title.
 *
 * `filmPercent` is the resume position for a film, 0–100, or null — passed in
 * rather than looked up so this stays free of the reactive library. Ignored
 * for a series.
 */
export function activityOf(
  entry: RankableEntry,
  index: HistoryIndex,
  filmPercent: number | null = null,
): Activity {
  const minutes = index.minutes.get(entry.tmdbId) ?? 0
  const historyAt = index.lastAt.get(entry.tmdbId) ?? 0

  if (entry.type === 'movie') {
    return {
      lastAt: historyAt,
      watched: 0,
      total: null,
      minutes,
      fraction: filmPercent === null ? null : Math.min(1, Math.max(0, filmPercent / 100)),
    }
  }

  // Marks are the authority on *which* episodes; the legacy list is consulted
  // too because an entry written before marks existed carries only that.
  const keys = new Set<string>()
  let markedAt = 0
  for (const [key, mark] of Object.entries(entry.episodeMarks ?? {})) {
    if (!mark?.watched) continue
    keys.add(key)
    markedAt = Math.max(markedAt, mark.at)
  }
  for (const key of entry.watchedEpisodes ?? []) keys.add(key)

  const watched = keys.size
  const total = entry.episodeCount && entry.episodeCount > 0 ? entry.episodeCount : null

  return {
    lastAt: Math.max(historyAt, markedAt),
    watched,
    total,
    minutes,
    // Capped at 1: a series can carry more marks than TMDB's current episode
    // count after a season is re-numbered, and 140% is not a thing.
    fraction: total === null ? null : Math.min(1, watched / total),
  }
}

/** Whether this title has been started at all. */
function started(activity: Activity): boolean {
  return activity.watched > 0 || activity.minutes > 0 || (activity.fraction ?? 0) > 0
}

/**
 * Which band a title belongs to.
 *
 * Order of tests *is* the design. "Nearly finished" is checked before
 * "continue" on purpose: something both recent and nearly over belongs under
 * the heading that tells you it is nearly over, because that is the more
 * actionable of the two true statements.
 */
export function bandOf(activity: Activity, now = Date.now()): Band {
  if (!started(activity)) return 'fresh'

  const fraction = activity.fraction
  // `< 1` so a finished title does not sit in "nearly finished" forever. It
  // stays in the list — leaving the watchlist is the user's call — but it
  // ranks as stalled or continuing by its own recency.
  if (fraction !== null && fraction >= NEARLY && fraction < 1) return 'nearly'

  if (activity.lastAt > 0 && now - activity.lastAt <= STALE_DAYS * DAY_MS) return 'continue'

  /*
   * Started, but with nothing to date it by. This is the imported library: a
   * MyAnimeList entry can arrive with marks whose timestamps are the import's,
   * or with none at all. "Continue" would overstate it and "not started" is
   * plainly false, so it sits with the things put down a while ago.
   */
  return 'stalled'
}

/**
 * Order within a band: most recently touched first.
 *
 * Recency leads because that is the half of the brief the band cannot express.
 * Minutes break the tie so that two titles touched the same day are ordered by
 * how invested the user is, and the title is the last resort so the sort is
 * total — an unstable order in a grid makes cards swap places on any re-render.
 */
export function compareWithin(
  a: { activity: Activity; title: string },
  b: { activity: Activity; title: string },
): number {
  if (a.activity.lastAt !== b.activity.lastAt) return b.activity.lastAt - a.activity.lastAt
  if (a.activity.minutes !== b.activity.minutes) return b.activity.minutes - a.activity.minutes
  return a.title.localeCompare(b.title)
}

export interface BandedEntry<T> {
  entry: T
  activity: Activity
}

export interface BandGroup<T> {
  band: Band
  label: string
  /** One line under the heading saying what the band means. */
  hint: string
  items: BandedEntry<T>[]
}

/** Headings, in the order they are rendered. An empty band is not shown. */
const BANDS: Array<{ band: Band; label: string; hint: string }> = [
  { band: 'nearly', label: 'Nearly finished', hint: 'A few episodes from the end' },
  { band: 'continue', label: 'Continue watching', hint: 'Picked up in the last few weeks' },
  { band: 'stalled', label: 'Picked up a while ago', hint: 'Started, then set aside' },
  { band: 'fresh', label: 'Not started', hint: 'Saved, still waiting' },
]

/**
 * Group and order a whole watchlist.
 *
 * Generic over the entry so the view can pass its own shape, and so the test
 * does not have to build a full `WatchlistEntry` to check a boundary.
 */
export function bandWatchlist<T extends RankableEntry & { title: string }>(
  entries: readonly T[],
  history: readonly HistoryEntry[],
  filmPercent: (tmdbId: number) => number | null = () => null,
  now = Date.now(),
): BandGroup<T>[] {
  const index = indexHistory(history)

  const placed = entries.map((entry) => {
    const activity = activityOf(entry, index, filmPercent(entry.tmdbId))
    return { entry, activity, band: bandOf(activity, now) }
  })

  return BANDS.map(({ band, label, hint }) => ({
    band,
    label,
    hint,
    items: placed
      .filter((p) => p.band === band)
      .sort((a, b) =>
        compareWithin(
          { activity: a.activity, title: a.entry.title },
          { activity: b.activity, title: b.entry.title },
        ),
      )
      .map(({ entry, activity }) => ({ entry, activity })),
  })).filter((group) => group.items.length > 0)
}
