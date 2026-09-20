/**
 * The Releases timeline: what lands when, and what just landed.
 *
 * Deliberately not the History tab's shape. That one answers "how much have I
 * watched lately" and a heat grid is the right tool for it — density over
 * time, no individual event worth naming. This answers "what airs when", where
 * every single event is the point and the exact day matters. A schedule, not a
 * density plot.
 *
 * ## Dates here have no time of day
 *
 * TMDB gives air dates as `YYYY-MM-DD` with no clock and no zone. Every one of
 * them is therefore parsed to **local midnight**, matching what `format.ts`
 * already does for the countdown, and every comparison in here is between
 * whole local days. Comparing a date-only value against `Date.now()` directly
 * is what makes an episode airing today read as "aired 14 hours ago" before
 * lunch, and the split between "upcoming" and "recent" is exactly where that
 * mistake would show.
 *
 * So the rule is stated once and applied everywhere: **an episode whose air
 * day is today or later is upcoming; strictly earlier is recent.** Today's
 * episodes sit at the head of the timeline rather than at the top of the past,
 * which is also the honest answer — TMDB has not said what hour they air.
 */

import type { EpisodeStub, ReleaseTracker } from '@shared/types'

const DAY_MS = 24 * 60 * 60 * 1000

/** How far back the "recently aired" half reaches. The view offers these. */
export const WINDOWS = [7, 14, 30] as const
export type WindowDays = (typeof WINDOWS)[number]

