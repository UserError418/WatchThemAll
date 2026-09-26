/**
 * The arithmetic behind the History tab.
 *
 * Every one of these takes an explicit `now`, which is the only reason they can
 * be tested: a streak, a heatmap and the word "Yesterday" are all statements
 * about where the wall clock happens to be standing.
 */

import { describe, expect, it } from 'vitest'

import type { HistoryEntry } from '@shared/types'
import {
  MAX_CREDIBLE_PLAY_MS,
  clockTime,
  completion,
  dayKey,
  dayLabel,
  duration,
  byHour,
  groupByDay,
  heatmap,
  longestStreak,
  peakHour,
  playedMs,
  streak,
  summarise,
  tileDetail,
  topTitles,
} from './historystats'

/** Midday, so that nothing here is an hour away from changing date. */
const NOON = new Date(2026, 8, 13, 12, 0, 0).getTime() // Sunday 13 September 2026
const DAY = 24 * 60 * 60 * 1000
const MINUTE = 60_000

let counter = 0
function entry(at: number, patch: Partial<HistoryEntry> = {}): HistoryEntry {
  counter += 1
  return {
    id: `h${counter}`,
    tmdbId: 1,
    type: 'tv',
    title: 'Silo',
    posterPath: null,
    season: 1,
    episode: 1,
    watchedAt: at,
    ...patch,
  }
}

describe('how long a play counts for', () => {
  it('counts an entry with no measurement as zero, not as missing', () => {
    // Every entry written before 1.5.3 is in this position, and so is every
    // play the app never saw the end of. They still happened.
    expect(playedMs(entry(NOON))).toBe(0)
  })

  it('caps a player left open overnight', () => {
    const forgotten = entry(NOON, { playedMs: 14 * 60 * 60 * 1000 })
    expect(playedMs(forgotten)).toBe(MAX_CREDIBLE_PLAY_MS)
  })

  it('ignores a negative or broken measurement', () => {
    expect(playedMs(entry(NOON, { playedMs: -5 }))).toBe(0)
    expect(playedMs(entry(NOON, { playedMs: Number.NaN }))).toBe(0)
  })
})

describe('the totals', () => {
  it('separates the week from all time', () => {
    const history = [
      entry(NOON, { playedMs: 30 * MINUTE }),
      entry(NOON - 3 * DAY, { playedMs: 20 * MINUTE }),
      // Eight days back: inside "all time", outside the last seven days.
      entry(NOON - 8 * DAY, { playedMs: 45 * MINUTE }),
    ]
    const summary = summarise(history, NOON)

    expect(summary.totalMs).toBe(95 * MINUTE)
    expect(summary.weekMs).toBe(50 * MINUTE)
  })

  it('counts distinct titles, not plays', () => {
    const history = [
      entry(NOON, { tmdbId: 7, episode: 1 }),
      entry(NOON - MINUTE, { tmdbId: 7, episode: 2 }),
      entry(NOON - 2 * MINUTE, { tmdbId: 9 }),
      entry(NOON - 3 * MINUTE, { tmdbId: 9, type: 'movie', season: null, episode: null }),
    ]
    const summary = summarise(history, NOON)

    expect(summary.titles).toBe(2)
    expect(summary.episodes).toBe(3)
    expect(summary.films).toBe(1)
  })

  it('counts plays separately from measured plays', () => {
    // A library from before 1.5.3 has a full history and no durations. The
    // screen shows counts in that case, so it has to be able to tell.
    const history = [entry(NOON), entry(NOON - DAY), entry(NOON - 30 * DAY)]
    const summary = summarise(history, NOON)

    expect(summary.plays).toBe(3)
    expect(summary.weekPlays).toBe(2)
    expect(summary.measured).toBe(0)
    expect(summary.totalMs).toBe(0)
  })

  it('counts a play as measured only once it has a duration', () => {
    const history = [entry(NOON, { playedMs: 10 * MINUTE }), entry(NOON - DAY)]
    expect(summarise(history, NOON).measured).toBe(1)
  })

  it('names the busiest day', () => {
    const history = [
      entry(NOON, { playedMs: 10 * MINUTE }),
      entry(NOON - DAY, { playedMs: 40 * MINUTE }),
      entry(NOON - DAY - MINUTE, { playedMs: 5 * MINUTE }),
    ]
    expect(summarise(history, NOON).busiestDay).toEqual({
      key: dayKey(NOON - DAY),
      ms: 45 * MINUTE,
    })
  })

  it('says nothing about a busiest day when there is no history', () => {
    expect(summarise([], NOON).busiestDay).toBeNull()
  })
})

