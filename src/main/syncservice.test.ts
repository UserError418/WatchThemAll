/**
 * An expired access token is refreshed once, however many syncs ask for it.
 *
 * `syncSoon` starts the library, the positions and the test history together.
 * With an expired token, which is most launches, each refreshed it on its own:
 * three requests to Google and three writes of the stored credentials, racing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn(async () => {}) } }))

const { FakeDrive, libraryHost, storeOn } = await import('@shared/sync/fakedrive.fixture')
const { SyncService } = await import('./syncservice')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the desktop sync service', () => {
  it('refreshes an expired token once for three syncs started together', async () => {
    vi.stubGlobal('__WTA_GOOGLE_CLIENT_ID__', 'client-id')
    vi.stubGlobal('__WTA_GOOGLE_CLIENT_SECRET__', 'client-secret')
    const drive = new FakeDrive()
    let refreshes = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        refreshes += 1
        return new Response(JSON.stringify({ access_token: `fresh-${refreshes}`, expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return drive.fetch(input, init)
    })
    const written: unknown[] = []
    const tokens = {
      canPersist: true,
      read: async () => ({ accessToken: 'expired', refreshToken: 'refresh', expiresAt: 0, accountEmail: null }),
      write: async (credentials: unknown) => void written.push(credentials),
      clear: async () => {},
    }
    const store = await storeOn('desktop')
    const service = new SyncService({
      host: libraryHost(store),
      positionsHost: { read: () => store.raw().resumePoints, adopt: (points) => store.adoptRecords('resumePoints', points) },
      resultsHost: { read: () => [], adopt: () => {} },
      tokens: tokens as never,
      onStatus: () => {},
    })
    await service.load()

    await Promise.all([service.now(), service.positions(), service.results()])

    expect(refreshes).toBe(1)
    expect(written).toHaveLength(1)
  })
})
