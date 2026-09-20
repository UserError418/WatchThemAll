/**
 * What one sync does, and what several at once do.
 *
 * The merge itself is tested in `store/merge.test.ts`; this is about the
 * choreography around it — which side gets written, when a push is skipped, and
 * what happens when two triggers fire at the same moment, which is the normal
 * case rather than the edge case.
 */

import { describe, expect, it, vi } from 'vitest'

import { SyncRunner, syncOnce, type SyncHost } from './engine'
import type { RemoteDocument, SyncBackend } from './types'
import { SCHEMA_VERSION, type StoreDocument } from '../store/document'
import { DEFAULT_SETTINGS } from '../store/core'

function doc(deviceId: string, titles: string[] = []): StoreDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId,
    preferenceUpdatedAt: {},
    watchlist: titles.map((id) => ({
      id,
      tmdbId: 1,
      type: 'tv' as const,
      title: id,
      posterPath: null,
      imdbId: null,
      lastSeason: null,
      lastEpisode: null,
      watchedEpisodes: [],
      episodeMarks: {},
      genreIds: [],
      episodeCount: null,
      rating: 0,
      addedAt: 1,
      providerId: null,
      updatedAt: 1,
      deletedAt: null,
    })),
    trackers: [],
    history: [],
    watched: [],
    ratings: [],
    resumePoints: [],
    streamOutcomes: [],
    customProviders: [],
    activeProviderIds: [],
    knownProviderIds: [],
    favouriteProviderIds: [],
    providerOrder: [],
    settings: { ...DEFAULT_SETTINGS },
  }
}

function hostOf(initial: StoreDocument): SyncHost & { current: StoreDocument; writes: number } {
  return {
    current: initial,
    writes: 0,
    read() {
      return this.current
    },
    async write(next: StoreDocument) {
      this.current = next
      this.writes += 1
    },
  }
}

function backendOf(remote: RemoteDocument | null): SyncBackend & {
  stored: RemoteDocument | null
  pushes: number
} {
  return {
    stored: remote,
    pushes: 0,
    async pull() {
      return this.stored
    },
    async push(document) {
      this.stored = { document, version: null }
      this.pushes += 1
    },
  }
}

describe('one sync', () => {
  it('uploads everything when the account has never synced', async () => {
    const host = hostOf(doc('a', ['tv-1']))
    const backend = backendOf(null)

    const outcome = await syncOnce(host, backend, 500)

    expect(outcome).toEqual({ changed: false, createdRemote: true, at: 500 })
    expect(backend.stored?.document.watchlist).toHaveLength(1)
    expect(host.writes).toBe(0)
  })

  it('brings both sides to the union', async () => {
    const host = hostOf(doc('a', ['tv-1']))
    const backend = backendOf({ document: doc('b', ['tv-2']), version: null })

    await syncOnce(host, backend, 0)

    expect(host.current.watchlist.map((w) => w.id).sort()).toEqual(['tv-1', 'tv-2'])
    expect(backend.stored?.document.watchlist.map((w) => w.id).sort()).toEqual(['tv-1', 'tv-2'])
  })

  it('writes nothing anywhere when the two sides already agree', async () => {
    // The common case by far — most syncs have nothing to do, and one that
    // rewrites both files regardless burns quota and rewrites the user's disk
    // on every launch for no reason.
    const host = hostOf(doc('a', ['tv-1']))
    const backend = backendOf({ document: doc('a', ['tv-1']), version: null })

    const outcome = await syncOnce(host, backend, 0)

    expect(outcome.changed).toBe(false)
    expect(host.writes).toBe(0)
    expect(backend.pushes).toBe(0)
  })

  it('pushes without writing locally when only the remote is behind', async () => {
    const host = hostOf(doc('a', ['tv-1', 'tv-2']))
    const backend = backendOf({ document: doc('a', ['tv-1']), version: null })

    await syncOnce(host, backend, 0)

    expect(host.writes).toBe(0)
    expect(backend.pushes).toBe(1)
  })

  it('keeps the merge locally even when the upload fails', async () => {
    // The merge is this device's best understanding, and it is worth keeping
    // whether or not the network cooperates. Writing only after a successful
    // push would throw away a good merge because of a dropped connection.
    const host = hostOf(doc('a', ['tv-1']))
    const backend: SyncBackend = {
      pull: async () => ({ document: doc('b', ['tv-2']), version: null }),
      push: async () => {
        throw new Error('offline')
      },
    }

    await expect(syncOnce(host, backend, 0)).rejects.toThrow('offline')
    expect(host.current.watchlist.map((w) => w.id).sort()).toEqual(['tv-1', 'tv-2'])
  })

  it('keeps this device\'s own id through a merge', async () => {
    const host = hostOf(doc('mine', ['tv-1']))
    const backend = backendOf({ document: doc('theirs', ['tv-2']), version: null })

    await syncOnce(host, backend, 0)
    expect(host.current.deviceId).toBe('mine')
  })
})

