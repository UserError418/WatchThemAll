/**
 * Turning a list of play events into something a person can read at a glance.
 *
 * All of it is pure and dated by an injected `now`, which is not ceremony: a
 * heatmap's shape depends entirely on where "today" falls in the week, and a
 * streak that reads the wall clock cannot be tested at all. Every function here
 * works in **local** time, because the question the user is asking is "what did
 * I watch on Tuesday evening", and Tuesday evening is a local idea.
 */

import type { HistoryEntry } from '@shared/types'

/** `YYYY-MM-DD` in local time — the key every day-level view groups on. */
export function dayKey(timestamp: number): string {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Midnight at the start of the day containing `timestamp`, local time. */
function startOfDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How long an entry counts for.
 *
 * `playedMs` when the settle recorded one. Entries written before 1.5.3 have
 * none, and neither does a play the app never saw the end of — those count as
 * zero minutes rather than being dropped, because they still happened and the
 * timeline should still show them. Anything absurd is discarded: a forgotten
 * player left open overnight would otherwise dominate every total on the
 * screen.
 */
export const MAX_CREDIBLE_PLAY_MS = 6 * 60 * 60 * 1000

export function playedMs(entry: HistoryEntry): number {
  const played = entry.playedMs
  if (typeof played !== 'number' || !Number.isFinite(played) || played <= 0) return 0
  return Math.min(played, MAX_CREDIBLE_PLAY_MS)
}

/* ── Totals ─────────────────────────────────────────────────────────────── */

export interface HistorySummary {
  /** Total time played, all entries, in milliseconds. */
  totalMs: number
  /** Time played since midnight seven days ago. */
  weekMs: number
  /** Plays recorded, all entries. */
  plays: number
  /** Plays since midnight seven days ago. */
  weekPlays: number
  /**
   * Plays that carry a measured duration.
   *
   * Zero is an ordinary state, not an error: nothing written before 1.5.3 has
   * one, so a library that predates this version has a full history and no
   * times at all. The screen needs to know, because "—" as the headline figure
   * reads as broken where "5 plays recorded" reads as true.
   */
  measured: number
  /** Episodes of television opened. */
  episodes: number
  /** Films opened. */
  films: number
  /** Distinct titles, however many times each was opened. */
  titles: number
  /** Consecutive days up to today with at least one play. */
  streakDays: number
  /** The busiest single day, or null when nothing has been played. */
  busiestDay: { key: string; ms: number } | null
}

export function summarise(history: HistoryEntry[], now = Date.now()): HistorySummary {
  const weekStart = startOfDay(now) - 6 * DAY_MS
  const perDay = new Map<string, number>()
  const titles = new Set<number>()

  let totalMs = 0
  let weekMs = 0
  let weekPlays = 0
  let measured = 0
  let episodes = 0
  let films = 0

  for (const entry of history) {
    const ms = playedMs(entry)
    totalMs += ms
    if (ms > 0) measured += 1
    if (entry.watchedAt >= weekStart) {
      weekMs += ms
      weekPlays += 1
    }
    if (entry.type === 'movie') films += 1
    else episodes += 1
    titles.add(entry.tmdbId)

    const key = dayKey(entry.watchedAt)
    perDay.set(key, (perDay.get(key) ?? 0) + ms)
  }

  let busiestDay: HistorySummary['busiestDay'] = null
  for (const [key, ms] of perDay) {
    if (busiestDay === null || ms > busiestDay.ms) busiestDay = { key, ms }
  }

  return {
    totalMs,
    weekMs,
    plays: history.length,
    weekPlays,
    measured,
    episodes,
    films,
    titles: titles.size,
    streakDays: streak(history, now),
    busiestDay,
  }
}

/**
 * Consecutive days with something played, counting back from today.
 *
 * Yesterday is allowed to be the first day of the streak. Otherwise the number
 * collapses to zero every morning until the user watches something, which reads
 * as having lost a streak they have not lost — it is barely lunchtime.
 */
export function streak(history: HistoryEntry[], now = Date.now()): number {
  const days = new Set(history.map((entry) => dayKey(entry.watchedAt)))
  if (days.size === 0) return 0

  const today = startOfDay(now)
  let cursor = days.has(dayKey(today)) ? today : today - DAY_MS
  if (!days.has(dayKey(cursor))) return 0

  let length = 0
  while (days.has(dayKey(cursor))) {
    length += 1
    cursor -= DAY_MS
  }
  return length
}

/* ── The heatmap ────────────────────────────────────────────────────────── */

export interface HeatDay {
  key: string
  /** Midnight local, for labelling. */
  at: number
  ms: number
  plays: number
  /** 0 for nothing, then 1–4 by how busy the day was against the busiest. */
  level: 0 | 1 | 2 | 3 | 4
  /** Days after today in the final week, which are drawn as blanks. */
  future: boolean
}

/** One column: Monday through Sunday. */
export type HeatWeek = HeatDay[]

/**
 * A calendar grid ending on the week that contains today.
 *
 * Weeks start on Monday, columns run left to right and days run top to bottom,
 * which is the arrangement every tool that draws one of these has converged on
 * — and the reason is that a year fits in a strip a few centimetres tall.
 *
 * Levels are relative to the user's own busiest day rather than to fixed
 * minute thresholds. Someone who watches twenty minutes a night should see a
 * lit calendar, not a uniformly faint one; the shape of the habit is what the
 * grid is for, not the absolute quantity, which the totals above it already
 * give in plain numbers.
 */
export function heatmap(history: HistoryEntry[], now = Date.now(), weeks = 26): HeatWeek[] {
  const perDay = new Map<string, { ms: number; plays: number }>()
  for (const entry of history) {
    const key = dayKey(entry.watchedAt)
    const bucket = perDay.get(key) ?? { ms: 0, plays: 0 }
    bucket.ms += playedMs(entry)
    bucket.plays += 1
    perDay.set(key, bucket)
  }

  let busiest = 0
  for (const { ms } of perDay.values()) busiest = Math.max(busiest, ms)

  // Monday of the week containing today. `getDay()` is 0 for Sunday.
  const today = startOfDay(now)
  const weekday = (new Date(today).getDay() + 6) % 7
  const lastMonday = today - weekday * DAY_MS
  const firstMonday = lastMonday - (weeks - 1) * 7 * DAY_MS

  const grid: HeatWeek[] = []
  for (let week = 0; week < weeks; week += 1) {
    const column: HeatWeek = []
    for (let day = 0; day < 7; day += 1) {
      const at = firstMonday + (week * 7 + day) * DAY_MS
      const key = dayKey(at)
      const bucket = perDay.get(key)
      const ms = bucket?.ms ?? 0
      column.push({
        key,
        at,
        ms,
        plays: bucket?.plays ?? 0,
        level: heatLevel(ms, bucket?.plays ?? 0, busiest),
        future: at > today,
      })
    }
    grid.push(column)
  }
  return grid
}

/**
 * A day with plays but no measured time still lights up, faintly.
 *
 * Every entry written before 1.5.3 is in that position, and so is every play on
 * a provider that reports nothing and was left inside the fallback window. A
 * grid that showed them as empty would tell the user their history had been
 * thrown away, which is the opposite of true.
 */
function heatLevel(ms: number, plays: number, busiest: number): HeatDay['level'] {
  if (plays === 0) return 0
  if (ms <= 0 || busiest <= 0) return 1
  const share = ms / busiest
  if (share > 0.75) return 4
  if (share > 0.5) return 3
  if (share > 0.25) return 2
  return 1
}

/* ── The timeline ───────────────────────────────────────────────────────── */

export interface HistoryDay {
  key: string
  /** Midnight local, for the heading. */
  at: number
  entries: HistoryEntry[]
  ms: number
}

/** Group a newest-first history into newest-first days. */
export function groupByDay(history: HistoryEntry[]): HistoryDay[] {
  const days = new Map<string, HistoryDay>()

  for (const entry of history) {
    const key = dayKey(entry.watchedAt)
    let day = days.get(key)
    if (day === undefined) {
      day = { key, at: startOfDay(entry.watchedAt), entries: [], ms: 0 }
      days.set(key, day)
    }
    day.entries.push(entry)
    day.ms += playedMs(entry)
  }

  return [...days.values()].sort((a, b) => b.at - a.at)
}

/* ── Words ──────────────────────────────────────────────────────────────── */

/**
 * A duration a person would say out loud.
 *
 * Never "0h 7m" and never "72 minutes": the unit that leads is the largest one
 * that is not zero, and seconds only ever appear on their own, because "1h 5m
 * 12s" is a stopwatch reading rather than an answer to how long something was
 * watched for.
 */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}m`
  if (minutes === 0) return `${hours}h`
  return `${hours}h ${minutes}m`
}

/** `21:04`, in the user's own locale and clock convention. */
export function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** "Today", "Yesterday", or "Tuesday, 9 September" — with the year if it is old. */
export function dayLabel(at: number, now = Date.now()): string {
  const today = startOfDay(now)
  if (at === today) return 'Today'
  if (at === today - DAY_MS) return 'Yesterday'

  const date = new Date(at)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/** "9 Sep" — the compact form the heatmap's tooltip uses. */
export function shortDate(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * How far through the title this play got, 0–1, or null when nothing knows.
 *
 * Deliberately the *position* rather than the time played: skipping the recap
 * and watching to the credits is finishing an episode, and thirty minutes spent
 * rewinding the same scene is not.
 */
export function completion(entry: HistoryEntry): number | null {
  const seconds = entry.seconds
  const total = entry.duration
  if (typeof seconds !== 'number' || typeof total !== 'number') return null
  if (!Number.isFinite(seconds) || !Number.isFinite(total) || total <= 0) return null
  return Math.max(0, Math.min(1, seconds / total))
}

/* ── When in the day ────────────────────────────────────────────────────── */

export interface HourBucket {
  hour: number
  /** Plays *started* in this hour. What the bar height is. */
  plays: number
  /** Time played by those plays. For the tooltip; never for the ranking. */
  ms: number
  /** 0–1 against the busiest hour, so the view never divides by zero. */
  share: number
}

/**
 * The twenty-four hours of the day, however many plays started in each.
 *
 * The calendar above it answers "which days", and cannot answer "which part of
 * the day" — a Tuesday square is the same square whether it was an hour at
 * breakfast or four hours after midnight. This is the other axis of the same
 * habit, and it is the one that surprises people.
 *
 * Bucketed by the hour a play **started**, not by the hours it covered.
 * Splitting a play across the hours it ran through would be more precise and
 * would need an end time the entry does not carry; an entry knows when it was
 * opened, and "when do you sit down to watch" is the question anyway.
 *
 * ## Counted in plays, not minutes
 *
 * Weighting by duration was the first cut and it was incoherent with the
 * bucketing: a play started at 23:00 and run for three hours credited all
 * three to 23:00. On the real history it was worse than incoherent — a single
 * forgotten player, capped at six hours by `playedMs`, made 07:00 the peak of
 * a panel captioned "most of it starts around", against one play ever started
 * at that hour. Counting starts says exactly what the panel claims, and is
 * immune to both.
 *
 * `ms` is still carried, for the tooltip, where it is a fact about that hour
 * rather than a ranking of it.
 */
export function byHour(history: readonly HistoryEntry[]): HourBucket[] {
  const buckets: HourBucket[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    plays: 0,
    ms: 0,
    share: 0,
  }))

  for (const entry of history) {
    const bucket = buckets[new Date(entry.watchedAt).getHours()]
    if (bucket === undefined) continue
    bucket.plays += 1
    bucket.ms += playedMs(entry)
  }

  const peak = Math.max(...buckets.map((bucket) => bucket.plays))
  if (peak > 0) for (const bucket of buckets) bucket.share = bucket.plays / peak
  return buckets
}

/** The busiest hour, or null when nothing has been watched. */
export function peakHour(buckets: readonly HourBucket[]): HourBucket | null {
  let best: HourBucket | null = null
  for (const bucket of buckets) {
    if (bucket.plays === 0) continue
    if (best === null || bucket.share > best.share) best = bucket
  }
  return best
}

/** "20:00–21:00", in the reader's own clock convention. */
export function hourLabel(hour: number): string {
  const start = new Date()
  start.setHours(hour, 0, 0, 0)
  const end = new Date(start.getTime() + 60 * 60 * 1000)
  const format = (date: Date): string =>
    date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return `${format(start)}–${format(end)}`
}

/* ── What, most ─────────────────────────────────────────────────────────── */

export interface TitleTotal {
  tmdbId: number
  title: string
  posterPath: string | null
  plays: number
  ms: number
  /** 0–1 against the leader, for the bar width. */
  share: number
}

/**
 * The titles the most time has gone into, longest first.
 *
 * Keyed by `tmdbId`, so eleven episodes of one series are one bar rather than
 * eleven — which is the entire difference between this and the timeline below
 * it. A `tmdbId` of 0 is the unresolved-import case and would otherwise fold
 * every one of them into a single bar with a borrowed name, so those key on
 * their title instead.
 *
 * Ranked by time where any is known and by play count where none is, matching
 * `byHour`, so the two panels never disagree about which is the busier.
 */
export function topTitles(history: readonly HistoryEntry[], limit = 8): TitleTotal[] {
  const totals = new Map<string, TitleTotal>()
  let timed = false

  for (const entry of history) {
    const key = entry.tmdbId ? `t${entry.tmdbId}` : `n${entry.title}`
    const ms = playedMs(entry)
    if (ms > 0) timed = true

    const row = totals.get(key)
    if (row === undefined) {
      totals.set(key, {
        tmdbId: entry.tmdbId,
        title: entry.title,
        posterPath: entry.posterPath,
        plays: 1,
        ms,
        share: 0,
      })
    } else {
      row.plays += 1
      row.ms += ms
      row.posterPath ??= entry.posterPath
    }
  }

  const weight = (row: TitleTotal): number => (timed ? row.ms : row.plays)
  const ranked = [...totals.values()]
    .sort((a, b) => weight(b) - weight(a) || a.title.localeCompare(b.title))
    .slice(0, limit)

  const leader = ranked.length > 0 ? weight(ranked[0]!) : 0
  if (leader > 0) for (const row of ranked) row.share = weight(row) / leader
  return ranked
}
