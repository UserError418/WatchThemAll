import { describe, expect, it, vi } from 'vitest'
import type { Episode, ReleaseTracker, StoreShape } from '@shared/types'
import { checkAll, needsSchedule, scheduleWindow, type SweepableStore } from './releases'
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

  /** A store over a plain list, with `put` stamping nothing: the sweep's writes are what matter. */
  function storeOf(trackers: ReleaseTracker[]): SweepableStore & { trackers: ReleaseTracker[]; puts: ReleaseTracker[] } {
    const state = {
      trackers,
      puts: [] as ReleaseTracker[],
      read: () => ({ trackers: state.trackers }) as unknown as StoreShape,
      collection: () => ({
        put: (next: ReleaseTracker) => {
          state.puts.push(next)
          state.trackers = state.trackers.map((t) => (t.id === next.id ? next : t))
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
})