/** Midnight at the start of the local day containing `timestamp`. */
function startOfDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Local midnight of a `YYYY-MM-DD` air date, or null when it is unusable. */
export function airDayAt(date: string | null | undefined): number | null {
  if (!date) return null
  const parsed = new Date(`${date}T00:00:00`).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

export interface TimelineEpisode {
  tmdbId: number
  title: string
  posterPath: string | null
  episode: EpisodeStub
  /** Local midnight of the air day. */
  airAt: number
}

export interface TimelineDay {
  /** Stable `{#each}` key, and what days are grouped by. */
  key: string
  at: number
  /** "Today", "Tomorrow", "Yesterday", or "Fri 26 Sep". */
  label: string
  isToday: boolean
  episodes: TimelineEpisode[]
}

export interface Timeline {
  /** Soonest first, within the window. Today's episodes lead. */
  upcoming: TimelineDay[]
  /**
   * Scheduled beyond the window, soonest first.
   *
   * Held back rather than dropped. A real tracker list puts 37 episodes over
   * the next four weeks on this page, and with all of them inline the user has
   * to scroll past every one to reach what aired yesterday — which is half of
   * what the tab is for. These stay one press away.
   */
  later: TimelineDay[]
  /** Most recent first, back as far as the window. */
  recent: TimelineDay[]
  /** Tracked series with nothing in any of the three — ended, or undated. */
  unscheduled: ReleaseTracker[]
}

/** "Fri 26 Sep" — short enough to sit inline on a timeline spine. */
function compactDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

/**
 * The heading for one day.
 *
 * The three relative labels earn their place: they are the days a user reads
 * the tab to check, and "Today" is scanned faster than any date ever is.
 * Beyond that a real date is more useful than "in 4 days", which the per-row
 * countdown already says more precisely.
 */
export function dayHeading(at: number, now = Date.now()): string {
  const today = startOfDay(now)
  if (at === today) return 'Today'
  if (at === today + DAY_MS) return 'Tomorrow'
  if (at === today - DAY_MS) return 'Yesterday'
  return compactDate(at)
}

/**
 * Every episode a tracker can contribute.
 *
 * `nextEpisode` is folded in alongside `schedule` so a record written before
 * 1.6.0 — or one whose season fetch failed — still puts its next episode on
 * the timeline instead of dropping into "not scheduled". Deduplicated by
 * season and episode, because the two sources overlap by design.
 */
function episodesOf(tracker: ReleaseTracker): EpisodeStub[] {
  const byNumber = new Map<string, EpisodeStub>()
  for (const episode of tracker.schedule ?? []) {
    byNumber.set(`${episode.season}:${episode.episode}`, episode)
  }
  if (tracker.nextEpisode) {
    const key = `${tracker.nextEpisode.season}:${tracker.nextEpisode.episode}`
    // `schedule` wins a collision: it came from the season listing, which
    // carries the episode name where `nextEpisode` sometimes does not.
    if (!byNumber.has(key)) byNumber.set(key, tracker.nextEpisode)
  }
  return [...byNumber.values()]
}

function toDays(episodes: TimelineEpisode[], now: number, ascending: boolean): TimelineDay[] {
  const byDay = new Map<number, TimelineEpisode[]>()
  for (const episode of episodes) {
    const bucket = byDay.get(episode.airAt)
    if (bucket) bucket.push(episode)
    else byDay.set(episode.airAt, [episode])
  }

  const today = startOfDay(now)
  return [...byDay.entries()]
    .sort(([a], [b]) => (ascending ? a - b : b - a))
    .map(([at, list]) => ({
      key: String(at),
      at,
      label: dayHeading(at, now),
      isToday: at === today,
      // Several series can air on one day; title order is the only one that is
      // stable, since TMDB gives no times to sort by.
      episodes: list.sort(
        (a, b) =>
          a.title.localeCompare(b.title) ||
          a.episode.season - b.episode.season ||
          a.episode.episode - b.episode.episode,
      ),
    }))
}

/**
 * Split the tracked series into a timeline.
 *
 * The window reaches equally in both directions — it is "how far either side
 * of now am I looking", not just how far back. Forward matters as much:
 * twenty-one tracked series put 37 episodes across the next four weeks, and
 * with all of them inline the recently-aired half starts below the fold.
 * What is beyond the window goes to `later` rather than being lost.
 *
 * A tracker appears in `unscheduled` only when it contributes *nothing* to any
 * of the three — so a series whose next episode is four months out is in
 * `later`, not filed as unscheduled, which would be a lie about a series that
 * has a schedule.
 */
export function buildTimeline(
  trackers: readonly ReleaseTracker[],
  options: { now?: number; windowDays?: number } = {},
): Timeline {
  const now = options.now ?? Date.now()
  const windowDays = options.windowDays ?? 14
  const today = startOfDay(now)
  const floor = today - windowDays * DAY_MS
  const horizon = today + windowDays * DAY_MS

  const upcoming: TimelineEpisode[] = []
  const later: TimelineEpisode[] = []
  const recent: TimelineEpisode[] = []
  const unscheduled: ReleaseTracker[] = []

  for (const tracker of trackers) {
    let placed = 0

    for (const episode of episodesOf(tracker)) {
      const airAt = airDayAt(episode.airDate)
      if (airAt === null) continue

      const item: TimelineEpisode = {
        tmdbId: tracker.tmdbId,
        title: tracker.title,
        posterPath: tracker.posterPath,
        episode,
        airAt,
      }

      if (airAt > horizon) {
        later.push(item)
        placed += 1
      } else if (airAt >= today) {
        upcoming.push(item)
        placed += 1
      } else if (airAt >= floor) {
        recent.push(item)
        placed += 1
      }
      // Older than the window: real, but not what this view is about.
    }

    if (placed === 0) unscheduled.push(tracker)
  }

  return {
    upcoming: toDays(upcoming, now, true),
    later: toDays(later, now, true),
    recent: toDays(recent, now, false),
    unscheduled: unscheduled.sort((a, b) => a.title.localeCompare(b.title)),
  }
}

/** How many episodes a half of the timeline holds, for the section counts. */
export function countEpisodes(days: readonly TimelineDay[]): number {
  return days.reduce((total, day) => total + day.episodes.length, 0)
}
