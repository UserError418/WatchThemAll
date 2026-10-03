/**
 * A library file that will not parse is set aside before anything replaces it.
 *
 * The store starts empty in its place, and its next flush writes that empty
 * library over the file. That is only safe once a copy has been kept, and
 * until 2.0.12 a failure to keep one was swallowed: the only copy of the
 * user's library was then overwritten. A copy that was kept went unmentioned,
 * so the user saw an empty library and was never told where theirs was.
 */

import { describe, expect, it } from 'vitest'

import { StoreCore, recoveredLibrary, type StorePersistence } from './core'
import { migrate } from './migrate'
import { ResultStore } from './results'

const DAMAGED = '{"schemaVersion":3,"deviceId":"d","watchlist":[{"id":"w1","title":"Kept for years"'

/** A file that is there and will not parse, and a quarantine that keeps it somewhere or cannot. */
class DamagedFile implements StorePersistence {
  text: string | null = DAMAGED

  constructor(private readonly keptAs: string | Error) {}

  read(): Promise<string | null> {
    return Promise.resolve(this.text)
  }

  write(text: string): Promise<void> {
    this.text = text
    return Promise.resolve()
  }

  quarantine(): Promise<string> {
    return this.keptAs instanceof Error ? Promise.reject(this.keptAs) : Promise.resolve(this.keptAs)
  }
}

describe('a library that will not parse', () => {
  it('is left alone, and nothing is written, when no copy of it can be kept', async () => {
    const file = new DamagedFile(new Error('EBUSY: resource busy or locked'))
    const store = new StoreCore(file, migrate, 'desktop')
    await store.load()

    expect(store.loadFailure).toContain('EBUSY')
    store.patchSettings({ autoNext: false })
    await store.flush()
    expect(file.text).toBe(DAMAGED)
  })

  it('says where the copy was kept when one was', async () => {
    const file = new DamagedFile('/home/user/.config/watchthemall/data/watchthemall.json.corrupt-1')
    const store = new StoreCore(file, migrate, 'desktop')
    await store.load()

    expect(store.loadFailure).toBeNull()
    expect(store.recovered).toBe('/home/user/.config/watchthemall/data/watchthemall.json.corrupt-1')
    expect(recoveredLibrary(store.recovered!)).toContain('watchthemall.json.corrupt-1')
  })

  it('leaves the test history alone too when no copy of it can be kept', async () => {
    const file = new DamagedFile(new Error('EBUSY'))
    const now = Date.UTC(2026, 9, 1)
    const results = new ResultStore(file, () => now)
    await results.load()

    results.record([
      {
        titleKey: 'movie:tt0137523',
        season: null,
        episode: null,
        providerId: 'vidsrc',
        at: now,
        deviceId: 'desktop-1',
        deviceKind: 'desktop',
        origin: 'test',
        verdict: 'stream',
      },
    ])
    await results.flush()
    expect(file.text).toBe(DAMAGED)
  })
})
