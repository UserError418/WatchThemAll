/**
 * The watchlist tester: what it tests next, and when it holds back.
 *
 * The order is the whole feature from the user's side — whether the title they
 * open next already has its dots — and the holding back is what keeps it from
 * costing them anything. Both are silent when wrong, so both are pinned here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Provider, ProviderScan, WatchlistEntry } from '@shared/types'
import type { WatchlistTestStatus } from '@shared/ipc'
import { RETEST_AFTER_MS } from './providerscan'
import {
  NEW_ENTRY_WINDOW_MS,
  createWatchlistTester,
  episodeToTest,
  planNextTest,
  testedCount,
  testingOrder,
  type WatchlistTesterOptions,
} from './watchlisttester'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

const provider = (id: string): Provider => ({
  id,
  name: id.toUpperCase(),
  rootUrl: `https://${id}.test/`,
  tv: { urlTemplate: '{rootUrl}tv/{imdb}/{season}/{episode}' },
  movie: { urlTemplate: '{rootUrl}movie/{imdb}' },
})

function entry(over: Partial<WatchlistEntry> & { tmdbId: number }): WatchlistEntry {
  return {
    id: `e${over.tmdbId}`,
    type: 'tv',
    title: `Title ${over.tmdbId}`,
    posterPath: null,
    imdbId: `tt${over.tmdbId}`,
    lastSeason: null,
    lastEpisode: null,
    watchedEpisodes: [],
    episodeMarks: {},
    genreIds: [],
    episodeCount: 10,
    rating: 0,
    addedAt: NOW - 30 * DAY,
    providerId: null,
    ...over,
  } as WatchlistEntry
}

/**
 * A stored row as a test writes it today: every green says how its video
 * arrived. A green without that is due again (see `isRetestDue`), which the
 * scheduling tests here are not about.
 */
const row = (tmdbId: number, verdicts: ProviderScan['verdicts'], at = NOW): ProviderScan => ({
  titleKey: `tv:tt${tmdbId}`,
  at,
  verdicts,
  delivery: Object.fromEntries(
    Object.entries(verdicts)
      .filter(([, verdict]) => verdict === 'stream')
      .map(([id]) => [id, 'segmented' as const]),
  ),
})

describe('planNextTest', () => {
  const providers = [provider('a'), provider('b')]

  it('finishes one title before starting the next, in provider order', () => {
    const entries = [entry({ tmdbId: 1 }), entry({ tmdbId: 2 })]
    expect(planNextTest({ entries, providers, scans: [], now: NOW })).toMatchObject({
      titleKey: 'tv:tt1',
      provider: { id: 'a' },
    })
    const scans = [row(1, { a: 'stream' })]
    expect(planNextTest({ entries, providers, scans, now: NOW })).toMatchObject({
      titleKey: 'tv:tt1',
      provider: { id: 'b' },
    })
    scans[0]!.verdicts.b = 'dead'
    expect(planNextTest({ entries, providers, scans, now: NOW })).toMatchObject({ titleKey: 'tv:tt2' })
  })

  it('returns nothing once everything is tested and nothing is due — it stops', () => {
    const entries = [entry({ tmdbId: 1 })]
    const scans = [row(1, { a: 'stream', b: 'dead' })]
    expect(planNextTest({ entries, providers, scans, now: NOW })).toBeNull()
  })

  it('wakes again for a red once it is three days old', () => {
    const entries = [entry({ tmdbId: 1 })]
    const scans = [row(1, { a: 'stream', b: 'dead' }, NOW - RETEST_AFTER_MS.dead)]
    expect(planNextTest({ entries, providers, scans, now: NOW })).toMatchObject({ provider: { id: 'b' } })
  })

  it('passes over titles it was told to skip', () => {
    const entries = [entry({ tmdbId: 1 }), entry({ tmdbId: 2 })]
    const plan = planNextTest({ entries, providers, scans: [], now: NOW, skip: new Set(['tv:tt1']) })
    expect(plan?.titleKey).toBe('tv:tt2')
  })
})

describe('testingOrder', () => {
  it("follows the Watchlist tab: a show in progress before one not started", () => {
    const started = entry({ tmdbId: 1, episodeMarks: { '1:3': { watched: true, at: NOW - DAY } } })
    const untouched = entry({ tmdbId: 2 })
    const order = testingOrder([untouched, started], [], [row(2, { a: 'stream' })], () => null, NOW)
    expect(order.map((e) => e.tmdbId)).toEqual([1, 2])
  })

  it('puts a show added this week and never tested first, newest first', () => {
    const started = entry({ tmdbId: 1, episodeMarks: { '1:3': { watched: true, at: NOW - DAY } } })
    const older = entry({ tmdbId: 2, addedAt: NOW - 2 * DAY })
    const newest = entry({ tmdbId: 3, addedAt: NOW - DAY })
    const order = testingOrder([started, older, newest], [], [], () => null, NOW)
    expect(order.map((e) => e.tmdbId)).toEqual([3, 2, 1])
  })

  it('leaves out entries kept only for their ticks', () => {
    const listed = entry({ tmdbId: 1 })
    const unlisted = entry({ tmdbId: 2, listed: false, addedAt: NOW - DAY })
    expect(testingOrder([unlisted, listed], [], [], () => null, NOW).map((e) => e.tmdbId)).toEqual([1])
  })

  it('does not let an old addition jump the queue', () => {
    const started = entry({ tmdbId: 1, episodeMarks: { '1:3': { watched: true, at: NOW - DAY } } })
    const old = entry({ tmdbId: 2, addedAt: NOW - NEW_ENTRY_WINDOW_MS - 1 })
    expect(testingOrder([old, started], [], [], () => null, NOW).map((e) => e.tmdbId)).toEqual([1, 2])
  })
})

