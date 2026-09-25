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
