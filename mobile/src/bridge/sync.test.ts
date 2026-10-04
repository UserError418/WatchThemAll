/**
 * The phone refreshes an expired access token once, however many syncs ask.
 *
 * Its `soon()` starts the library, the positions and the test history
 * together, and with an expired token each refreshed it on its own.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

const { fetchOnNetwork, preferences } = vi.hoisted(() => ({
  fetchOnNetwork: { current: null as null | typeof fetch },
  preferences: { value: null as string | null, sets: 0 },
}))
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async () => ({ value: preferences.value }),
    set: async ({ value }: { value: string }) => {
      preferences.value = value
      preferences.sets += 1
    },
    remove: async () => {
      preferences.value = null
    },
  },
}))
vi.mock('@capacitor/browser', () => ({ Browser: {} }))
vi.mock('./net', () => ({
  dualStackFetch: (input: RequestInfo | URL, init?: RequestInit) => fetchOnNetwork.current!(input, init),
}))

const { FakeDrive, libraryHost, storeOn } = await import('@shared/sync/fakedrive.fixture')
const { createMobileSync } = await import('./sync')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the phone sync', () => {
  it('refreshes an expired token once for three syncs started together', async () => {
    vi.stubGlobal('__WTA_GOOGLE_CLIENT_ID__', 'client-id')
    vi.stubGlobal('__WTA_GOOGLE_CLIENT_SECRET__', 'client-secret')
    const drive = new FakeDrive()
    let refreshes = 0
    fetchOnNetwork.current = async (input, init) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        refreshes += 1
        return new Response(JSON.stringify({ access_token: `fresh-${refreshes}`, expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return drive.fetch(input, init)
    }
    preferences.value = JSON.stringify({ accessToken: 'expired', refreshToken: 'refresh', expiresAt: 0, accountEmail: null })
    const store = await storeOn('phone')
    const sync = createMobileSync({
      host: libraryHost(store),
      positionsHost: { read: () => store.raw().resumePoints, adopt: (points) => store.adoptRecords('resumePoints', points) },
      resultsHost: { read: () => [], adopt: () => {} },
      onStatus: () => {},
    })
    await sync.load()

    await Promise.all([sync.now(), sync.positions(), sync.results()])

    expect(refreshes).toBe(1)
    expect(preferences.sets).toBe(1)
  })
})
