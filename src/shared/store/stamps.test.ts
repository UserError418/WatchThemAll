/**
 * An edit made after seeing a version beats that version, whatever the clocks say.
 *
 * Every stamp is the device's wall clock, and two devices' clocks disagree. A
 * phone running an hour fast stamped its edits an hour ahead, and an edit made
 * on the desktop five minutes later, by a user who had seen the phone's, lost
 * to it on every sync for the rest of that hour. A change now stamps one past
 * the version it replaces when the clock has not got there yet.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { InputOf } from './document'
import { syncOnce } from '../sync/engine'
import { FakeDrive, libraryHost, storeOn } from '../sync/fakedrive.fixture'

const T = Date.UTC(2026, 8, 1)
const HOUR = 60 * 60_000

function rating(value: number): InputOf<'ratings'> {
  return {
    key: 'tv:tt0903747',
    tmdbId: 1396,
    type: 'tv',
    season: null,
    value: value as InputOf<'ratings'>['value'],
    coarse: false,
    rating: value >= 6 ? 'like' : 'dislike',
    genreIds: [],
    at: Date.now(),
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('stamps', () => {
  it('a later edit wins over the version it replaced from a device whose clock runs ahead', async () => {
    const drive = new FakeDrive()
    const desktop = await storeOn('desktop')
    const phone = await storeOn('phone')
    const desktopBackend = drive.backend()
    const phoneBackend = drive.backend()

    vi.setSystemTime(T + HOUR) // the phone's clock is an hour fast
    phone.collection('ratings').put(rating(8))
    await syncOnce(libraryHost(phone), phoneBackend)
    vi.setSystemTime(T + 60_000) // the desktop's is right
    await syncOnce(libraryHost(desktop), desktopBackend)
    expect(desktop.read().ratings[0]!.value).toBe(8)

    vi.setSystemTime(T + 5 * 60_000)
    desktop.collection('ratings').put(rating(3)) // re-rated, having seen the 8
    await syncOnce(libraryHost(desktop), desktopBackend)
    await syncOnce(libraryHost(phone), phoneBackend)

    expect(desktop.read().ratings[0]!.value).toBe(3)
    expect(phone.read().ratings[0]!.value).toBe(3)
  })

  it('every kind of change stamps one past a version from the future', async () => {
    const store = await storeOn('desktop')
    const ahead = T + HOUR
    store.adoptRecords('ratings', [{ ...rating(8), updatedAt: ahead, deletedAt: null }])
    const ratings = store.collection('ratings')

    ratings.patch('tv:tt0903747', { value: 7 })
    expect(store.raw().ratings[0]!.updatedAt).toBe(ahead + 1)
    ratings.put(rating(6))
    expect(store.raw().ratings[0]!.updatedAt).toBe(ahead + 2)
    ratings.replaceAll([rating(5)])
    expect(store.raw().ratings[0]!.updatedAt).toBe(ahead + 3)
    ratings.remove('tv:tt0903747')
    expect(store.raw().ratings[0]!.updatedAt).toBe(ahead + 4)
    expect(store.raw().ratings[0]!.deletedAt).toBe(ahead + 4)
  })

  it('a preference changed after a merge from the future stamps one past it', async () => {
    const store = await storeOn('desktop')
    store.raw().preferenceUpdatedAt = { providerOrder: T + HOUR }
    store.setPreference('providerOrder', ['vidsrc'])
    expect(store.raw().preferenceUpdatedAt.providerOrder).toBe(T + HOUR + 1)
  })

  it('a stamp from the past changes nothing: the clock is used as before', async () => {
    const store = await storeOn('desktop')
    store.collection('ratings').put(rating(8))
    vi.setSystemTime(T + 60_000)
    store.collection('ratings').patch('tv:tt0903747', { value: 9 })
    expect(store.raw().ratings[0]!.updatedAt).toBe(T + 60_000)
  })
})
