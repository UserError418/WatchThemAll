/**
 * One release tracker per series.
 *
 * Trackers are identified by a random id (`COLLECTIONS` in `document.ts`), so
 * a series tracked on two devices before they synced arrives as two records,
 * and the merge — which pairs records by identity — keeps both. Nothing about
 * a second copy is useful and two things about it are harmful: the release
 * sweep announces every new episode twice, and the Releases timeline, which
 * keys its rows by series and episode, refuses to render at all. That is how
 * the tab stopped opening on 2026-09-26: two Bleach trackers, one from a
 * MyAnimeList import on 2026-09-06 and one added on the other device that day.
 *
 * The extra copies are **deleted**, not collapsed by changing the identity to
 * the series. A tombstone syncs like any other change, so a device still on an
 * older build drops its copy too; a new identity rule would only hold on
 * devices that have it, and an older one would keep sending the duplicate
 * back on every sync.
 */

import type { ReleaseTracker } from '../types'
import type { StoreDocument } from './document'

/**
 * The trackers a list keeps: one per series, in their original order.
 *
 * The survivor is the tracker added first, then the smaller id, which depends
 * only on the records themselves — so every device that runs this deletes the
 * same copy, and two devices repairing at once agree instead of each deleting
 * the other's.
 */
export function survivingTrackers<T extends Pick<ReleaseTracker, 'id' | 'tmdbId' | 'addedAt'>>(
  trackers: readonly T[],
): T[] {
  const survivor = new Map<number, T>()
  for (const tracker of trackers) {
    const kept = survivor.get(tracker.tmdbId)
    const earlier =
      kept === undefined ||
      tracker.addedAt < kept.addedAt ||
      (tracker.addedAt === kept.addedAt && tracker.id < kept.id)
    if (earlier) survivor.set(tracker.tmdbId, tracker)
  }
  return trackers.filter((tracker) => survivor.get(tracker.tmdbId) === tracker)
}

/**
 * The document with every live tracker but one per series deleted.
 *
 * Run on load and on every sync pull (`migrate`), and after every merge
 * (`syncOnce`), because two documents that are each clean can still merge
 * into one holding the same series twice. Returns the document itself when
 * there is nothing to delete, so a clean library is not rewritten.
 */
export function withOneTrackerPerSeries(doc: StoreDocument, now: number): StoreDocument {
  const live = doc.trackers.filter((tracker) => tracker.deletedAt === null)
  const kept = new Set(survivingTrackers(live).map((tracker) => tracker.id))
  if (kept.size === live.length) return doc

  return {
    ...doc,
    trackers: doc.trackers.map((tracker) =>
      tracker.deletedAt === null && !kept.has(tracker.id)
        ? { ...tracker, deletedAt: now, updatedAt: now }
        : tracker,
    ),
  }
}