describe('episodeToTest', () => {
  it('tests a series on the episode the user is on', () => {
    expect(episodeToTest(entry({ tmdbId: 1, lastSeason: 3, lastEpisode: 5 }), null)).toEqual({ season: 3, episode: 5 })
  })

  it('falls back to S1E1 for a show just added', () => {
    expect(episodeToTest(entry({ tmdbId: 1 }), null)).toEqual({ season: 1, episode: 1 })
  })

  it('has no episode for a film', () => {
    expect(episodeToTest(entry({ tmdbId: 1, type: 'movie' }), null)).toBeNull()
  })

  it('never tests past the last aired episode', () => {
    // Finished the latest season: where the user is, is a season still to come.
    const finished = entry({ tmdbId: 1, lastSeason: 3, lastEpisode: 1 })
    const lastAired = { season: 2, episode: 12, name: 'Finale', airDate: '2026-06-01' }
    expect(episodeToTest(finished, lastAired)).toEqual({ season: 2, episode: 12 })
  })

  it('keeps an aired episode the user is on', () => {
    const midway = entry({ tmdbId: 1, lastSeason: 2, lastEpisode: 4 })
    const lastAired = { season: 2, episode: 12, name: 'Finale', airDate: '2026-06-01' }
    expect(episodeToTest(midway, lastAired)).toEqual({ season: 2, episode: 4 })
  })
})

describe('testedCount', () => {
  it('counts pairs whose result is not yet due, of all pairs', () => {
    const entries = [entry({ tmdbId: 1 }), entry({ tmdbId: 2 })]
    const providers = [provider('a'), provider('b')]
    const scans = [row(1, { a: 'stream', b: 'dead' }, NOW - RETEST_AFTER_MS.dead)]
    // a: fresh green; b: red due again. Title 2 untested.
    expect(testedCount({ entries, providers, scans, now: NOW })).toEqual({ done: 1, total: 4 })
  })
})

describe('the tester loop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  function harness(over: Partial<WatchlistTesterOptions> = {}) {
    const saved: ProviderScan[] = []
    const statuses: WatchlistTestStatus[] = []
    const probeOne = vi.fn(async (titleKey: string, _subject: unknown, p: Provider): Promise<ProviderScan> => ({
      titleKey,
      at: Date.now(),
      verdicts: { [p.id]: 'stream' },
    }))
    const tester = createWatchlistTester({
      watchlist: () => [entry({ tmdbId: 1 })],
      history: () => [],
      scans: () => saved,
      filmPercent: () => null,
      providers: () => [provider('a')],
      lookUp: async () => ({ released: true, imdbId: 'tt1', lastAired: null }),
      probeOne,
      pausedFor: () => null,
      save: (result) => saved.push(result),
      onStatus: (status) => statuses.push(status),
      intervalMs: 60_000,
      startDelayMs: 1_000,
      ...over,
    })
    return { tester, saved, statuses, probeOne }
  }

  it('tests after its start delay, and keeps the result', async () => {
    const { tester, saved, probeOne } = harness()
    tester.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(probeOne).toHaveBeenCalledTimes(1)
    expect(saved[0]?.verdicts).toEqual({ a: 'stream' })
    tester.stop()
  })

  it('waits while the user is watching, and says why', async () => {
    const { tester, probeOne, statuses } = harness({ pausedFor: () => 'playback' })
    tester.start()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(probeOne).not.toHaveBeenCalled()
    expect(statuses.at(-1)).toMatchObject({ state: 'paused', pausedFor: 'playback' })
    tester.stop()
  })

  it('skips a tick rather than testing when the title lookup fails (offline)', async () => {
    const { tester, probeOne } = harness({ lookUp: async () => null })
    tester.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(probeOne).not.toHaveBeenCalled()
    tester.stop()
  })

  it('never tests an unreleased title', async () => {
    const { tester, probeOne, statuses } = harness({ lookUp: async () => ({ released: false, imdbId: 'tt1', lastAired: null }) })
    tester.start()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(probeOne).not.toHaveBeenCalled()
    // And the unreleased title is not counted as work outstanding.
    expect(statuses.at(-1)).toMatchObject({ total: 0 })
    tester.stop()
  })

  it('tests one provider a minute, not faster', async () => {
    const { tester, probeOne } = harness({ providers: () => [provider('a'), provider('b'), provider('c')] })
    tester.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(probeOne).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(59_000)
    expect(probeOne).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(probeOne).toHaveBeenCalledTimes(2)
    tester.stop()
  })
})
