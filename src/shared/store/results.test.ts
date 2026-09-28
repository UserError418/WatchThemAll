import { describe, expect, it } from 'vitest'
import type { SourceResult } from '../sourceresults'
import type { StorePersistence } from './core'
import { ResultStore, type ResultsChange } from './results'

const NOW = 1_800_000_000_000

const result = (at: number, providerId = 'a'): SourceResult => ({
  titleKey: 'tv:tt1',
  season: 1,
  episode: 1,
  providerId,
  at,
  deviceId: 'pc-1',
  deviceKind: 'desktop',
  origin: 'play',
  verdict: 'stream',
  ms: 2_000,
})

/** A file in memory: what is on disk, what was written, and whether it was quarantined. */
function memoryFile(text: string | null | Error) {
  const file = {
    text,
    writes: 0,
    quarantined: false,
    read: async () => {
      if (file.text instanceof Error) throw file.text
      return file.text
    },
    write: async (next: string) => {
      file.text = next
      file.writes += 1
    },
    quarantine: async () => {
      file.quarantined = true
    },
  }
  return file satisfies StorePersistence
}

describe('ResultStore', () => {
  it('starts empty without a file, and writes what it records', async () => {
    const file = memoryFile(null)
    const store = new ResultStore(file, () => NOW)
    await store.load()
    store.record([result(NOW - 1_000)])
    await store.flush()
    expect(JSON.parse(file.text as string)).toEqual({ results: 1, items: [result(NOW - 1_000)] })
  })

  it('reads its file back, dropping anything malformed', async () => {
    const good = result(NOW - 1_000)
    const file = memoryFile(JSON.stringify({ results: 1, items: [good, { ...good, verdict: 'great' }] }))
    const store = new ResultStore(file, () => NOW)
    await store.load()
    expect(store.all()).toEqual([good])
  })

  it('keeps an unparseable file aside and starts again', async () => {
    const file = memoryFile('{"results": 1, "items": [')
    const store = new ResultStore(file, () => NOW)
    await store.load()
    expect(file.quarantined).toBe(true)
    expect(store.all()).toEqual([])
  })

  it('never overwrites a file it could not read', async () => {
    const file = memoryFile(new Error('EACCES'))
    const store = new ResultStore(file, () => NOW)
    await store.load()
    store.record([result(NOW)])
    await store.flush()
    expect(file.writes).toBe(0)
  })

  it("says whether a change was measured here or taken from elsewhere, and writes only when something changed", async () => {
    const file = memoryFile(null)
    const store = new ResultStore(file, () => NOW)
    await store.load()
    const heard: ResultsChange[] = []
    store.subscribe((change) => heard.push(change))
    store.record([result(NOW - 2_000)])
    store.adopt([result(NOW - 2_000), result(NOW - 1_000, 'b')])
    store.record([])
    expect(heard).toEqual(['local', 'remote'])
    await store.flush()
    await store.flush()
    expect(file.writes).toBe(1)
    expect(store.all()).toHaveLength(2)
  })
})
