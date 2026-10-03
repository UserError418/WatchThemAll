/**
 * What the app decides by itself is written without a stamp of its own.
 *
 * Defaults and reconciliations used to be stamped like a choice the user made,
 * and last-write-wins only sees that today is later: a phone installed and
 * opened today carried its default providers over the configuration of every
 * other device on its first sync.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { mergeDocuments } from './merge'
import { storeOn } from '../sync/fakedrive.fixture'

afterEach(() => {
  vi.useRealTimers()
})

describe('seedPreference', () => {
  it('writes the value, and tells the listeners, without stamping it', async () => {
    const store = await storeOn('phone')
    const changes: unknown[] = []
    store.subscribe((key) => changes.push(key))

    store.seedPreference('providerOrder', ['alpha', 'beta'])

    expect(store.read().providerOrder).toEqual(['alpha', 'beta'])
    expect(store.raw().preferenceUpdatedAt.providerOrder).toBeUndefined()
    expect(changes).toEqual(['providerOrder'])
  })

  it('loses to a choice the user made on another device, however long ago', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 8, 1))
    const configured = await storeOn('desktop')
    configured.setPreference('providerOrder', ['gamma', 'beta', 'alpha'])

    vi.setSystemTime(Date.UTC(2026, 8, 8))
    const fresh = await storeOn('phone')
    fresh.seedPreference('providerOrder', ['alpha', 'beta', 'gamma'])

    expect(mergeDocuments(fresh.raw(), configured.raw()).providerOrder).toEqual(['gamma', 'beta', 'alpha'])
  })

  it('moves a stamp it finds on by one: enough to win over the value it was worked out from, and nothing later', async () => {
    const store = await storeOn('desktop')
    store.setPreference('knownProviderIds', ['alpha'])
    const before = store.raw().preferenceUpdatedAt.knownProviderIds!

    store.seedPreference('knownProviderIds', ['alpha', 'delta'])

    expect(store.raw().preferenceUpdatedAt.knownProviderIds).toBe(before + 1)
  })

  it('takes the preferences of a patch and nothing else', async () => {
    const store = await storeOn('desktop')
    store.seedPatch({ activeProviderIds: ['alpha'], deviceId: 'someone-else' })
    expect(store.read().activeProviderIds).toEqual(['alpha'])
    expect(store.read().deviceId).not.toBe('someone-else')
  })
})
