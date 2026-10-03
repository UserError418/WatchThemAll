/**
 * A write made while a sync waits on Drive must survive that sync.
 *
 * All three syncs (the library, the positions, the test history) pull, merge
 * and keep the result. Until 2.0.12 each read this device's copy *before* the
 * pull, so whatever was written during the network round trip was merged away
 * when the result was kept: a position saved or forgotten, a test result, a
 * whole import. Each test here holds the listing open, writes, and releases it.
 */

import { describe, expect, it } from 'vitest'

import { stamp } from '../store/core'
import type { InputOf, RecordOf } from '../store/document'
import { ResultStore } from '../store/results'
import type { SourceResult } from '../sourceresults'
import { syncOnce } from './engine'
import { FakeDrive, MemoryFile, libraryHost, storeOn } from './fakedrive.fixture'
import { POSITIONS_NAME, syncPositions, type PositionsDocument } from './positions'
import { RESULTS_NAME, syncResults, type ResultsDocument } from './results'

function entry(id: string, tmdbId: number): InputOf<'watchlist'> {
  return {
    id,
    tmdbId,
    type: 'tv',
    title: id,
    posterPath: null,
    imdbId: null,
    lastSeason: 1,
    lastEpisode: 1,
    watchedEpisodes: [],
    episodeMarks: {},
    genreIds: [],
    episodeCount: null,
    rating: 0,
    addedAt: 1,
    providerId: null,
  }
}

function result(providerId: string, deviceId: string, at: number): SourceResult {
  return {
    titleKey: 'movie:tt0137523',
    season: null,
    episode: null,
    providerId,
    at,
    deviceId,
    deviceKind: deviceId.startsWith('phone') ? 'phone' : 'desktop',
    origin: 'test',
    verdict: 'stream',
  }
}

describe('a write during the pull', () => {
  it('keeps an import that lands while the library sync is pulling', async () => {
    const drive = new FakeDrive()
    const desktop = await storeOn('desktop')
    desktop.collection('watchlist').put(entry('kept', 1))
    const desktopBackend = drive.backend()
    await syncOnce(libraryHost(desktop), desktopBackend)
    // The phone adds something, so the desktop's next sync has a merge to keep:
    // the case a sync on window focus exists for.
    const phone = await storeOn('phone')
    phone.collection('watchlist').put(entry('from-phone', 2))
    await syncOnce(libraryHost(phone), drive.backend())

    const hold = drive.holdNextListing()
    const syncing = syncOnce(libraryHost(desktop), desktopBackend)
    await hold.asked
    // An import finishing now, the way both importers end: a whole document.
    const imported = desktop.read()
    imported.watchlist = [...imported.watchlist, stamp(entry('imported', 3))]
    await desktop.replaceDocument(imported)
    hold.release()
    await syncing

    expect(desktop.read().watchlist.map((w) => w.id)).toEqual(
      expect.arrayContaining(['kept', 'from-phone', 'imported']),
    )
    expect(drive.file('WatchThemAll library.json')).toContain('imported')
  })

  it('keeps a position saved, and one forgotten, while the positions sync is pulling', async () => {
    const drive = new FakeDrive()
    const desktop = await storeOn('desktop')
    const points = desktop.collection('resumePoints')
    points.put({ key: '1:1:1', tmdbId: 1, seconds: 100, duration: 2400 })
    points.put({ key: '2:1:9', tmdbId: 2, seconds: 2390, duration: 2400 })
    // The phone's position for another title is already in the file, so this
    // sync has something to take.
    drive.seed(POSITIONS_NAME, {
      positions: 1,
      resumePoints: [{ key: '3:m:m', tmdbId: 3, seconds: 50, duration: 6000, updatedAt: 1, deletedAt: null }],
    })
    const host = {
      read: () => desktop.raw().resumePoints,
      adopt: (merged: RecordOf<'resumePoints'>[]) => desktop.adoptRecords('resumePoints', merged),
    }

    const hold = drive.holdNextListing()
    const syncing = syncPositions(host, drive.backend<PositionsDocument>(POSITIONS_NAME))
    await hold.asked
    points.put({ key: '1:1:1', tmdbId: 1, seconds: 105, duration: 2400 }) // the five-second save
    points.remove('2:1:9') // that episode ended: its position is forgotten
    hold.release()
    await syncing

    const after = desktop.raw().resumePoints
    expect(after.find((p) => p.key === '1:1:1')?.seconds).toBe(105)
    expect(after.find((p) => p.key === '2:1:9')?.deletedAt).not.toBeNull()
    expect(after.find((p) => p.key === '3:m:m')).toBeDefined()
  })

  it('keeps a test result recorded while the results sync is pulling', async () => {
    const drive = new FakeDrive()
    const now = Date.now()
    const results = new ResultStore(new MemoryFile(), () => now)
    await results.load()
    drive.seed(RESULTS_NAME, { results: 1, items: [result('vidsrc', 'phone-1', now - 1000)] })
    const host = { read: () => results.all(), adopt: (merged: SourceResult[]) => results.adopt(merged) }

    const hold = drive.holdNextListing()
    const syncing = syncResults(host, drive.backend<ResultsDocument>(RESULTS_NAME), now)
    await hold.asked
    results.record([result('vidrock', 'desktop-1', now)]) // a scan finishes meanwhile
    hold.release()
    await syncing

    expect(results.all().map((r) => r.providerId).sort()).toEqual(['vidrock', 'vidsrc'])
    expect(drive.file(RESULTS_NAME)).toContain('vidrock')
  })
})
