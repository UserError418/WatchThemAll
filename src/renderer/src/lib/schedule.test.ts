import { describe, expect, it } from 'vitest'
import type { EpisodeStub, ReleaseTracker } from '@shared/types'
import {
  airDayAt,
  buildTimeline,
  countEpisodes,
  dayHeading,
  daysAgo,
  nextUp,
  seriesRun,
  trackerRows,
  unwatchedCount,
  weekStrip,
} from './schedule'

/**
 * Local noon, so every "is this the same day" assertion is unambiguous about
 * which side of midnight it sits on regardless of the runner's timezone.
 */
const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime()
const DAY = 24 * 60 * 60 * 1000

/** `YYYY-MM-DD` for a day offset from today, built in local time like TMDB's. */
function isoDay(offset: number): string {
  const date = new Date(NOW + offset * DAY)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function stub(over: Partial<EpisodeStub> = {}): EpisodeStub {
  return { season: 2, episode: 7, name: 'Chikhai Bardo', airDate: isoDay(2), ...over }
}

let seq = 0
function tracker(over: Partial<ReleaseTracker> = {}): ReleaseTracker {
  seq += 1
  return {
    id: `t${seq}`,
    tmdbId: 100 + seq,
    title: 'Severance',
    posterPath: '/s.jpg',
    status: 'Returning Series',
    nextEpisode: null,
    lastNotified: null,
    addedAt: 0,
    lastChecked: 0,
    ...over,
  }
}

describe('airDayAt', () => {
  it('parses a TMDB date to local midnight', () => {
    const at = airDayAt('2026-09-20')
    expect(at).not.toBeNull()
    expect(new Date(at!).getHours()).toBe(0)
    expect(new Date(at!).getDate()).toBe(20)
  })

  it('reports nothing for an absent or unusable date', () => {
    expect(airDayAt(null)).toBeNull()
    expect(airDayAt(undefined)).toBeNull()
    expect(airDayAt('soon')).toBeNull()
  })
})

describe('dayHeading', () => {
  const day = (offset: number) => airDayAt(isoDay(offset))!

  it('names the three days a reader actually checks', () => {
    expect(dayHeading(day(0), NOW)).toBe('Today')
    expect(dayHeading(day(1), NOW)).toBe('Tomorrow')
    expect(dayHeading(day(-1), NOW)).toBe('Yesterday')
  })

  it('falls back to a real date, which beats a vague relative one', () => {
    const label = dayHeading(day(5), NOW)
    expect(label).not.toMatch(/Today|Tomorrow|Yesterday/)
    expect(label.length).toBeGreaterThan(0)
  })
})

describe('buildTimeline', () => {
  it('puts a future episode under upcoming', () => {
    const line = buildTimeline([tracker({ schedule: [stub({ airDate: isoDay(3) })] })], { now: NOW })
    expect(countEpisodes(line.upcoming)).toBe(1)
    expect(line.recent).toHaveLength(0)
    expect(line.unscheduled).toHaveLength(0)
  })

  it('puts a past episode under recent', () => {
    const line = buildTimeline([tracker({ schedule: [stub({ airDate: isoDay(-3) })] })], { now: NOW })
    expect(countEpisodes(line.recent)).toBe(1)
    expect(countEpisodes(line.upcoming)).toBe(0)
  })

  /**
   * The mistake this whole module is shaped to avoid. TMDB gives no time of
   * day, so comparing the date against the clock makes an episode airing today
   * read as "aired 12 hours ago" before lunch.
   */
  it('counts an episode airing today as upcoming, not as already aired', () => {
    const line = buildTimeline([tracker({ schedule: [stub({ airDate: isoDay(0) })] })], { now: NOW })
    expect(countEpisodes(line.upcoming)).toBe(1)
    expect(countEpisodes(line.recent)).toBe(0)
    expect(line.upcoming[0]?.isToday).toBe(true)
    expect(line.upcoming[0]?.label).toBe('Today')
  })

  /**
   * The ordering rule the whole page rests on. The view stacks later,
   * upcoming, the now rule, then recent — so if any of the three ran the other
   * way the axis would reverse direction mid-page, which is how this first
   * shipped: tomorrow at the very top, and the two days either side of now as
   * far apart as the page could put them.
   */
  it('returns every half newest first, so the page reads backwards in time', () => {
    const line = buildTimeline(
      [
        tracker({ schedule: [stub({ airDate: isoDay(9) }), stub({ episode: 8, airDate: isoDay(2) })] }),
        tracker({ schedule: [stub({ airDate: isoDay(-8) }), stub({ episode: 8, airDate: isoDay(-2) })] }),
        tracker({ schedule: [stub({ airDate: isoDay(40) }), stub({ episode: 8, airDate: isoDay(60) })] }),
      ],
      { now: NOW },
    )
    expect(line.upcoming.map((d) => d.label)).toEqual([
      dayHeading(airDayAt(isoDay(9))!, NOW),
      dayHeading(airDayAt(isoDay(2))!, NOW),
    ])
    expect(line.later[0]?.at).toBeGreaterThan(line.later[1]!.at)
    expect(line.recent[0]?.at).toBeGreaterThan(line.recent[1]!.at)
  })

  /** The one the view depends on by name: the last upcoming day is the soonest. */
  it('puts the soonest upcoming day last, against the now rule', () => {
    const line = buildTimeline(
      [tracker({ schedule: [stub({ airDate: isoDay(1) }), stub({ episode: 8, airDate: isoDay(6) })] })],
      { now: NOW },
    )
    expect(line.upcoming[line.upcoming.length - 1]?.label).toBe('Tomorrow')
  })

  it('groups several series airing the same day into one marker', () => {
    const line = buildTimeline(
      [
        tracker({ title: 'Zulu', schedule: [stub({ airDate: isoDay(2) })] }),
        tracker({ title: 'Alpha', schedule: [stub({ airDate: isoDay(2) })] }),
      ],
      { now: NOW },
    )
    expect(line.upcoming).toHaveLength(1)
    expect(line.upcoming[0]?.episodes.map((e) => e.title)).toEqual(['Alpha', 'Zulu'])
  })

  it('drops anything older than the window', () => {
    const line = buildTimeline([tracker({ schedule: [stub({ airDate: isoDay(-20) })] })], {
      now: NOW,
      windowDays: 14,
    })
    expect(countEpisodes(line.recent)).toBe(0)
    expect(line.unscheduled).toHaveLength(1)
  })

  it('honours a wider window', () => {
    const line = buildTimeline([tracker({ schedule: [stub({ airDate: isoDay(-20) })] })], {
      now: NOW,
      windowDays: 30,
    })
    expect(countEpisodes(line.recent)).toBe(1)
  })

  /** A record written before 1.6.0 has no `schedule` and must still show up. */
  it('falls back to nextEpisode when there is no schedule', () => {
    const line = buildTimeline([tracker({ nextEpisode: stub({ airDate: isoDay(4) }) })], { now: NOW })
    expect(countEpisodes(line.upcoming)).toBe(1)
    expect(line.unscheduled).toHaveLength(0)
  })

  it('does not list the same episode twice when both sources carry it', () => {
    const episode = stub({ airDate: isoDay(4) })
    const line = buildTimeline([tracker({ schedule: [episode], nextEpisode: { ...episode } })], {
      now: NOW,
    })
    expect(countEpisodes(line.upcoming)).toBe(1)
  })

  it('prefers the season listing, which carries the episode name', () => {
    const line = buildTimeline(
      [
        tracker({
          schedule: [stub({ name: 'Chikhai Bardo', airDate: isoDay(4) })],
          nextEpisode: stub({ name: '', airDate: isoDay(4) }),
        }),
      ],
      { now: NOW },
    )
    expect(line.upcoming[0]?.episodes[0]?.episode.name).toBe('Chikhai Bardo')
  })

  it('files an ended series with nothing scheduled under unscheduled', () => {
    const line = buildTimeline([tracker({ status: 'Ended' })], { now: NOW })
    expect(line.unscheduled).toHaveLength(1)
    expect(line.upcoming).toHaveLength(0)
  })

  /**
   * A series whose next episode is months out has a schedule. Filing it as
   * unscheduled would be a lie, and would hide the one thing being tracked —
   * so it goes to `later`, out of the way but one press from view.
   */
  it('holds a distantly-scheduled series in later, not unscheduled', () => {
    const line = buildTimeline([tracker({ schedule: [stub({ airDate: isoDay(120) })] })], {
      now: NOW,
    })
    expect(line.unscheduled).toHaveLength(0)
    expect(countEpisodes(line.upcoming)).toBe(0)
    expect(countEpisodes(line.later)).toBe(1)
  })

  /**
   * The window reaches both ways. Without a forward horizon the twenty-one
   * tracked series here put 37 episodes above the fold and the recently-aired
   * half — half of what the tab is for — starts below it.
   */
  it('keeps the window symmetric, holding back what is beyond it', () => {
    const line = buildTimeline(
      [
        tracker({ schedule: [stub({ episode: 1, airDate: isoDay(3) })] }),
        tracker({ schedule: [stub({ episode: 2, airDate: isoDay(20) })] }),
      ],
      { now: NOW, windowDays: 14 },
    )
    expect(countEpisodes(line.upcoming)).toBe(1)
    expect(countEpisodes(line.later)).toBe(1)
  })

  it('moves an episode into view when the window widens', () => {
    const trackers = [tracker({ schedule: [stub({ airDate: isoDay(20) })] })]
    expect(countEpisodes(buildTimeline(trackers, { now: NOW, windowDays: 14 }).upcoming)).toBe(0)
    expect(countEpisodes(buildTimeline(trackers, { now: NOW, windowDays: 30 }).upcoming)).toBe(1)
  })

  /** Exactly on the horizon is still inside it. */
  it('includes an episode airing exactly at the horizon', () => {
    const line = buildTimeline([tracker({ schedule: [stub({ airDate: isoDay(14) })] })], {
      now: NOW,
      windowDays: 14,
    })
    expect(countEpisodes(line.upcoming)).toBe(1)
    expect(countEpisodes(line.later)).toBe(0)
  })

  it('ignores episodes TMDB has not dated', () => {
    const line = buildTimeline([tracker({ schedule: [stub({ airDate: null })] })], { now: NOW })
    expect(countEpisodes(line.upcoming)).toBe(0)
    expect(line.unscheduled).toHaveLength(1)
  })

  it('sorts unscheduled series alphabetically', () => {
    const line = buildTimeline(
      [tracker({ title: 'Zulu', status: 'Ended' }), tracker({ title: 'Alpha', status: 'Ended' })],
      { now: NOW },
    )
    expect(line.unscheduled.map((t) => t.title)).toEqual(['Alpha', 'Zulu'])
  })

  it('handles an empty tracker list', () => {
    const line = buildTimeline([], { now: NOW })
    expect(line).toEqual({ upcoming: [], later: [], recent: [], unscheduled: [] })
  })
})

/* ── The rail ───────────────────────────────────────────────────────────── */

/** Nothing has been watched. The common case for a series tracked, not played. */
const unseen = () => false

describe('seriesRun', () => {
  const season = (count: number, first = -3) =>
    Array.from({ length: count }, (_, index) =>
      stub({ season: 3, episode: index + 1, airDate: isoDay(first + index) }),
    )

  it('marks what has aired and what has been seen', () => {
    const t = tracker({ schedule: season(4) })
    const run = seriesRun(t, (_id, _s, e) => e === 1, { now: NOW })
    expect(run.map((r) => r.episode)).toEqual([1, 2, 3, 4])
    expect(run.map((r) => r.aired)).toEqual([true, true, true, false])
    expect(run.map((r) => r.seen)).toEqual([true, false, false, false])
  })

  /** Today's episode has not aired: TMDB gives no hour, so the day is the unit. */
  it('does not count an episode airing today as aired', () => {
    const t = tracker({ schedule: [stub({ season: 3, episode: 1, airDate: isoDay(0) })] })
    expect(seriesRun(t, unseen, { now: NOW })[0]?.aired).toBe(false)
  })

  it('draws only the focused episode’s season', () => {
    const t = tracker({
      schedule: [
        stub({ season: 2, episode: 9, airDate: isoDay(-9) }),
        stub({ season: 3, episode: 1, airDate: isoDay(-2) }),
      ],
    })
    const run = seriesRun(t, unseen, { now: NOW, focus: { season: 2, episode: 9 } })
    expect(run.map((r) => r.season)).toEqual([2])
    expect(run[0]?.focus).toBe(true)
  })

  /** With no focus, the season being tracked is the newest one it holds. */
  it('falls back to the highest season it knows about', () => {
    const t = tracker({
      schedule: [
        stub({ season: 2, episode: 9, airDate: isoDay(-9) }),
        stub({ season: 3, episode: 1, airDate: isoDay(-2) }),
      ],
    })
    expect(seriesRun(t, unseen, { now: NOW }).map((r) => r.season)).toEqual([3])
  })

  /**
   * A long season otherwise always shows its first sixteen, which is the part
   * of the run the reader is least interested in.
   */
  it('slides its window to keep the focused episode visible', () => {
    const t = tracker({ schedule: season(40, -30) })
    const run = seriesRun(t, unseen, { now: NOW, focus: { season: 3, episode: 30 }, limit: 6 })
    expect(run).toHaveLength(6)
    expect(run.some((r) => r.focus)).toBe(true)
  })

  it('clamps the window to the end of the run', () => {
    const t = tracker({ schedule: season(20, -19) })
    const run = seriesRun(t, unseen, { now: NOW, focus: { season: 3, episode: 20 }, limit: 6 })
    expect(run.map((r) => r.episode)).toEqual([15, 16, 17, 18, 19, 20])
  })

  it('has nothing to draw for a series with no dated episodes', () => {
    expect(seriesRun(tracker({ schedule: [stub({ airDate: null })] }), unseen, { now: NOW })).toEqual(
      [],
    )
  })
})

describe('unwatchedCount', () => {
  it('counts aired episodes with no mark against them', () => {
    const t = tracker({
      schedule: [
        stub({ episode: 1, airDate: isoDay(-5) }),
        stub({ episode: 2, airDate: isoDay(-2) }),
        stub({ episode: 3, airDate: isoDay(3) }),
      ],
    })
    expect(unwatchedCount(t, unseen, NOW)).toBe(2)
    expect(unwatchedCount(t, (_id, _s, e) => e === 1, NOW)).toBe(1)
  })

  it('does not count what has not aired yet', () => {
    const t = tracker({ schedule: [stub({ airDate: isoDay(0) }), stub({ episode: 8, airDate: isoDay(4) })] })
    expect(unwatchedCount(t, unseen, NOW)).toBe(0)
  })
})

describe('weekStrip', () => {
  it('covers seven consecutive days starting today, empty ones included', () => {
    const strip = weekStrip([tracker({ schedule: [stub({ airDate: isoDay(2) })] })], NOW)
    expect(strip).toHaveLength(7)
    expect(strip[0]?.isToday).toBe(true)
    expect(strip[0]?.label).toBe('Today')
    expect(strip.map((d) => d.count)).toEqual([0, 0, 1, 0, 0, 0, 0])
  })

  it('adds up several series landing on one day', () => {
    const strip = weekStrip(
      [
        tracker({ schedule: [stub({ airDate: isoDay(1) })] }),
        tracker({ schedule: [stub({ airDate: isoDay(1) })] }),
      ],
      NOW,
    )
    expect(strip[1]?.count).toBe(2)
  })

  it('ignores anything outside the seven days', () => {
    const strip = weekStrip([tracker({ schedule: [stub({ airDate: isoDay(-1) })] })], NOW)
    expect(strip.every((d) => d.count === 0)).toBe(true)
  })
})

describe('trackerRows', () => {
  it('orders by next airing, with the undated ones last', () => {
    const rows = trackerRows(
      [
        tracker({ title: 'Ended', status: 'Ended', schedule: [stub({ airDate: isoDay(-40) })] }),
        tracker({ title: 'Later', schedule: [stub({ airDate: isoDay(9) })] }),
        tracker({ title: 'Sooner', schedule: [stub({ airDate: isoDay(1) })] }),
      ],
      unseen,
      NOW,
    )
    expect(rows.map((r) => r.tracker.title)).toEqual(['Sooner', 'Later', 'Ended'])
    expect(rows[2]?.nextAt).toBeNull()
  })

  /** Today counts as still to come, exactly as the timeline splits it. */
  it('treats an episode airing today as the next one', () => {
    const rows = trackerRows([tracker({ schedule: [stub({ airDate: isoDay(0) })] })], unseen, NOW)
    expect(rows[0]?.nextAt).toBe(airDayAt(isoDay(0)))
  })

  it('carries the unwatched count for each series', () => {
    const rows = trackerRows(
      [tracker({ schedule: [stub({ airDate: isoDay(-3) }), stub({ episode: 8, airDate: isoDay(3) })] })],
      unseen,
      NOW,
    )
    expect(rows[0]?.unwatched).toBe(1)
  })

  it('keeps a series the schedule has nothing dated for', () => {
    const rows = trackerRows([tracker({ schedule: [] })], unseen, NOW)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.next).toBeNull()
  })
})