describe('the streak', () => {
  it('counts consecutive days back from today', () => {
    const history = [entry(NOON), entry(NOON - DAY), entry(NOON - 2 * DAY)]
    expect(streak(history, NOON)).toBe(3)
  })

  it('survives a morning that has not been watched yet', () => {
    // Otherwise the number collapses every day at midnight and reads as a
    // streak lost, at half past nine, before anybody has sat down.
    const history = [entry(NOON - DAY), entry(NOON - 2 * DAY)]
    expect(streak(history, NOON)).toBe(2)
  })

  it('is broken by a missed day', () => {
    const history = [entry(NOON), entry(NOON - 2 * DAY), entry(NOON - 3 * DAY)]
    expect(streak(history, NOON)).toBe(1)
  })

  it('is zero when nothing was watched yesterday or today', () => {
    expect(streak([entry(NOON - 3 * DAY)], NOON)).toBe(0)
    expect(streak([], NOON)).toBe(0)
  })
})

describe('the heatmap', () => {
  it('ends on the week containing today, with weeks starting on Monday', () => {
    const grid = heatmap([], NOON, 4)

    expect(grid).toHaveLength(4)
    const lastWeek = grid[3]!
    expect(lastWeek).toHaveLength(7)
    // 13 September 2026 is a Sunday, so it is the last cell of the last column.
    expect(new Date(lastWeek[0]!.at).getDay()).toBe(1)
    expect(lastWeek[6]!.key).toBe(dayKey(NOON))
  })

  it('marks days after today so they can be drawn as blanks', () => {
    // A Wednesday: the rest of that week has not happened yet.
    const wednesday = new Date(2026, 8, 9, 12).getTime()
    const grid = heatmap([], wednesday, 2)
    const thisWeek = grid[1]!

    expect(thisWeek.filter((day) => day.future)).toHaveLength(4)
    expect(thisWeek[2]!.future).toBe(false)
  })

  it('scales levels against the user’s own busiest day', () => {
    // Twenty minutes a night should light the calendar up. Fixed thresholds
    // would render the whole thing uniformly faint and say nothing.
    const history = [
      entry(NOON, { playedMs: 20 * MINUTE }),
      entry(NOON - DAY, { playedMs: 5 * MINUTE }),
    ]
    const grid = heatmap(history, NOON, 2)
    const days = grid.flat()

    expect(days.find((d) => d.key === dayKey(NOON))?.level).toBe(4)
    expect(days.find((d) => d.key === dayKey(NOON - DAY))?.level).toBe(1)
  })

  it('lights a day that has plays but no measured time', () => {
    // Every pre-1.5.3 entry, and every silent provider inside the fallback
    // window. Drawing them as empty would look like the history was lost.
    const grid = heatmap([entry(NOON)], NOON, 1)
    expect(grid.flat().find((d) => d.key === dayKey(NOON))?.level).toBe(1)
  })
})

describe('the timeline', () => {
  it('groups into days, newest first, keeping the order within a day', () => {
    const evening = entry(NOON, { title: 'Silo' })
    const morning = entry(NOON - 4 * 60 * MINUTE, { title: 'The Office' })
    const yesterday = entry(NOON - DAY, { title: 'The Mentalist' })

    const days = groupByDay([evening, morning, yesterday])

    expect(days.map((d) => d.entries.map((e) => e.title))).toEqual([
      ['Silo', 'The Office'],
      ['The Mentalist'],
    ])
  })

  it('totals each day', () => {
    const days = groupByDay([
      entry(NOON, { playedMs: 10 * MINUTE }),
      entry(NOON - MINUTE, { playedMs: 5 * MINUTE }),
    ])
    expect(days[0]?.ms).toBe(15 * MINUTE)
  })
})

describe('the words', () => {
  it('leads with the largest unit that is not zero', () => {
    expect(duration(0)).toBe('—')
    expect(duration(42_000)).toBe('42s')
    expect(duration(7 * MINUTE)).toBe('7m')
    expect(duration(60 * MINUTE)).toBe('1h')
    expect(duration(85 * MINUTE)).toBe('1h 25m')
  })

  it('names today and yesterday', () => {
    const midnight = new Date(2026, 8, 13).getTime()
    expect(dayLabel(midnight, NOON)).toBe('Today')
    expect(dayLabel(midnight - DAY, NOON)).toBe('Yesterday')
    expect(dayLabel(midnight - 3 * DAY, NOON)).toMatch(/Thursday/)
  })

  it('formats a clock time', () => {
    expect(clockTime(new Date(2026, 8, 13, 21, 4).getTime())).toMatch(/\d{1,2}[:.]04/)
  })
})

