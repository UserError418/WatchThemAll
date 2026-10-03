import { describe, expect, it } from 'vitest'

import type { WatchlistEntry } from '@shared/types'
import { AUTO_TEST_AFTER_ADD_MS, AutoTester, FRESH_ADDITION_MS, dueAfterAdding, dueWhileWatching, type AutoTestMode } from './autotest'

const NOW = Date.UTC(2026, 8, 29, 20)

const entry = (tmdbId: number, addedAt: number, extra: Partial<WatchlistEntry> = {}): WatchlistEntry =>
  ({ id: `w${tmdbId}`, tmdbId, imdbId: `tt${tmdbId}`, type: 'tv', title: `Show ${tmdbId}`, addedAt, ...extra }) as WatchlistEntry

const untested = (): boolean => false

describe('dueAfterAdding', () => {
  it('waits ten minutes after an addition, then takes the freshest', () => {
    const list = [entry(1, NOW - AUTO_TEST_AFTER_ADD_MS - 60_000), entry(2, NOW - AUTO_TEST_AFTER_ADD_MS), entry(3, NOW - 60_000)]
    expect(dueAfterAdding(list, untested, NOW)?.tmdbId).toBe(2)
  })

  it('leaves what this kind has tested, what is not listed, and what is not fresh', () => {
    const list = [
      entry(1, NOW - AUTO_TEST_AFTER_ADD_MS),
      entry(2, NOW - AUTO_TEST_AFTER_ADD_MS, { listed: false }),
      entry(3, NOW - FRESH_ADDITION_MS - 1),
    ]
    expect(dueAfterAdding(list, (key) => key.endsWith('tt1'), NOW)).toBeNull()
  })

  it('does not try a title twice in a session', () => {
    const list = [entry(1, NOW - AUTO_TEST_AFTER_ADD_MS)]
    expect(dueAfterAdding(list, untested, NOW, new Set(['tv:tt1']))).toBeNull()
  })
})

describe('dueWhileWatching', () => {
  it('is due for a listed title this kind never tested', () => {
    expect(dueWhileWatching(entry(1, NOW), untested)).toBe(true)
    expect(dueWhileWatching(entry(1, NOW), () => true)).toBe(false)
    expect(dueWhileWatching(entry(1, NOW, { listed: false }), untested)).toBe(false)
    expect(dueWhileWatching(undefined, untested)).toBe(false)
  })
})

describe('AutoTester', () => {
  function tester(playing: { tmdbId: number; type: 'tv' | 'movie' } | null, list: WatchlistEntry[]) {
    const runs: Array<[number, AutoTestMode]> = []
    let finish: () => void = () => {}
    const auto = new AutoTester({
      watchlist: () => list,
      tested: untested,
      playing: () => playing,
      busy: () => false,
      run: (e, mode) => {
        runs.push([e.tmdbId, mode])
        return new Promise<void>((resolve) => (finish = resolve))
      },
      now: () => NOW,
    })
    return { auto, runs, finish: () => finish() }
  }

  it('tests the title being watched for the first time, gently, and nothing else meanwhile', () => {
    const { auto, runs } = tester({ tmdbId: 5, type: 'tv' }, [entry(5, NOW), entry(1, NOW - AUTO_TEST_AFTER_ADD_MS)])
    auto.tick()
    auto.tick()
    expect(runs).toEqual([[5, 'watching']])
  })

  /** The bug: a film sharing a watchlisted series' TMDB id started a full test of the series. */
  it('does not take a film for the series that shares its id', () => {
    const { auto, runs } = tester({ tmdbId: 5, type: 'movie' }, [entry(5, NOW)])
    auto.tick()
    expect(runs).toEqual([])
  })

  it('tests a standing addition only while nothing plays', () => {
    const list = [entry(1, NOW - AUTO_TEST_AFTER_ADD_MS)]
    const watching = tester({ tmdbId: 9, type: 'tv' }, list)
    watching.auto.tick()
    expect(watching.runs).toEqual([])

    const idle = tester(null, list)
    idle.auto.tick()
    expect(idle.runs).toEqual([[1, 'idle']])
  })

  it('runs one at a time, and never the same title twice', async () => {
    const { auto, runs, finish } = tester(null, [entry(1, NOW - AUTO_TEST_AFTER_ADD_MS)])
    auto.tick()
    auto.tick()
    finish()
    await new Promise((resolve) => setTimeout(resolve, 0))
    auto.tick()
    expect(runs).toEqual([[1, 'idle']])
  })
})
