/**
 * The store's own write paths.
 *
 * Only the part a merge depends on, which is where being wrong is silent:
 * which records a write stamps. `updatedAt` is read by nothing but the sync
 * merge, so a write path that stamps too much looks perfectly healthy on one
 * device and loses edits the first time two of them meet.
 */

import { describe, expect, it } from 'vitest'

import { StoreCore } from './core'
import { migrate } from './migrate'
import { SCHEMA_VERSION } from './document'

/** A store over an in-memory document, loaded and ready. */
async function storeWith(document: Record<string, unknown>): Promise<StoreCore> {
  let text: string | null = JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...document })
  const store = new StoreCore(
    {
      read: async () => text,
      write: async (next) => {
        text = next
      },
      quarantine: async () => {},
      describe: async () => 'memory',
    },
    migrate,
    'desktop',
  )
  await store.load()
  return store
}

const outcome = (providerId: string, at: number) => ({
  providerId,
  mediaKey: 'tv:1',
  outcome: 'stream' as const,
  at,
  updatedAt: at,
  deletedAt: null,
})

describe('applyPatch / replaceAll', () => {
  /**
   * The bug this pins. The renderer sends a whole collection back after every
   * change, and every record in it used to be stamped "now" — so the device
   * that last touched *anything* in a collection won every conflict in it on
   * the next sync, including over newer edits made elsewhere.
   */
  it('keeps the stamp of a record sent back unchanged', async () => {
    const store = await storeWith({ streamOutcomes: [outcome('a', 100), outcome('b', 200)] })
    const [first, second] = store.read().streamOutcomes

    store.applyPatch({ streamOutcomes: [first, { ...second!, outcome: 'failed' }] })

    const stamps = Object.fromEntries(store.raw().streamOutcomes.map((r) => [r.providerId, r.updatedAt]))
    expect(stamps.a).toBe(100)
    expect(stamps.b).toBeGreaterThan(200)
  })

  /** The renderer rebuilds records by spreading, so key order is not stable. */
  it('ignores key order when deciding whether a record changed', async () => {
    const store = await storeWith({ streamOutcomes: [outcome('a', 100)] })
    const { at, outcome: result, mediaKey, providerId } = store.read().streamOutcomes[0]!

    store.applyPatch({ streamOutcomes: [{ at, outcome: result, mediaKey, providerId }] })

    expect(store.raw().streamOutcomes[0]?.updatedAt).toBe(100)
  })

  it('still tombstones a record that disappeared', async () => {
    const store = await storeWith({ streamOutcomes: [outcome('a', 100), outcome('b', 200)] })

    store.applyPatch({ streamOutcomes: [store.read().streamOutcomes[0]] })

    const gone = store.raw().streamOutcomes.find((r) => r.providerId === 'b')
    expect(gone?.deletedAt).toBeGreaterThan(200)
  })

  /** Sending a deleted record back is an un-delete, which is a change. */
  it('stamps a tombstone that comes back as a live record', async () => {
    const store = await storeWith({
      streamOutcomes: [{ ...outcome('a', 100), deletedAt: 150, updatedAt: 150 }],
    })

    store.applyPatch({ streamOutcomes: [outcome('a', 100)] })

    const back = store.raw().streamOutcomes[0]
    expect(back?.deletedAt).toBeNull()
    expect(back?.updatedAt).toBeGreaterThan(150)
  })
})

describe('replaceDocument', () => {
  // Recent, because `load` prunes tombstones past their TTL and a 1970 one
  // would be gone before the test began.
  const deletedAt = Date.now() - 1_000

  /**
   * Both importers build their replacement from `read()`, which hides
   * tombstones. Taking that document as-is wiped every deletion not yet
   * synced, and the next sync revived the deleted records from the other
   * device.
   */
  it('keeps a pending deletion the new document does not mention', async () => {
    const store = await storeWith({
      streamOutcomes: [outcome('a', 100), { ...outcome('b', 200), deletedAt, updatedAt: deletedAt }],
    })

    await store.replaceDocument(store.read())

    const gone = store.raw().streamOutcomes.find((r) => r.providerId === 'b')
    expect(gone?.deletedAt).toBe(deletedAt)
    expect(store.read().streamOutcomes.map((r) => r.providerId)).toEqual(['a'])
  })

  /** An import that brings a deleted title back must win over its tombstone. */
  it('lets the new document re-add a record that was deleted', async () => {
    const store = await storeWith({
      streamOutcomes: [{ ...outcome('b', 200), deletedAt, updatedAt: deletedAt }],
    })
    const readded = outcome('b', Date.now())

    await store.replaceDocument({ ...store.read(), streamOutcomes: [readded] })

    expect(store.raw().streamOutcomes).toEqual([readded])
  })
})

