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
 *
 * ## One axis, and it only runs one way
 *
 * Every day list here is returned **newest first**, upcoming included. That is
 * not a preference, it is what makes the page a timeline at all: the view
 * stacks `later`, then `upcoming`, then the now rule, then `recent`, so
 * reading downwards is reading backwards through time without interruption.
 *
 * The first cut had `upcoming` ascending, which put tomorrow at the very top
 * of the page and the last day before *now* a thousand pixels above it — the
 * axis reversed direction at the rule, and the two episodes closest to this
 * moment, which are the whole point of the tab, ended up as far apart as the
 * page could put them.
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
  /**
   * Within the window, **furthest away first** — so the last day in the list
   * is today or tomorrow, immediately above the now rule. See the axis rule in
   * the module header.
   */
  upcoming: TimelineDay[]
  /**
   * Scheduled beyond the window, furthest away first.
   *
   * Held back rather than dropped. A real tracker list puts 37 episodes over
   * the next four weeks on this page, and with all of them inline the user has
   * to scroll past every one to reach what aired yesterday — which is half of
   * what the tab is for. These stay one press away.
   *
   * Ordered like `upcoming` and rendered *above* it, because everything in
   * here is further from now than everything in there.
   */
  later: TimelineDay[]
  /** Most recent first, back as far as the window. */
  recent: TimelineDay[]
  /** Tracked series with nothing in any of the three — ended, or undated. */
  unscheduled: ReleaseTracker[]
}

/** "Fri 26 Sep" — short enough to sit inline on a timeline spine. */
export function compactDate(at: number): string {
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
 * How long ago a past air day was, for the line under its heading.
 *
 * Whole days, because an air date has no time of day. Null for yesterday,
 * whose heading already says exactly that. This replaced `timeAgo`, which
 * turns into a locale date after a week — so an older day read "Wed 16 Sep"
 * over "9/16/2026", the same fact twice.
 */
export function daysAgo(at: number, now = Date.now()): string | null {
  // Rounded rather than floored: across a clock change a day is 23 or 25
  // hours, and the difference between two midnights is not a whole number.
  const days = Math.round((startOfDay(now) - at) / DAY_MS)
  if (days <= 1) return null
  return `${days} days ago`
}

/**
 * Every episode a tracker can contribute.
 *
 * `nextEpisode` is folded in alongside `schedule` so a record written before
 * 1.6.0 — or one whose season fetch failed — still puts its next episode on
 * the timeline instead of dropping into "not scheduled". Deduplicated by
 * season and episode, because the two sources overlap by design.
 */
export function episodesOf(tracker: ReleaseTracker): EpisodeStub[] {
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
    // All three descending: one axis, running backwards down the page.
    upcoming: toDays(upcoming, now, false),
    later: toDays(later, now, false),
    recent: toDays(recent, now, false),
    unscheduled: unscheduled.sort((a, b) => a.title.localeCompare(b.title)),
  }
}

/** How many episodes a half of the timeline holds, for the section counts. */
export function countEpisodes(days: readonly TimelineDay[]): number {
  return days.reduce((total, day) => total + day.episodes.length, 0)
}

/* ── The rail: what the timeline cannot say in a column of days ─────────── */

/**
 * Whether one episode has been marked watched.
 *
 * Injected rather than imported so everything in this file stays pure and
 * testable. The view passes `library.isWatched`.
 */
export type SeenFn = (tmdbId: number, season: number, episode: number) => boolean

export interface RunSegment {
  key: string
  season: number
  episode: number
  /** Aired strictly before today, matching the `recent` half of the split. */
  aired: boolean
  seen: boolean
  /** The episode this run was drawn around, drawn taller. */
  focus: boolean
}

/**
 * How many segments a run strip draws before it starts sliding its window.
 *
 * Sixteen because that is what fits in the width a timeline row has spare at
 * 1280px without the segments becoming a texture. Past that the strip stops
 * saying "you are three from the end" and starts saying "this is a long
 * series", which the title already said.
 */
export const RUN_LIMIT = 16

/**
 * The current season as a row of segments: aired, seen, and where this episode
 * sits among them.
 *
 * This is what fills the middle of a timeline row, and it is the one thing on
 * the page that answers "am I keeping up" without the user opening anything.
 * It is deliberately the same visual idiom as the Watchlist card's episode
 * pips — one series, one meaning, on both surfaces.
 */
