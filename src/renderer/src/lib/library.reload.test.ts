/**
 * How the library follows the store after the platform reports a change.
 *
 * The part worth pinning is what a reload *leaves alone*: every reassigned
 * field re-derives the views built on it, and until 2026-09-27 each report
 * reassigned all of them, once per changed key. And the race: a read that was
 * in flight while the user changed something must not put the old copy back.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaSummary, Provider, StoreShape } from '@shared/types'

/** Resolvers for reads in flight, so a test decides when each one lands. */
let pendingReads: Array<(doc: StoreShape) => void> = []
const read = vi.fn(() => new Promise<StoreShape>((resolve) => pendingReads.push(resolve)))
const list = vi.fn(async (): Promise<Provider[]> => [{ id: 'fresh' } as Provider])
const write = vi.fn(async () => {})
vi.stubGlobal('window', { wta: { store: { read, write }, providers: { list } } })

const { library } = await import('./library.svelte')

/** A stored document with just the fields these tests look at. */
function stored(fields: Partial<StoreShape>): StoreShape {
  return {
    watchlist: [],
    trackers: [],
    history: [],
    watched: [],
    ratings: [],
    resumePoints: [],
    customProviders: [],
    activeProviderIds: [],
    knownProviderIds: [],
    favouriteProviderIds: [],
    providerOrder: [],
    settings: library.settings,
    ...fields,
  } as StoreShape
}

/** Let every awaited promise settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  pendingReads = []
  read.mockClear()
  list.mockClear()
  write.mockClear()
})

describe('reload', () => {
  it('reassigns only the fields that changed', async () => {
    const watched = library.watched
    const done = library.reload(['trackers'])
    pendingReads.shift()!(stored({ trackers: [{ id: 't1' }] as StoreShape['trackers'], watched: [{}] as StoreShape['watched'] }))
    await done

    expect(library.trackers).toHaveLength(1)
    expect(library.watched).toBe(watched)
    expect(list).not.toHaveBeenCalled()
  })

  it('reads nothing for a change it does not show', async () => {
    await library.reload(['providerScans', 'streamOutcomes'])
    expect(read).not.toHaveBeenCalled()
  })

  it('re-reads the provider list for everything', async () => {
    const done = library.reload(null)
    pendingReads.shift()!(stored({}))
    await done

    expect(list).toHaveBeenCalledTimes(1)
    expect(library.providers.map((p) => p.id)).toEqual(['fresh'])
  })

  it('runs one read at a time and reads what arrived meanwhile after it', async () => {
    const done = library.reload(['trackers'])
    void library.reload(['watched'])
    void library.reload(['ratings'])
    expect(read).toHaveBeenCalledTimes(1)

    pendingReads.shift()!(stored({}))
    await settle()
    expect(read).toHaveBeenCalledTimes(2)
    pendingReads.shift()!(stored({}))
    await done
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('does not put back an older copy over a change made while it read', async () => {
    const media = { tmdbId: 1396, imdbId: 'tt0903747', type: 'tv', title: 'Breaking Bad', genreIds: [] } as unknown as MediaSummary
    library.ratings = []
    const done = library.reload(['ratings'])

    // The user rates while the read is in flight; the read predates it.
    library.rate(media, 7)
    pendingReads.shift()!(stored({ ratings: [] }))
    await settle()
    expect(library.ratings).toHaveLength(1)

    // It reads again, and the second copy (which has the write) is applied.
    expect(read).toHaveBeenCalledTimes(2)
    pendingReads.shift()!(stored({ ratings: library.ratings as StoreShape['ratings'] }))
    await done
    expect(library.ratings).toHaveLength(1)
  })
})
