/**
 * A sync pushes only when the other device would learn something.
 *
 * Until 2.0.12 the library was compared with the pulled file as text. The file
 * always names the device that wrote it, so whenever the other device had
 * pushed last the two "differed": every sync re-uploaded the whole library,
 * and the other device downloaded it and pushed it back on its next one. The
 * positions file did the same over the order its points were stored in.
 */

import { describe, expect, it } from 'vitest'

import type { InputOf, RecordOf } from '../store/document'
import type { StoreCore } from '../store/core'
import { syncOnce } from './engine'
import { FakeDrive, libraryHost, storeOn } from './fakedrive.fixture'
import { POSITIONS_NAME, syncPositions, type PositionsDocument } from './positions'

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

/** Mark an episode the way the renderer does: a stamped mark, the list derived from the marks. */
function mark(store: StoreCore, id: string, episode: string): void {
  const current = store.collection('watchlist').get(id)!
  const episodeMarks = { ...current.episodeMarks, [episode]: { watched: true, at: Date.now() } }
  const watchedEpisodes = [...new Set([...current.watchedEpisodes, ...Object.keys(episodeMarks)])]
  store.collection('watchlist').patch(id, { episodeMarks, watchedEpisodes })
}

describe('the library push', () => {
  it('stops once both devices hold the same library', async () => {
    const drive = new FakeDrive()
    const desktop = await storeOn('desktop')
    const phone = await storeOn('phone')
    for (let i = 0; i < 20; i += 1) desktop.collection('watchlist').put(entry(`title-${i}`, 100 + i))
    const desktopBackend = drive.backend()
    const phoneBackend = drive.backend()
    await syncOnce(libraryHost(desktop), desktopBackend)
    await syncOnce(libraryHost(phone), phoneBackend)
    await syncOnce(libraryHost(desktop), desktopBackend)

    drive.uploads = 0
    drive.downloads = 0
    for (let i = 0; i < 4; i += 1) {
      await syncOnce(libraryHost(phone), phoneBackend)
      await syncOnce(libraryHost(desktop), desktopBackend)
    }
    expect(drive.uploads).toBe(0)
    expect(drive.downloads).toBeLessThanOrEqual(1)

    // A real change still travels.
    phone.collection('watchlist').remove('title-3')
    await syncOnce(libraryHost(phone), phoneBackend)
    await syncOnce(libraryHost(desktop), desktopBackend)
    expect(desktop.read().watchlist.map((w) => w.id)).not.toContain('title-3')
  })

  it('does not count the order of watched episodes as a change', async () => {
    const drive = new FakeDrive()
    const desktop = await storeOn('desktop')
    const phone = await storeOn('phone')
    const desktopBackend = drive.backend()
    const phoneBackend = drive.backend()
    desktop.collection('watchlist').put(entry('show', 1))
    mark(desktop, 'show', '1:1')
    await syncOnce(libraryHost(desktop), desktopBackend)
    await syncOnce(libraryHost(phone), phoneBackend)
    // Each device marks a different episode before hearing of the other's:
    // the merge lists its own first, so the two now hold them in other orders.
    mark(phone, 'show', '1:2')
    mark(desktop, 'show', '1:3')
    await syncOnce(libraryHost(desktop), desktopBackend)
    await syncOnce(libraryHost(phone), phoneBackend)
    await syncOnce(libraryHost(desktop), desktopBackend)

    drive.uploads = 0
    for (let i = 0; i < 3; i += 1) {
      await syncOnce(libraryHost(phone), phoneBackend)
      await syncOnce(libraryHost(desktop), desktopBackend)
    }
    expect(drive.uploads).toBe(0)
    expect([...desktop.read().watchlist[0]!.watchedEpisodes].sort()).toEqual(['1:1', '1:2', '1:3'])
  })
})

describe('the positions push', () => {
  type Point = RecordOf<'resumePoints'>
  const point = (key: string, now: number): Point => ({
    key,
    tmdbId: Number(key.split(':')[0]),
    seconds: 60,
    duration: 2400,
    updatedAt: now,
    deletedAt: null,
  })

  it('stops once both devices hold the same positions, whatever order they keep them in', async () => {
    const now = Date.now()
    const drive = new FakeDrive()
    let desktopPoints = [point('1:1:1', now), point('2:1:1', now)]
    let phonePoints = [point('3:1:1', now)]
    const desktopHost = { read: () => desktopPoints, adopt: (merged: Point[]) => void (desktopPoints = merged) }
    const phoneHost = { read: () => phonePoints, adopt: (merged: Point[]) => void (phonePoints = merged) }
    const desktopBackend = drive.backend<PositionsDocument>(POSITIONS_NAME)
    const phoneBackend = drive.backend<PositionsDocument>(POSITIONS_NAME)

    await syncPositions(desktopHost, desktopBackend, now)
    await syncPositions(phoneHost, phoneBackend, now)
    drive.uploads = 0
    for (let i = 0; i < 3; i += 1) {
      await syncPositions(desktopHost, desktopBackend, now)
      await syncPositions(phoneHost, phoneBackend, now)
    }

    expect(drive.uploads).toBe(0)
    const file = JSON.parse(drive.file(POSITIONS_NAME)) as PositionsDocument
    expect(file.resumePoints.map((p) => p.key)).toEqual(['1:1:1', '2:1:1', '3:1:1'])
  })
})
