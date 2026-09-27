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
