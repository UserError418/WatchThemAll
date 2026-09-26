/**
 * One release tracker per series, and the repair that restores it.
 *
 * The case that made this necessary: a library holding two Bleach trackers —
 * one from a MyAnimeList import, one added on another device — which stopped
 * the Releases tab from opening at all.
 */

import { describe, expect, it } from 'vitest'
import type { ReleaseTracker } from '../types'
import type { StoreDocument, Synced } from './document'
import { emptyDocument } from './core'
import { migrate } from './migrate'
import { survivingTrackers, withOneTrackerPerSeries } from './trackers'
import { syncOnce, type SyncHost } from '../sync/engine'
import type { SyncBackend } from '../sync/types'

const NOW = 1_800_000_000_000

function tracker(id: string, tmdbId: number, addedAt: number, deletedAt: number | null = null): Synced<ReleaseTracker> {
  return {
    id,
    tmdbId,
    title: `Series ${tmdbId}`,
    posterPath: null,
    status: 'Returning Series',
    nextEpisode: null,
    lastNotified: null,
    addedAt,
    lastChecked: 0,
    updatedAt: addedAt,
    deletedAt,
  }
}

function docWith(trackers: Synced<ReleaseTracker>[], deviceId = 'this'): StoreDocument {
  return { ...emptyDocument(deviceId), trackers }
}

const live = (doc: StoreDocument): string[] =>
  doc.trackers.filter((t) => t.deletedAt === null).map((t) => t.id)

describe('survivingTrackers', () => {
  it('keeps the tracker added first for each series, in the original order', () => {
    const trackers = [tracker('late', 30984, 200), tracker('other', 1, 150), tracker('early', 30984, 100)]
    expect(survivingTrackers(trackers).map((t) => t.id)).toEqual(['other', 'early'])
  })

  it('breaks a tie on the id, so every device picks the same survivor', () => {
    const forward = survivingTrackers([tracker('b', 7, 100), tracker('a', 7, 100)])
    const backward = survivingTrackers([tracker('a', 7, 100), tracker('b', 7, 100)])
    expect(forward.map((t) => t.id)).toEqual(['a'])
    expect(backward.map((t) => t.id)).toEqual(['a'])
  })
})

describe('withOneTrackerPerSeries', () => {
  it('deletes the extra copy of a series, dated now, and keeps the first', () => {
    const doc = docWith([
      tracker('mal-bleach', 30984, 1_000),
      tracker('uuid-bleach', 30984, 2_000),
      tracker('other', 1, 1_500),
    ])
    const repaired = withOneTrackerPerSeries(doc, NOW)

    expect(live(repaired)).toEqual(['mal-bleach', 'other'])
    const deleted = repaired.trackers.find((t) => t.id === 'uuid-bleach')
    expect(deleted?.deletedAt).toBe(NOW)
    // Dated now so the deletion outranks the copy still live on other devices.
    expect(deleted?.updatedAt).toBe(NOW)
  })

  it('returns a clean document untouched, so it is not rewritten', () => {
    const doc = docWith([tracker('a', 1, 1), tracker('b', 2, 1)])
    expect(withOneTrackerPerSeries(doc, NOW)).toBe(doc)
  })

  it('does nothing the second time', () => {
    const once = withOneTrackerPerSeries(docWith([tracker('a', 1, 1), tracker('b', 1, 2)]), NOW)
    expect(withOneTrackerPerSeries(once, NOW + 1)).toBe(once)
  })

  it('ignores deleted trackers: a tombstone is not a copy to compete with', () => {
    // Removed and re-added later: the tombstone is older, and must not make
    // the tracker the user re-added lose to it.
    const doc = docWith([tracker('old', 5, 100, 150), tracker('new', 5, 200)])
    expect(withOneTrackerPerSeries(doc, NOW)).toBe(doc)
  })
})

describe('where the repair runs', () => {
  it('on load: migrate hands back one live tracker per series', () => {
    const onDisk = docWith([tracker('mal-bleach', 30984, 1_000), tracker('uuid-bleach', 30984, 2_000)])
    expect(live(migrate(onDisk, NOW))).toEqual(['mal-bleach'])
  })

  it('after a merge: two libraries that each track a series once do not end up tracking it twice', async () => {
    const mine = docWith([tracker('pc-bleach', 30984, 2_000)], 'pc')
    const theirs = docWith([tracker('phone-bleach', 30984, 1_000)], 'phone')

    let current = mine
    const host: SyncHost = {
      read: () => current,
      write: async (next) => {
        current = next
      },
    }
    let pushed: StoreDocument | null = null
    const backend: SyncBackend = {
      pull: async () => ({ document: theirs, version: null }),
      push: async (document) => {
        pushed = document
      },
    }

    await syncOnce(host, backend, NOW)

    expect(live(current)).toEqual(['phone-bleach'])
    // The deletion goes up too, so the other device drops its copy as well.
    expect(pushed && live(pushed)).toEqual(['phone-bleach'])
  })
})
