import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SourceResult } from '../sourceresults'
import { ResultStore } from './results'
import { batchResultChanges } from './resultsbatch'

describe('batchResultChanges', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reports a burst once, naming each title once', () => {
    const heard: string[][] = []
    const listener = batchResultChanges((keys) => heard.push(keys), 250)

    // A test run files its sources, a play files its time, a sync brings more.
    listener(['tv:tt1'])
    listener(['tv:tt1', 'movie:tt2'])
    listener(['tv:tt3'])
    expect(heard).toEqual([])

    vi.advanceTimersByTime(250)
    expect(heard).toEqual([['tv:tt1', 'movie:tt2', 'tv:tt3']])
  })

  it('reports a long stream of changes once per window, not once per change', () => {
    const heard: string[][] = []
    const listener = batchResultChanges((keys) => heard.push(keys), 250)

    for (let i = 0; i < 20; i += 1) {
      listener([`tv:tt${i % 2}`])
      vi.advanceTimersByTime(50)
    }
    // A thousand milliseconds of changes: four windows, never twenty reports.
    expect(heard.map((keys) => [...keys].sort())).toEqual(Array(4).fill(['tv:tt0', 'tv:tt1']))
  })

  it('starts no batch for a change that touched no title', () => {
    const heard: string[][] = []
    const listener = batchResultChanges((keys) => heard.push(keys), 250)

    listener([])
    vi.advanceTimersByTime(1_000)
    expect(heard).toEqual([])
  })

  it('starts a fresh batch after delivering one', () => {
    const heard: string[][] = []
    const listener = batchResultChanges((keys) => heard.push(keys), 250)

    listener(['tv:tt1'])
    vi.advanceTimersByTime(250)
    listener(['movie:tt2'])
    vi.advanceTimersByTime(250)
    expect(heard).toEqual([['tv:tt1'], ['movie:tt2']])
  })
})

describe('the result store, announced as main and the bridge announce it', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const NOW = 1_800_000_000_000
  const result = (titleKey: string, at: number, providerId: string): SourceResult => ({
    titleKey,
    season: null,
    episode: null,
    providerId,
    at,
    deviceId: 'pc-1',
    deviceKind: 'desktop',
    origin: 'test',
    verdict: 'stream',
  })

  it('turns a test run and a large sync arriving together into one announcement', async () => {
    const store = new ResultStore(
      { read: async () => null, write: async () => {}, quarantine: async () => {} },
      () => NOW,
    )
    await store.load()
    const announced: string[][] = []
    const announce = batchResultChanges((titleKeys) => announced.push(titleKeys))
    store.subscribe((_change, titleKeys) => announce(titleKeys))

    // A run files nine sources of one title at once.
    store.record(Array.from({ length: 9 }, (_, i) => result('tv:tt1', NOW - 1_000, `p${i}`)))
    // A sync brings three hundred results over forty titles.
    const synced = Array.from({ length: 300 }, (_, i) =>
      result(`movie:tt${100 + (i % 40)}`, NOW - 10_000 - i, 'p0'),
    )
    store.adopt([...store.all(), ...synced])
    expect(announced).toEqual([])

    vi.advanceTimersByTime(250)
    expect(announced).toHaveLength(1)
    expect(announced[0]).toHaveLength(41)
    expect(announced[0]).toContain('tv:tt1')
  })
})