describe('how far through it got', () => {
  it('uses the position, not the time played', () => {
    // Skipping the recap and watching to the credits is finishing an episode.
    expect(completion(entry(NOON, { seconds: 2400, duration: 2600, playedMs: 60_000 }))).toBeCloseTo(
      0.923,
      2,
    )
  })

  it('says nothing when the provider reported nothing', () => {
    expect(completion(entry(NOON, { playedMs: 60_000 }))).toBeNull()
    expect(completion(entry(NOON, { seconds: 100, duration: 0 }))).toBeNull()
  })

  it('never reports more than the whole', () => {
    expect(completion(entry(NOON, { seconds: 3000, duration: 2600 }))).toBe(1)
  })
})

/* ── When in the day ──────────────────────────────────────────────────── */

/** A local timestamp at `hour` on the day `offset` days from NOON's. */
function hourOn(offset: number, hour: number): number {
  return new Date(2026, 8, 13 + offset, hour, 30, 0).getTime()
}

describe('byHour', () => {
  it('buckets plays by the hour they started, in local time', () => {
    const buckets = byHour([
      entry(hourOn(0, 21), { playedMs: 20 * MINUTE }),
      entry(hourOn(-1, 21), { playedMs: 40 * MINUTE }),
      entry(hourOn(-1, 9), { playedMs: 10 * MINUTE }),
    ])
    expect(buckets).toHaveLength(24)
    expect(buckets[21]?.plays).toBe(2)
    expect(buckets[21]?.ms).toBe(60 * MINUTE)
    expect(buckets[9]?.plays).toBe(1)
    expect(buckets[0]?.plays).toBe(0)
  })

  it('scales every bar against the busiest hour', () => {
    const buckets = byHour([entry(hourOn(0, 21)), entry(hourOn(-1, 21)), entry(hourOn(-1, 9))])
    expect(buckets[21]?.share).toBe(1)
    expect(buckets[9]?.share).toBe(0.5)
  })

  /**
   * The case this panel got wrong on real data. One player left open at
   * breakfast, capped at six hours by `playedMs`, outweighed a hundred
   * evenings and made 07:00 the peak of a panel captioned "most of it starts
   * around" — against a single play ever started at that hour.
   */
  it('counts plays, so one forgotten player cannot become the peak', () => {
    const buckets = byHour([
      entry(hourOn(0, 7), { playedMs: 6 * 60 * MINUTE }),
      entry(hourOn(0, 20), { playedMs: 22 * MINUTE }),
      entry(hourOn(-1, 20), { playedMs: 24 * MINUTE }),
    ])
    expect(peakHour(buckets)?.hour).toBe(20)
    expect(buckets[7]?.ms).toBe(6 * 60 * MINUTE)
  })

  it('has no shape to draw for an empty history', () => {
    expect(byHour([]).every((bucket) => bucket.share === 0)).toBe(true)
  })
})

describe('peakHour', () => {
  it('finds the hour the most is started in', () => {
    const buckets = byHour([entry(hourOn(0, 20)), entry(hourOn(-1, 20)), entry(hourOn(0, 8))])
    expect(peakHour(buckets)?.hour).toBe(20)
  })

  it('reports nothing when nothing has been watched', () => {
    expect(peakHour(byHour([]))).toBeNull()
  })
})

/* ── What, most ───────────────────────────────────────────────────────── */

