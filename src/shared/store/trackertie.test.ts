/**
 * Two trackers checked at the same moment settle the same way on both devices.
 *
 * `nextEpisode` comes from whichever copy checked TMDB more recently. On a tie
 * the local copy won, so when the two said different things each device kept
 * its own after every merge, and the merge was not the same in both directions.
 */

import { describe, expect, it } from 'vitest'

import { emptyDocument } from './core'
import type { RecordOf, StoreDocument } from './document'
import { mergeDocuments } from './merge'

function withTracker(deviceId: string, nextEpisode: number): StoreDocument {
  const tracker = {
    id: 'tracker-1',
    tmdbId: 1396,
    title: 'Breaking Bad',
    posterPath: null,
    status: 'Returning Series',
    nextEpisode: { season: 2, episode: nextEpisode, name: `Episode ${nextEpisode}`, airDate: '2026-10-10' },
    lastNotified: null,
    addedAt: 1,
    lastChecked: 5_000,
    updatedAt: 5_000,
    deletedAt: null,
  } as RecordOf<'trackers'>
  return { ...emptyDocument(deviceId), trackers: [tracker] }
}

describe('trackers checked at the same moment', () => {
  it('give the same next episode whichever side merges', () => {
    const desktop = withTracker('desktop', 1)
    const phone = withTracker('phone', 2)

    const onDesktop = mergeDocuments(desktop, phone).trackers[0]!.nextEpisode
    const onPhone = mergeDocuments(phone, desktop).trackers[0]!.nextEpisode

    expect(onDesktop).toEqual(onPhone)
  })
})
