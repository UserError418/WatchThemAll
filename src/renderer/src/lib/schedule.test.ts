import { describe, expect, it } from 'vitest'
import type { EpisodeStub, ReleaseTracker } from '@shared/types'
import { airDayAt, buildTimeline, countEpisodes, dayHeading } from './schedule'

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

  it('sorts upcoming soonest first and recent newest first', () => {
    const line = buildTimeline(
      [
        tracker({ schedule: [stub({ airDate: isoDay(9) }), stub({ episode: 8, airDate: isoDay(2) })] }),
        tracker({ schedule: [stub({ airDate: isoDay(-8) }), stub({ episode: 8, airDate: isoDay(-2) })] }),
      ],
      { now: NOW },
    )
    expect(line.upcoming.map((d) => d.label)).toEqual([dayHeading(airDayAt(isoDay(2))!, NOW), dayHeading(airDayAt(isoDay(9))!, NOW)])
    expect(line.recent[0]?.at).toBeGreaterThan(line.recent[1]!.at)
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
   * unscheduled would be a lie, and would hide the one thing being tracked.
   */
  it('does not call a distantly-scheduled series unscheduled', () => {
    const line = buildTimeline([tracker({ schedule: [stub({ airDate: isoDay(120) })] })], {
      now: NOW,
    })
    expect(line.unscheduled).toHaveLength(0)
    expect(countEpisodes(line.upcoming)).toBe(1)
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
    expect(line).toEqual({ upcoming: [], recent: [], unscheduled: [] })
  })
})