describe('topTitles', () => {
  it('folds every play of one title into a single row', () => {
    const rows = topTitles([
      entry(NOON, { tmdbId: 1, title: 'Bleach', playedMs: 20 * MINUTE }),
      entry(NOON, { tmdbId: 1, title: 'Bleach', playedMs: 20 * MINUTE }),
      entry(NOON, { tmdbId: 2, title: 'K-PAX', playedMs: 30 * MINUTE }),
    ])
    expect(rows.map((r) => r.title)).toEqual(['Bleach', 'K-PAX'])
    expect(rows[0]?.plays).toBe(2)
    expect(rows[0]?.ms).toBe(40 * MINUTE)
    expect(rows[0]?.share).toBe(1)
    expect(rows[1]?.share).toBe(0.75)
  })

  /**
   * Every unresolved import carries tmdbId 0. Keyed on that alone they would
   * collapse into one bar wearing whichever name happened to come first.
   */
  it('keeps unresolved titles apart, which all share tmdbId 0', () => {
    const rows = topTitles([
      entry(NOON, { tmdbId: 0, title: 'One', playedMs: MINUTE }),
      entry(NOON, { tmdbId: 0, title: 'Two', playedMs: MINUTE }),
    ])
    expect(rows).toHaveLength(2)
  })

  it('ranks by play count when nothing carries a time', () => {
    const rows = topTitles([
      entry(NOON, { tmdbId: 1, title: 'Once' }),
      entry(NOON, { tmdbId: 2, title: 'Twice' }),
      entry(NOON, { tmdbId: 2, title: 'Twice' }),
    ])
    expect(rows.map((r) => r.title)).toEqual(['Twice', 'Once'])
  })

  it('honours the limit', () => {
    const rows = topTitles(
      Array.from({ length: 12 }, (_, i) => entry(NOON, { tmdbId: i + 1, title: `T${i}` })),
      5,
    )
    expect(rows).toHaveLength(5)
  })

  it('takes artwork from whichever play carries it', () => {
    const rows = topTitles([
      entry(NOON, { tmdbId: 1, title: 'Bleach', posterPath: null }),
      entry(NOON, { tmdbId: 1, title: 'Bleach', posterPath: '/b.jpg' }),
    ])
    expect(rows[0]?.posterPath).toBe('/b.jpg')
  })

  it('handles an empty history', () => {
    expect(topTitles([])).toEqual([])
  })
})

describe('what the tiles say under their figures', () => {
  it('lays the last seven days out oldest first, today last', () => {
    const detail = tileDetail([entry(NOON, { playedMs: 30 * MINUTE }), entry(NOON - 2 * DAY)], NOON)
    expect(detail.week.map((d) => dayKey(d.at))).toEqual([
      '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13',
    ])
    expect(detail.week[6]).toMatchObject({ isToday: true, ms: 30 * MINUTE, plays: 1 })
    expect(detail.week[4]).toMatchObject({ isToday: false, plays: 1 })
  })

  it('counts the seven days before separately, and nothing older', () => {
    const detail = tileDetail(
      [
        entry(NOON - 8 * DAY, { playedMs: 20 * MINUTE }),
        entry(NOON - 13 * DAY, { playedMs: 10 * MINUTE }),
        entry(NOON - 20 * DAY, { playedMs: 99 * MINUTE }),
      ],
      NOON,
    )
    expect(detail.previousWeekMs).toBe(30 * MINUTE)
    expect(detail.previousWeekPlays).toBe(2)
  })

  it('averages only episodes that were timed, and names the latest film', () => {
    const detail = tileDetail(
      [
        entry(NOON, { playedMs: 40 * MINUTE }),
        entry(NOON - DAY, { playedMs: 20 * MINUTE }),
        entry(NOON - DAY), // untimed: not a zero-minute episode
        entry(NOON - 3 * DAY, { type: 'movie', title: 'Dune' }),
        entry(NOON - 5 * DAY, { type: 'movie', title: 'Heat' }),
      ],
      NOON,
    )
    expect(detail.episodeMeanMs).toBe(30 * MINUTE)
    expect(detail.latestFilm).toBe('Dune')
    expect(detail.since).toBe(NOON - 5 * DAY)
  })

  it('says nothing rather than zero for an empty history', () => {
    const detail = tileDetail([], NOON)
    expect(detail).toMatchObject({ since: null, episodeMeanMs: null, latestFilm: null, longestStreak: 0 })
  })
})

describe('the longest streak', () => {
  it('finds the best run, not the current one', () => {
    const days = [0, 1, 2, 10, 11, 12, 13, 14, 20].map((d) => entry(NOON - d * DAY))
    expect(longestStreak(days)).toBe(5)
  })

  it('counts several plays on one day once', () => {
    expect(longestStreak([entry(NOON), entry(NOON + MINUTE), entry(NOON - DAY)])).toBe(2)
  })

  it('does not break across a clock change', () => {
    // Europe moves its clocks on 25 October 2026; a 23- or 25-hour day must
    // not end a run.
    const around = [24, 25, 26, 27].map((d) => entry(new Date(2026, 9, d, 21, 0).getTime()))
    expect(longestStreak(around)).toBe(4)
  })
})