describe('nextUp', () => {
  /** The lists run furthest-first, so "the next thing" is the last element. */
  it('finds the soonest upcoming episode, which is at the end', () => {
    const line = buildTimeline(
      [
        tracker({ title: 'Far', schedule: [stub({ airDate: isoDay(9) })] }),
        tracker({ title: 'Near', schedule: [stub({ airDate: isoDay(1) })] }),
      ],
      { now: NOW },
    )
    expect(nextUp(line)?.title).toBe('Near')
  })

  it('falls back to the soonest beyond the window when nothing is inside it', () => {
    const line = buildTimeline(
      [
        tracker({ title: 'Far', schedule: [stub({ airDate: isoDay(90) })] }),
        tracker({ title: 'Nearer', schedule: [stub({ airDate: isoDay(30) })] }),
      ],
      { now: NOW, windowDays: 14 },
    )
    expect(nextUp(line)?.title).toBe('Nearer')
  })

  it('reports nothing when nothing is scheduled', () => {
    expect(nextUp(buildTimeline([], { now: NOW }))).toBeNull()
  })
})

describe('how long ago an air day was', () => {
  const midnight = (offset: number): number => airDayAt(isoDay(offset))!

  it('counts whole days back from today', () => {
    expect(daysAgo(midnight(-2), NOW)).toBe('2 days ago')
    expect(daysAgo(midnight(-12), NOW)).toBe('12 days ago')
  })

  it('says nothing for yesterday, whose heading already does', () => {
    expect(daysAgo(midnight(-1), NOW)).toBeNull()
  })

  it('stays a whole number across a clock change', () => {
    // 25 October 2026 is a 25-hour day in Europe; the count must not read 7.04.
    const after = new Date(2026, 9, 28, 12, 0).getTime()
    expect(daysAgo(new Date(2026, 9, 21, 0, 0).getTime(), after)).toBe('7 days ago')
  })
})
