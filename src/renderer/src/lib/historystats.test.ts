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
  groupByDay,
  heatmap,
  playedMs,
  streak,
  summarise,
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
