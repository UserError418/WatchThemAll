/**
 * Playback positions, on their own small file and their own quick schedule.
 *
 * ## Why a second file
 *
 * The library file is the whole library, about 570 KB, and Drive can only
 * replace a file, never patch one. Pushing it every ten seconds while
 * something plays would be some 200 MB an hour of upload from a phone. The
 * positions are what changes that often, and all of them together are a few
 * kilobytes. So they travel on their own: this file is pushed within about
 * ten seconds of the position changing, and pulled before a title resumes,
 * while the library keeps its own, calmer schedule.
 *
 * ## What it holds, and what it does not
 *
 * Only resume points changed in the last `WINDOW_MS`, tombstones included.
 * That keeps it small however long the library grows. It is a fast channel
 * for recent changes, not a second copy of the truth: the library file still
 * carries every resume point, and an older build that knows nothing of this
 * file still gets every position through it, just later.
 *
 * Both are merged by the same per-record rule (`mergeResumePoints`), so a
 * position that arrives by both routes, or by one route twice, settles the
 * same way. A record's absence from this file says nothing about it.
 */

import { mergeResumePoints } from '../store/merge'
import type { RecordOf } from '../store/document'
import type { FetchLike } from './devicecode'
import { createDriveBackend } from './drive'
import { CoalescingRunner } from './engine'
import type { SyncBackend } from './types'

/** The filename in the user's Drive, next to the library. */
export const POSITIONS_NAME = 'WatchThemAll positions.json'

/** How far back the file reaches. Anything older is in the library file. */
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000

type Point = RecordOf<'resumePoints'>

export interface PositionsDocument {
  /** Marks the file for what it is; bumped only if the shape ever changes. */
  positions: 1
  resumePoints: Point[]
}

export interface PositionsHost {
  /** Every resume point this device holds, tombstones included. */
  read(): Point[]
  /** Take the merged points as they are, stamps and tombstones included. */
  adopt(points: Point[]): void | Promise<void>
}

export interface PositionsOutcome {
  /** This device took something the other one had written. */
  adopted: boolean
  /** The file was written. */
  pushed: boolean
}

/**
 * Whether a record from the file is one this app could have written.
 *
 * Anything else is dropped rather than merged: the file is in the user's own
 * Drive, where anything can be edited, and one malformed record merged in
 * would be written to the library and pushed back out from there.
 */
function isPoint(value: unknown): value is Point {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return (
    typeof r.key === 'string' &&
    typeof r.tmdbId === 'number' &&
    typeof r.seconds === 'number' &&
    Number.isFinite(r.seconds) &&
    typeof r.duration === 'number' &&
    Number.isFinite(r.duration) &&
    typeof r.updatedAt === 'number' &&
    (r.deletedAt === null || typeof r.deletedAt === 'number')
  )
}

/** The points worth carrying: whatever changed inside the window. */
export function recentPoints(points: readonly Point[], now: number): Point[] {
  return points.filter((point) => point.updatedAt >= now - WINDOW_MS)
}

/**
 * One positions sync: pull, merge, keep what is new, push what the file lacks.
 *
 * The same shape as the library's `syncOnce`, on a document small enough that
 * doing the whole round trip every ten seconds costs next to nothing: with
 * the backend's checksum cache, an unchanged file is one listing request, and
 * a change is that plus a few kilobytes up.
 */
export async function syncPositions(
  host: PositionsHost,
  backend: SyncBackend<PositionsDocument>,
  now = Date.now(),
): Promise<PositionsOutcome> {
  const local = host.read()
  const remote = await backend.pull()
  const incoming = Array.isArray(remote?.document?.resumePoints)
    ? remote.document.resumePoints.filter(isPoint)
    : []

  const merged = mergeResumePoints(local, incoming)
  const adopted = JSON.stringify(merged) !== JSON.stringify(local)
  if (adopted) await host.adopt(merged)

  const outgoing: PositionsDocument = { positions: 1, resumePoints: recentPoints(merged, now) }
  const pushed = remote === null || JSON.stringify(outgoing) !== JSON.stringify(remote.document)
  if (pushed) await backend.push(outgoing, remote?.version ?? null)

  return { adopted, pushed }
}

export interface PositionsChannelOptions {
  host: PositionsHost
  /** A token that is valid now; the sync service's own. */
  accessToken: () => Promise<string>
  fetchImpl?: FetchLike
}

export interface PositionsChannel {
  /** One positions sync, coalesced with any in flight. Null when it failed. */
  sync(): Promise<PositionsOutcome | null>
  /**
   * Bring the positions up to date before a title resumes, without holding
   * playback up for long: nothing at all if a sync finished moments ago,
   * otherwise one, waited on for at most `FRESHEN_WAIT_MS`. A slow network
   * starts the title from what this device knows, as it always did.
   */
  freshen(): Promise<void>
}

/** A sync this recent is fresh enough to resume from. */
const FRESH_FOR_MS = 15_000
/** The longest a resume waits for the positions file. */
const FRESHEN_WAIT_MS = 1_500

/**
 * The positions file as a sync service holds it: one backend (so its
 * checksum cache survives between runs) behind one coalescing runner.
 *
 * Quiet on purpose. It runs every ten seconds during playback, so it never
 * touches the status line, and a failure is logged rather than shown: the
 * next run tries again within seconds, and the library sync, which does
 * report, carries the same positions on its own schedule.
 */
export function createPositionsChannel(options: PositionsChannelOptions): PositionsChannel {
  const backend = createDriveBackend<PositionsDocument>({
    accessToken: options.accessToken,
    fetchImpl: options.fetchImpl,
    name: POSITIONS_NAME,
  })
  const runner = new CoalescingRunner(() => syncPositions(options.host, backend))
  let syncedAt = -Infinity

  const sync = async (): Promise<PositionsOutcome | null> => {
    try {
      const outcome = await runner.request()
      syncedAt = Date.now()
      return outcome
    } catch (error) {
      console.warn('[sync] positions:', error instanceof Error ? error.message : error)
      return null
    }
  }

  return {
    sync,
    async freshen() {
      if (Date.now() - syncedAt < FRESH_FOR_MS) return
      await Promise.race([sync(), new Promise((resolve) => setTimeout(resolve, FRESHEN_WAIT_MS))])
    },
  }
}