describe('load', () => {
  /** A persistence whose reads are scripted, and whose writes are kept. */
  function scripted(read: () => Promise<string | null>) {
    const writes: string[] = []
    const store = new StoreCore(
      {
        read,
        write: async (text) => {
          writes.push(text)
        },
        quarantine: async () => {},
        describe: async () => 'memory',
      },
      migrate,
      'desktop',
    )
    return { store, writes }
  }

  /**
   * The case that destroyed libraries: a file that exists and will not open
   * (a virus scanner's lock, a permission) used to be taken for a first run,
   * and the empty library that followed was written over it.
   */
  it('never writes over a document that exists and would not open', async () => {
    const { store, writes } = scripted(async () => {
      throw new Error('EBUSY: resource busy or locked')
    })
    await store.load()

    expect(store.loadFailure).toMatch(/EBUSY/)
    store.collection('resumePoints').put({ key: 'movie:1', tmdbId: 1, seconds: 600, duration: 6000 })
    await store.flush()
    expect(writes).toEqual([])
  })

  it('reads a document whose lock clears on a later try', async () => {
    let calls = 0
    const { store, writes } = scripted(async () => {
      calls += 1
      if (calls === 1) throw new Error('EBUSY: resource busy or locked')
      return JSON.stringify({ schemaVersion: SCHEMA_VERSION, streamOutcomes: [outcome('a', 1)] })
    })
    await store.load()

    expect(store.loadFailure).toBeNull()
    expect(calls).toBe(2)
    expect(store.read().streamOutcomes.map((r) => r.providerId)).toEqual(['a'])
    expect(writes).toEqual([])
  })

  it('starts, and saves, a fresh library when there is no document at all', async () => {
    const { store, writes } = scripted(async () => null)
    await store.load()

    expect(store.loadFailure).toBeNull()
    expect(writes).toHaveLength(1)
  })
})

describe('flush', () => {
  function counted(text: string | null, failFirst = false) {
    let attempts = 0
    const writes: string[] = []
    const store = new StoreCore(
      {
        read: async () => text,
        write: async (next) => {
          attempts += 1
          if (failFirst && attempts === 1) throw new Error('ENOSPC')
          writes.push(next)
        },
        quarantine: async () => {},
        describe: async () => 'memory',
      },
      migrate,
      'desktop',
    )
    return { store, writes }
  }

  /** The phone flushes on every trip to the background, changed or not. */
  it('writes nothing when nothing changed since the last write', async () => {
    const { store, writes } = counted(null)
    await store.load()
    const afterFirstRun = writes.length

    await store.flush()
    await store.flush()
    expect(writes).toHaveLength(afterFirstRun)

    store.collection('resumePoints').put({ key: 'movie:1', tmdbId: 1, seconds: 600, duration: 6000 })
    await store.flush()
    await store.flush()
    expect(writes).toHaveLength(afterFirstRun + 1)
  })

  it('tries again at the next flush when a write failed', async () => {
    const { store, writes } = counted(null, true)
    await store.load()
    expect(writes).toHaveLength(0)

    await store.flush()
    expect(writes).toHaveLength(1)
  })

  it('saves what loading changed, and only that once', async () => {
    const { store, writes } = counted(JSON.stringify({ schemaVersion: 1 }))
    await store.load()

    await store.flush()
    await store.flush()
    expect(writes).toHaveLength(1)
  })

  it('does not rewrite a document that loaded exactly as saved', async () => {
    const first = counted(null)
    await first.store.load()
    const saved = first.writes.at(-1)!

    const { store, writes } = counted(saved)
    await store.load()
    await store.flush()
    expect(writes).toEqual([])
  })
})

describe('subscribe', () => {
  it('names the key a change touched', async () => {
    const store = await storeWith({ streamOutcomes: [outcome('a', 1)] })
    const heard: unknown[] = []
    store.subscribe((key) => heard.push(key))

    store.collection('resumePoints').put({ key: 'movie:1', tmdbId: 1, seconds: 600, duration: 6000 })
    await store.replaceDocument(store.read())

    expect(heard).toEqual(['resumePoints', null])
  })

  /**
   * The renderer sends whole collections back, often unchanged. Each of those
   * used to be a disk write and a reload of every view.
   */
  it('stays quiet when a collection comes back unchanged', async () => {
    const store = await storeWith({ streamOutcomes: [outcome('a', 1)] })
    const heard: unknown[] = []
    store.subscribe((key) => heard.push(key))

    store.applyPatch({ streamOutcomes: store.read().streamOutcomes })

    expect(heard).toEqual([])
  })

  it('stays quiet, and stamps nothing, when a preference is set to what it is', async () => {
    const store = await storeWith({})
    const settings = store.read().settings
    const stampedAt = store.raw().preferenceUpdatedAt.settings
    const heard: unknown[] = []
    store.subscribe((key) => heard.push(key))

    store.setPreference('settings', { ...settings })

    expect(heard).toEqual([])
    expect(store.raw().preferenceUpdatedAt.settings).toBe(stampedAt)
  })

  it('still reports a real change to a collection', async () => {
    const store = await storeWith({ streamOutcomes: [outcome('a', 1)] })
    const heard: unknown[] = []
    store.subscribe((key) => heard.push(key))

    store.applyPatch({ streamOutcomes: [] })

    expect(heard).toEqual(['streamOutcomes'])
  })
})
