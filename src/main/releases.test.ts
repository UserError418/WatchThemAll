import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Episode, ReleaseTracker, StoreShape } from '@shared/types'
import { checkAll, needsSchedule, scheduleWindow, startReleaseTimer, sweepDueIn, type SweepableStore } from './releases'
import * as tmdb from './tmdb'

vi.mock('./tmdb', () => ({ detail: vi.fn(), season: vi.fn(), search: vi.fn() }))

const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime()
const DAY = 24 * 60 * 60 * 1000

/** `YYYY-MM-DD` for a day offset from today, in local time like TMDB's. */
function isoDay(offset: number): string {
  const date = new Date(NOW + offset * DAY)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function episode(over: Partial<Episode> = {}): Episode {
  return {
    season: 2,
    episode: 1,
    name: 'Cold Harbor',
    airDate: isoDay(0),
    overview: 'a long paragraph of prose',
    stillPath: '/still.jpg',
    runtime: 42,
    rating: 8.1,
    ...over,
  } as Episode
}

describe('scheduleWindow', () => {
  it('keeps episodes around now and drops the rest', () => {
    const kept = scheduleWindow(
      [
        episode({ episode: 1, airDate: isoDay(-200) }),
        episode({ episode: 2, airDate: isoDay(-10) }),
        episode({ episode: 3, airDate: isoDay(10) }),
        episode({ episode: 4, airDate: isoDay(400) }),
      ],
      NOW,
    )
    expect(kept.map((e) => e.episode)).toEqual([2, 3])
  })

  /**
   * This document syncs over Drive on every change. Keeping the overview and
   * still path would put a paragraph of prose per episode into it, for fields
   * the timeline never draws.
   */
  it('trims to the four fields the timeline uses', () => {
    const [stub] = scheduleWindow([episode()], NOW)
    expect(Object.keys(stub!).sort()).toEqual(['airDate', 'episode', 'name', 'season'])
  })

  it('ignores episodes TMDB has not dated', () => {
    expect(scheduleWindow([episode({ airDate: null })], NOW)).toEqual([])
  })

  it('ignores a date it cannot parse', () => {
    expect(scheduleWindow([episode({ airDate: 'someday' })], NOW)).toEqual([])
  })

  it('handles a season with no episodes', () => {
    expect(scheduleWindow([], NOW)).toEqual([])
  })
})

describe('needsSchedule', () => {
  it('fetches when nothing is stored', () => {
    expect(needsSchedule({}, 2, NOW)).toBe(true)
    expect(needsSchedule({ schedule: [] }, 2, NOW)).toBe(true)
  })

  it('fetches when the series has moved to a season it does not cover', () => {
    const stored = { schedule: [{ season: 1, episode: 8, name: '', airDate: isoDay(7) }] }
    expect(needsSchedule(stored, 2, NOW)).toBe(true)
  })

  /**
   * The steady state, and the reason this check exists: a weekly show whose
   * dates are already known must not cost a request on every hourly sweep to
   * re-learn the same answer.
   */
  it('does not fetch while the stored season still has episodes to come', () => {
    const stored = { schedule: [{ season: 2, episode: 7, name: '', airDate: isoDay(4) }] }
    expect(needsSchedule(stored, 2, NOW)).toBe(false)
  })

  /** How a schedule that has run out is told from one that is still current. */
  it('fetches again once everything stored has aired', () => {
    const stored = { schedule: [{ season: 2, episode: 7, name: '', airDate: isoDay(-4) }] }
    expect(needsSchedule(stored, 2, NOW)).toBe(true)
  })

  /** Today's episode has not aired yet as far as TMDB's date-only value says. */
  it('treats an episode airing today as still to come', () => {
    const stored = { schedule: [{ season: 2, episode: 7, name: '', airDate: isoDay(0) }] }
    expect(needsSchedule(stored, 2, NOW)).toBe(false)
  })

  it('fetches when the stored entries carry no usable dates', () => {
    const stored = { schedule: [{ season: 2, episode: 7, name: '', airDate: null }] }
    expect(needsSchedule(stored, 2, NOW)).toBe(true)
  })
})

describe('checkAll', () => {
  const tracker = (id: string, tmdbId: number): ReleaseTracker => ({
    id,
    tmdbId,
    title: `Series ${tmdbId}`,
    posterPath: null,
    status: 'Returning Series',
    nextEpisode: null,
    lastNotified: { season: 1, episode: 1, airDate: '2026-01-01', name: 'One' },
    addedAt: 1,
    lastChecked: 0,
  })

  /** A store over a plain list, with `putMany` stamping nothing: the sweep's writes are what matter. */
  function storeOf(trackers: ReleaseTracker[]): SweepableStore & { trackers: ReleaseTracker[]; puts: ReleaseTracker[]; writes: number } {
    const state = {
      trackers,
      puts: [] as ReleaseTracker[],
      writes: 0,
      read: () => ({ trackers: state.trackers, settings: { releaseCheckMinutes: 60 } }) as unknown as StoreShape,
      collection: () => ({
        putMany: (batch: ReleaseTracker[]) => {
          state.writes += 1
          for (const next of batch) {
            state.puts.push(next)
            state.trackers = state.trackers.map((t) => (t.id === next.id ? next : t))
          }
        },
      }),
    }
    return state
  }

  function detailWithNewEpisode(onFetch?: () => void) {
    vi.mocked(tmdb.detail).mockImplementation(async () => {
      onFetch?.()
      return {
        status: 'Returning Series',
        nextEpisode: null,
        lastEpisode: { season: 1, episode: 2, airDate: '2026-02-01', name: 'Two' },
        posterPath: null,
        title: 'Series',
      } as unknown as Awaited<ReturnType<typeof tmdb.detail>>
    })
    vi.mocked(tmdb.season).mockResolvedValue({ episodes: [] } as unknown as Awaited<ReturnType<typeof tmdb.season>>)
  }

  /**
   * The bug: the sweep wrote back the tracker it read at the start, and the
   * store's `put` revives a deleted record. A series untracked while TMDB was
   * answering came back, and was announced.
   */
  it('does not bring back, or announce, a series untracked mid-check', async () => {
    const store = storeOf([tracker('a', 1)])
    detailWithNewEpisode(() => {
      store.trackers = []
    })

    const notices = await checkAll(store)

    expect(store.puts).toEqual([])
    expect(notices).toEqual([])
  })

  it('writes only what it checked onto the tracker as it now stands', async () => {
    const store = storeOf([tracker('a', 1)])
    detailWithNewEpisode(() => {
      // Something else changed the record while TMDB answered.
      store.trackers = [{ ...store.trackers[0]!, addedAt: 99 }]
    })

    const notices = await checkAll(store)

    expect(notices).toHaveLength(1)
    expect(store.puts[0]!.addedAt).toBe(99)
    expect(store.puts[0]!.lastNotified).toMatchObject({ season: 1, episode: 2 })
  })

  it('runs one sweep at a time, and a joiner announces nothing', async () => {
    const store = storeOf([tracker('a', 1)])
    detailWithNewEpisode()

    const [first, second] = await Promise.all([checkAll(store), checkAll(store)])

    expect(first).toHaveLength(1)
    expect(second).toEqual([])
    expect(vi.mocked(tmdb.detail).mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(store.puts).toHaveLength(1)
  })

  /** Every tracker's `lastChecked` moves, so one write per tracker was a full save each. */
  it('writes every checked tracker in one go', async () => {
    const store = storeOf([tracker('a', 1), tracker('b', 2), tracker('c', 3)])
    detailWithNewEpisode()

    const notices = await checkAll(store)

    expect(store.writes).toBe(1)
    expect(store.puts.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(notices).toHaveLength(3)
  })

  it('leaves out, and does not announce, a series untracked after its check', async () => {
    const store = storeOf([tracker('a', 1), tracker('b', 2)])
    let calls = 0
    detailWithNewEpisode(() => {
      // Untracked while the *next* series is being checked.
      if (++calls === 2) store.trackers = store.trackers.filter((t) => t.id !== 'a')
    })

    const notices = await checkAll(store)

    expect(store.puts.map((t) => t.id)).toEqual(['b'])
    expect(notices).toHaveLength(1)
  })

  describe('startReleaseTimer', () => {
    const MINUTE = 60 * 1000

    afterEach(() => {
      vi.useRealTimers()
    })

    /** Trackers last checked this long ago, and a timer started over them. */
    function started(checkedAgo: number) {
      vi.useFakeTimers({ now: NOW })
      vi.mocked(tmdb.detail).mockClear()
      detailWithNewEpisode()
      const store = storeOf([{ ...tracker('a', 1), lastChecked: NOW - checkedAgo }])
      const stop = startReleaseTimer(store, () => {})
      return { store, stop }
    }

    /** The waste this replaced: every launch swept every series. */
    it('does not sweep on launch when the last sweep is recent', async () => {
      const { stop } = started(10 * MINUTE)

      await vi.advanceTimersByTimeAsync(49 * MINUTE)
      expect(tmdb.detail).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2 * MINUTE)
      expect(tmdb.detail).toHaveBeenCalledTimes(1)
      stop()
    })

    it('sweeps shortly after launch when one is due', async () => {
      const { stop } = started(3 * 60 * MINUTE)

      await vi.advanceTimersByTimeAsync(14_000)
      expect(tmdb.detail).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2_000)
      expect(tmdb.detail).toHaveBeenCalledTimes(1)
      stop()
    })

    it('keeps sweeping once an interval', async () => {
      const { stop } = started(3 * 60 * MINUTE)

      await vi.advanceTimersByTimeAsync(16_000 + 3 * 60 * MINUTE)
      expect(tmdb.detail).toHaveBeenCalledTimes(4)
      stop()
    })

    it('stops', async () => {
      const { stop } = started(3 * 60 * MINUTE)
      stop()

      await vi.advanceTimersByTimeAsync(2 * 60 * MINUTE)
      expect(tmdb.detail).not.toHaveBeenCalled()
    })
  })
})

describe('sweepDueIn', () => {
  const HOUR = 60 * 60 * 1000
  const checked = (...agos: number[]) => agos.map((ago) => ({ lastChecked: NOW - ago }))

  it('is the rest of the interval after a recent sweep', () => {
    expect(sweepDueIn(checked(10 * 60 * 1000), HOUR, NOW)).toBe(50 * 60 * 1000)
  })

  it('is now once the interval has passed', () => {
    expect(sweepDueIn(checked(2 * HOUR), HOUR, NOW)).toBe(0)
  })

  /** A series added or synced in since the last sweep is not left waiting. */
  it('goes by the oldest check', () => {
    expect(sweepDueIn([...checked(60 * 1000), { lastChecked: 0 }], HOUR, NOW)).toBe(0)
  })

  it('never waits longer than one interval, whatever another clock stamped', () => {
    expect(sweepDueIn(checked(-5 * HOUR), HOUR, NOW)).toBe(HOUR)
  })

  it('waits an interval when there is nothing to check', () => {
    expect(sweepDueIn([], HOUR, NOW)).toBe(HOUR)
  })
})
