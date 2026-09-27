/**
 * The positions file: what one sync of it takes, keeps and sends, and the
 * throttle that paces those syncs during playback.
 */

import { describe, expect, it, vi } from 'vitest'

import { syncPositions, recentPoints, type PositionsDocument, type PositionsHost } from './positions'
import { throttle, type ThrottleClock } from './throttle'
import type { RemoteDocument, SyncBackend } from './types'
import type { RecordOf } from '../store/document'

type Point = RecordOf<'resumePoints'>

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

const point = (key: string, seconds: number, updatedAt: number, deletedAt: number | null = null): Point => ({
  key,
  tmdbId: 1,
  seconds,
  duration: 3000,
  updatedAt,
  deletedAt,
})

function hostWith(points: Point[]): PositionsHost & { points: Point[]; adoptions: number } {
  const host = {
    points,
    adoptions: 0,
    read: () => host.points,
    adopt: (next: Point[]) => {
      host.points = next
      host.adoptions += 1
    },
  }
  return host
}

function backendWith(document: unknown | null): SyncBackend<PositionsDocument> & { pushed: PositionsDocument[] } {
  const backend = {
    pushed: [] as PositionsDocument[],
    pull: async (): Promise<RemoteDocument<PositionsDocument> | null> =>
      document === null ? null : { document: document as PositionsDocument, version: null },
    push: async (next: PositionsDocument) => {
      backend.pushed.push(next)
    },
  }
  return backend
}

describe('syncPositions', () => {
  /** The whole point: the other device's newer position arrives. */
  it('takes a newer position from the file', async () => {
    const host = hostWith([point('tv:1:1:1', 600, NOW - 60_000)])
    const backend = backendWith({ positions: 1, resumePoints: [point('tv:1:1:1', 1500, NOW - 5_000)] })

    const outcome = await syncPositions(host, backend, NOW)

    expect(outcome).toEqual({ adopted: true, pushed: false })
    expect(host.points[0]!.seconds).toBe(1500)
  })

  it('sends its own newer position and takes nothing older', async () => {
    const host = hostWith([point('tv:1:1:1', 1500, NOW - 5_000)])
    const backend = backendWith({ positions: 1, resumePoints: [point('tv:1:1:1', 600, NOW - 60_000)] })

    const outcome = await syncPositions(host, backend, NOW)

    expect(outcome).toEqual({ adopted: false, pushed: true })
    expect(backend.pushed[0]!.resumePoints[0]!.seconds).toBe(1500)
  })

  it('writes nothing when both sides already agree', async () => {
    const same = [point('tv:1:1:1', 1500, NOW - 5_000)]
    const host = hostWith(same)
    const backend = backendWith({ positions: 1, resumePoints: same })

    expect(await syncPositions(host, backend, NOW)).toEqual({ adopted: false, pushed: false })
    expect(host.adoptions).toBe(0)
  })

  /** A finished episode's point is deleted; the deletion has to travel too. */
  it('carries a deletion both ways', async () => {
    const host = hostWith([point('tv:1:1:1', 1500, NOW - 60_000)])
    const backend = backendWith({ positions: 1, resumePoints: [point('tv:1:1:1', 1500, NOW - 5_000, NOW - 5_000)] })

    await syncPositions(host, backend, NOW)
    expect(host.points[0]!.deletedAt).toBe(NOW - 5_000)
  })

  it('creates the file on the first sync', async () => {
    const host = hostWith([point('tv:1:1:1', 1500, NOW - 5_000)])
    const backend = backendWith(null)

    expect(await syncPositions(host, backend, NOW)).toEqual({ adopted: false, pushed: true })
  })

  /** The file lives in the user's Drive, where anything can edit it. */
  it('drops records it could not have written, and mends the file', async () => {
    const host = hostWith([])
    const backend = backendWith({
      positions: 1,
      resumePoints: [{ key: 'tv:1:1:1', seconds: 'soon' }, point('movie:2:m:m', 900, NOW - 1_000)],
    })

    await syncPositions(host, backend, NOW)
    expect(host.points.map((p) => p.key)).toEqual(['movie:2:m:m'])
    expect(backend.pushed[0]!.resumePoints.map((p) => p.key)).toEqual(['movie:2:m:m'])
  })

  it('treats an unreadable file as empty', async () => {
    const host = hostWith([point('tv:1:1:1', 1500, NOW - 5_000)])
    const backend = backendWith({ something: 'else' })

    expect(await syncPositions(host, backend, NOW)).toEqual({ adopted: false, pushed: true })
  })

  /** Old points stay in the library file; this one only carries the recent ones. */
  it('sends only what changed inside the window', async () => {
    const host = hostWith([point('old', 900, NOW - 40 * DAY), point('new', 900, NOW - DAY)])
    const backend = backendWith(null)

    await syncPositions(host, backend, NOW)
    expect(backend.pushed[0]!.resumePoints.map((p) => p.key)).toEqual(['new'])
    // And keeps the old one here: leaving the file is not a deletion.
    expect(host.points.map((p) => p.key)).toEqual(['old', 'new'])
  })
})

describe('recentPoints', () => {
  it('keeps tombstones inside the window, so deletions travel', () => {
    expect(recentPoints([point('gone', 0, NOW - DAY, NOW - DAY)], NOW)).toHaveLength(1)
  })
})

describe('throttle', () => {
  function fakeClock(): ThrottleClock & { advance(ms: number): void } {
    let now = 0
    let timers: Array<{ at: number; callback: () => void; id: number }> = []
    let nextId = 0
    return {
      now: () => now,
      setTimeout: (callback, ms) => {
        const id = ++nextId
        timers.push({ at: now + ms, callback, id })
        return id
      },
      clearTimeout: (id) => {
        timers = timers.filter((t) => t.id !== id)
      },
      advance(ms) {
        now += ms
        const due = timers.filter((t) => t.at <= now)
        timers = timers.filter((t) => t.at > now)
        for (const t of due) t.callback()
      },
    }
  }

  it('runs the first request at once, then at most once per interval', () => {
    const clock = fakeClock()
    const task = vi.fn()
    const t = throttle(task, 10_000, clock)

    t.request()
    expect(task).toHaveBeenCalledTimes(1)

    // Positions arriving every five seconds while something plays.
    for (let i = 0; i < 6; i++) {
      clock.advance(5_000)
      t.request()
    }
    expect(task).toHaveBeenCalledTimes(4)
  })

  /** The reason this is not a debounce: the last position must still go out. */
  it('carries out a request made inside the interval when it ends', () => {
    const clock = fakeClock()
    const task = vi.fn()
    const t = throttle(task, 10_000, clock)

    t.request()
    clock.advance(2_000)
    t.request()
    expect(task).toHaveBeenCalledTimes(1)
    clock.advance(8_000)
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('runs at once when told to, and drops the waiting run', () => {
    const clock = fakeClock()
    const task = vi.fn()
    const t = throttle(task, 10_000, clock)

    t.request()
    clock.advance(1_000)
    t.request()
    t.now()
    expect(task).toHaveBeenCalledTimes(2)
    clock.advance(20_000)
    expect(task).toHaveBeenCalledTimes(2)
  })
})
