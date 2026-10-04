/**
 * Another device's clock, when it is wrong.
 *
 * Results are ordered and aged by `at`, which the measuring device stamps
 * with its own clock. One set a day ahead filed results that were never old
 * enough to drop and always the newest to read, and they took the per-episode
 * slots of results measured since.
 */
import { describe, expect, it } from 'vitest'
import type { SourceResult } from '../sourceresults'
import { ResultStore } from './results'

const NOW = 1_800_000_000_000
const MINUTE = 60_000

const result = (at: number, deviceId: string): SourceResult => ({
  titleKey: 'tv:tt1',
  season: 1,
  episode: 1,
  providerId: 'a',
  at,
  deviceId,
  deviceKind: 'desktop',
  origin: 'play',
  verdict: 'stream',
  ms: 2_000,
})

function storeAt(now: () => number): ResultStore {
  return new ResultStore({ read: async () => null, write: async () => {}, quarantine: async () => {} }, now)
}

describe('results from a device whose clock is ahead', () => {
  it('holds back a result stamped well ahead of this clock', () => {
    const store = storeAt(() => NOW)

    store.adopt([result(NOW - MINUTE, 'phone'), result(NOW + 24 * 60 * MINUTE, 'skewed')])

    expect(store.all().map((r) => r.deviceId)).toEqual(['phone'])
  })

  it('takes a result a few minutes ahead, as clocks ordinarily drift', () => {
    const store = storeAt(() => NOW)

    store.adopt([result(NOW + 3 * MINUTE, 'phone')])

    expect(store.all()).toHaveLength(1)
  })

  it('takes it, as stamped, once this clock reaches it', () => {
    let now = NOW
    const store = storeAt(() => now)
    const ahead = result(NOW + 24 * 60 * MINUTE, 'skewed')

    store.adopt([ahead])
    now = ahead.at
    store.adopt([ahead])

    expect(store.all()).toEqual([ahead])
  })
})