export function seriesRun(
  tracker: ReleaseTracker,
  seen: SeenFn,
  options: {
    now?: number
    focus?: { season: number; episode: number } | null
    limit?: number
  } = {},
): RunSegment[] {
  const now = options.now ?? Date.now()
  const limit = options.limit ?? RUN_LIMIT
  const today = startOfDay(now)

  const dated = episodesOf(tracker).filter((episode) => airDayAt(episode.airDate) !== null)
  if (dated.length === 0) return []

  // The season in play: the one the focused episode belongs to, else the
  // highest the schedule knows about. A tracker mid-way through a season
  // changeover carries both, and the new one is the one being tracked.
  const season = options.focus?.season ?? Math.max(...dated.map((e) => e.season))
  const run = dated
    .filter((episode) => episode.season === season)
    .sort((a, b) => a.episode - b.episode)

  const segments = run.map((episode) => ({
    key: `${episode.season}:${episode.episode}`,
    season: episode.season,
    episode: episode.episode,
    aired: (airDayAt(episode.airDate) ?? 0) < today,
    seen: seen(tracker.tmdbId, episode.season, episode.episode),
    focus:
      options.focus != null &&
      options.focus.season === episode.season &&
      options.focus.episode === episode.episode,
  }))

  if (segments.length <= limit) return segments

  // Slide the window so the focused episode stays in it. Without this a long
  // season always shows its first sixteen, which is the part of the run the
  // user is least interested in.
  const anchor = segments.findIndex((segment) => segment.focus)
  const centre = anchor >= 0 ? anchor : segments.length - 1
  const start = Math.max(0, Math.min(segments.length - limit, centre - Math.floor(limit / 2)))
  return segments.slice(start, start + limit)
}

/**
 * Episodes of a tracked series that have aired and carry no watched mark.
 *
 * Says "unwatched", not "behind", and the difference is not pedantry: a series
 * the user watches elsewhere and only tracks here has no marks at all, so
 * "behind" would be an accusation the app cannot support. Counted across every
 * season the schedule holds, which is the fortnight-ish either side of now.
 */
export function unwatchedCount(
  tracker: ReleaseTracker,
  seen: SeenFn,
  now = Date.now(),
): number {
  const today = startOfDay(now)
  let count = 0
  for (const episode of episodesOf(tracker)) {
    const airAt = airDayAt(episode.airDate)
    if (airAt === null || airAt >= today) continue
    if (!seen(tracker.tmdbId, episode.season, episode.episode)) count += 1
  }
  return count
}

export interface StripDay {
  key: string
  at: number
  /** A single letter — "M", "T" — because the strip is seven columns wide. */
  letter: string
  /** The full label, for the tooltip and the screen reader. */
  label: string
  count: number
  isToday: boolean
}

/**
 * The next seven days as a bar strip: how many episodes land on each.
 *
 * The timeline below it only draws days that have something on them, which is
 * right for a list and loses the shape — four episodes on Saturday and nothing
 * until Wednesday reads as "two days" there and as an actual week here.
 */
export function weekStrip(
  trackers: readonly ReleaseTracker[],
  now = Date.now(),
  days = 7,
): StripDay[] {
  const today = startOfDay(now)
  const counts = new Map<number, number>()

  for (const tracker of trackers) {
    for (const episode of episodesOf(tracker)) {
      const airAt = airDayAt(episode.airDate)
      if (airAt === null) continue
      counts.set(airAt, (counts.get(airAt) ?? 0) + 1)
    }
  }

  const strip: StripDay[] = []
  for (let offset = 0; offset < days; offset += 1) {
    const at = today + offset * DAY_MS
    const date = new Date(at)
    strip.push({
      key: String(at),
      at,
      letter: date.toLocaleDateString(undefined, { weekday: 'narrow' }),
      label: dayHeading(at, now),
      count: counts.get(at) ?? 0,
      isToday: offset === 0,
    })
  }
  return strip
}

export interface TrackerRow {
  tracker: ReleaseTracker
  /** Local midnight of its next airing, or null when it has none scheduled. */
  nextAt: number | null
  next: EpisodeStub | null
  unwatched: number
}

/**
 * Every tracked series in one list, soonest first, the undated ones last.
 *
 * One list rather than the timeline's three buckets, because the question it
 * answers is different: the timeline is "what happens on Thursday", this is
 * "what am I tracking, and is any of it alive". A series that has ended
 * belongs on it — quietly, at the bottom, but present, because the only other
 * way to find out it is still being tracked is to notice it never appears.
 */
export function trackerRows(
  trackers: readonly ReleaseTracker[],
  seen: SeenFn,
  now = Date.now(),
): TrackerRow[] {
  const today = startOfDay(now)

  const rows = trackers.map((tracker) => {
    let next: EpisodeStub | null = null
    let nextAt: number | null = null

    for (const episode of episodesOf(tracker)) {
      const airAt = airDayAt(episode.airDate)
      if (airAt === null || airAt < today) continue
      if (nextAt === null || airAt < nextAt) {
        nextAt = airAt
        next = episode
      }
    }

    return { tracker, nextAt, next, unwatched: unwatchedCount(tracker, seen, now) }
  })

  return rows.sort((a, b) => {
    if (a.nextAt === null && b.nextAt === null) {
      return a.tracker.title.localeCompare(b.tracker.title)
    }
    if (a.nextAt === null) return 1
    if (b.nextAt === null) return -1
    return a.nextAt - b.nextAt || a.tracker.title.localeCompare(b.tracker.title)
  })
}

/**
 * The single soonest episode, for the rail's headline.
 *
 * Reads the *end* of the day lists because they run furthest-first — the one
 * place in the app where "the next thing" is the last element, and worth
 * saying out loud since it is exactly the kind of thing a later edit silently
 * turns back into `[0]`.
 */
export function nextUp(timeline: Timeline): TimelineEpisode | null {
  const days = timeline.upcoming.length > 0 ? timeline.upcoming : timeline.later
  return days[days.length - 1]?.episodes[0] ?? null
}