describe('a stale overwrite heals itself', () => {
  it('restores records a peer clobbered, on the next sync', async () => {
    // Drive has no conditional update, so this *will* happen. The claim being
    // tested is that it costs latency rather than data: the remote file is a
    // rendezvous, and every device still holds the whole library.
    const remote = backendOf(null)

    const a = hostOf(doc('a', ['tv-1']))
    const b = hostOf(doc('b', ['tv-2']))

    await syncOnce(a, remote, 0) // A creates the remote, holding tv-1.
    await syncOnce(b, remote, 1) // B merges and pushes tv-1 + tv-2.

    // A now adds something and pushes; B, unaware, overwrites from its own
    // older base — which is exactly what a lost update looks like.
    a.current = doc('a', ['tv-1', 'tv-3'])
    await syncOnce(a, remote, 2)
    remote.stored = { document: doc('b', ['tv-1', 'tv-2']), version: null }

    expect(remote.stored.document.watchlist.map((w) => w.id)).not.toContain('tv-3')

    await syncOnce(a, remote, 3)

    expect(remote.stored?.document.watchlist.map((w) => w.id).sort()).toEqual([
      'tv-1',
      'tv-2',
      'tv-3',
    ])
  })
})

describe('overlapping triggers', () => {
  it('coalesces requests that arrive during a running sync into one follow-up', async () => {
    // Launch, foreground and a settled write overlap constantly. Three requests
    // during one sync deserve one more sync, not three.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    let pulls = 0

    const backend: SyncBackend = {
      pull: async () => {
        pulls += 1
        if (pulls === 1) await gate
        return null
      },
      push: async () => undefined,
    }

    const runner = new SyncRunner(hostOf(doc('a')), backend, () => 0)

    const first = runner.request()
    const second = runner.request()
    const third = runner.request()
    expect(runner.busy).toBe(true)

    release()
    await Promise.all([first, second, third])

    expect(pulls).toBe(2)
    expect(runner.busy).toBe(false)
  })

  it('starts a fresh sync once the previous one has finished', async () => {
    const backend = backendOf(null)
    const spy = vi.spyOn(backend, 'pull')
    const runner = new SyncRunner(hostOf(doc('a')), backend, () => 0)

    await runner.request()
    await runner.request()

    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('does not wedge after a failure', async () => {
    // A runner that leaves `running` set after a rejection never syncs again,
    // and the only symptom is silence.
    let attempt = 0
    const backend: SyncBackend = {
      pull: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('offline')
        return null
      },
      push: async () => undefined,
    }
    const runner = new SyncRunner(hostOf(doc('a')), backend, () => 0)

    await expect(runner.request()).rejects.toThrow('offline')
    expect(runner.busy).toBe(false)
    await expect(runner.request()).resolves.toMatchObject({ createdRemote: true })
  })
})
