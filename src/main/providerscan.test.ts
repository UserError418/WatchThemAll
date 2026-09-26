/**
 * The scan's pure half: what a verdict means for the order Automatic walks.
 *
 * Worth testing heavily for the same reason `outcomes.test.ts` is — being wrong
 * here is silent. A provider sorted into the wrong tier does not throw; the app
 * simply plays the second-best source, or spends twenty seconds on one that was
 * measured dead a minute ago, and nothing anywhere says so.
 */

import { describe, expect, it } from 'vitest'
import type { Provider, SourceSortKey } from '@shared/types'
import type { ProviderScan } from '@shared/ipc'
import {
  MAX_SCANS,
  RESULT_TTL_MS,
  RETEST_AFTER_MS,
  freshScan,
  isRetestDue,
  providerRank,
  pruneScans,
  recordCast,
  recordScan,
  resumeFirst,
  scanAwareOrder,
  scanEpisode,
  scanProgress,
} from './providerscan'

const provider = (id: string): Provider => ({
  id,
  name: id,
  rootUrl: `https://${id}.test/`,
  tv: { urlTemplate: '{rootUrl}tv/{imdb}/{season}/{episode}' },
  movie: { urlTemplate: '{rootUrl}movie/{imdb}' },
})

const scanOf = (verdicts: ProviderScan['verdicts'], at = Date.now()): ProviderScan => ({
  titleKey: 'tv:tt1',
  at,
  verdicts,
})

describe('providerRank', () => {
  it('puts a just-measured stream above a provider that merely played before', () => {
    expect(providerRank(undefined, 'stream')).toBeLessThan(providerRank('worked', undefined))
  })

  it('puts a just-measured dead provider below one that failed historically', () => {
    // The fresher fact wins in both directions, which is the whole reason a
    // scan is worth running on a title the user has already tried.
    expect(providerRank('failed', undefined)).toBeLessThan(providerRank(undefined, 'dead'))
  })

  it('ranks "alive but no stream" above never-tried, and below history of working', () => {
    expect(providerRank('worked', undefined)).toBeLessThan(providerRank(undefined, 'unsure'))
    expect(providerRank(undefined, 'unsure')).toBeLessThan(providerRank(undefined, undefined))
  })

  it('treats no evidence at all as better than a recorded failure', () => {
    expect(providerRank(undefined, undefined)).toBeLessThan(providerRank('failed', undefined))
  })

  it('lets a fresh stream verdict rescue a provider that failed before', () => {
    // The case the feature exists for: a provider that was broken last week and
    // works today must not stay buried under its own history.
    expect(providerRank('failed', 'stream')).toBe(providerRank(undefined, 'stream'))
  })
})

describe('scanAwareOrder', () => {
  const providers = [provider('a'), provider('b'), provider('c')]

  it('degrades to the user order when there is no scan', () => {
    const order = scanAwareOrder(providers, {}, { order: ['c', 'b', 'a'] })
    expect(order.map((p) => p.id)).toEqual(['c', 'b', 'a'])
  })

  it('promotes the measured-working source over the user order', () => {
    const order = scanAwareOrder(
      providers,
      {},
      { order: ['a', 'b', 'c'], scan: scanOf({ a: 'dead', b: 'unsure', c: 'stream' }) },
    )
    expect(order.map((p) => p.id)).toEqual(['c', 'b', 'a'])
  })

  it('keeps the user order within a tier', () => {
    const order = scanAwareOrder(
      providers,
      {},
      { order: ['c', 'b', 'a'], scan: scanOf({ a: 'stream', b: 'stream', c: 'stream' }) },
    )
    expect(order.map((p) => p.id)).toEqual(['c', 'b', 'a'])
  })

  it('leads a tier with favourites but never lifts one out of its tier', () => {
    // A starred provider measured dead must still lose to one measured working,
    // or the star silently becomes an instruction to play something broken.
    const order = scanAwareOrder(
      providers,
      {},
      {
        order: ['a', 'b', 'c'],
        favouriteIds: ['a'],
        scan: scanOf({ a: 'dead', b: 'stream', c: 'stream' }),
      },
    )
    expect(order.map((p) => p.id)).toEqual(['b', 'c', 'a'])
  })

  it('puts a favourite first among equals', () => {
    const order = scanAwareOrder(
      providers,
      {},
      { order: ['a', 'b', 'c'], favouriteIds: ['c'], scan: scanOf({}) },
    )
    expect(order.map((p) => p.id)).toEqual(['c', 'a', 'b'])
  })

  it('never drops a provider, however bad its verdict', () => {
    // Demote, never filter: if every measured source fails right now, Automatic
    // still has the rest to walk rather than a dead end.
    const order = scanAwareOrder(
      providers,
      {},
      { order: ['a', 'b', 'c'], scan: scanOf({ a: 'dead', b: 'dead', c: 'dead' }) },
    )
    expect(order.map((p) => p.id)).toEqual(['a', 'b', 'c'])
  })

  it('is stable for providers the user has never placed', () => {
    const order = scanAwareOrder(providers, {}, { order: [] })
    expect(order.map((p) => p.id)).toEqual(['a', 'b', 'c'])
  })

  it('combines history and measurement across tiers', () => {
    const order = scanAwareOrder(
      [provider('played'), provider('measured'), provider('unknown'), provider('broken')],
      { played: 'worked', broken: 'failed' },
      {
        order: ['played', 'measured', 'unknown', 'broken'],
        scan: scanOf({ measured: 'stream', broken: 'dead' }),
      },
    )
    expect(order.map((p) => p.id)).toEqual(['measured', 'played', 'unknown', 'broken'])
  })
})

/**
 * The user's chain of keys inside each tier: `Settings.sourceOrder`.
 *
 * Five streaming providers, listed a–e, with start times and qualities chosen
 * so every key gives a different answer — a test that passes under the wrong
 * key proves nothing.
 */
describe('scanAwareOrder with a source order', () => {
  const five = ['a', 'b', 'c', 'd', 'e'].map(provider)
  const measured = (
    timings: Record<string, number>,
    qualities: Record<string, number> = {},
    verdicts: ProviderScan['verdicts'] = { a: 'stream', b: 'stream', c: 'stream', d: 'stream', e: 'stream' },
  ): ProviderScan => ({ ...scanOf(verdicts), timings, qualities })
  const ids = (list: Provider[]): string[] => list.map((p) => p.id)
  const run = (scan: ProviderScan, sourceOrder: SourceSortKey[], favouriteIds: string[] = []) =>
    ids(scanAwareOrder(five, {}, { order: ['a', 'b', 'c', 'd', 'e'], favouriteIds, scan, sourceOrder }))

  it('ignores speed and quality while the list comes first, which is the default', () => {
    const scan = measured({ a: 9_000, b: 1_000 }, { a: 480, b: 1080 })
    expect(run(scan, ['list', 'speed', 'quality'])).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('puts the fastest first when speed leads', () => {
    const scan = measured({ a: 9_000, b: 1_000, c: 4_000, d: 2_000, e: 14_000 })
    expect(run(scan, ['speed', 'quality', 'list'])).toEqual(['b', 'd', 'c', 'a', 'e'])
  })

  it('lets the next key decide between sources of about the same speed', () => {
    // b and d are within 30% of each other; d offers the better picture.
    const scan = measured({ b: 3_000, d: 3_600, a: 9_000 }, { b: 720, d: 1080 })
    expect(run(scan, ['speed', 'quality', 'list']).slice(0, 3)).toEqual(['d', 'b', 'a'])
  })

  it('measures "the same speed" from the fastest of a group, so the answer does not drift', () => {
    // 1.0 is close to 1.25, and 1.25 to 1.6, but 1.6 is not close to 1.0.
    const scan = measured({ c: 1_600, b: 1_250, a: 1_000 }, { c: 1080, b: 480, a: 480 })
    expect(run(scan, ['speed', 'quality', 'list']).slice(0, 3)).toEqual(['a', 'b', 'c'])
  })

  it('treats starts less than half a second apart as the same speed', () => {
    // 0.7 s and 1.1 s are 57% apart, but the phone cannot time finer than 0.5 s.
    const scan = measured({ a: 1_100, b: 700 }, { a: 1080, b: 720 })
    expect(run(scan, ['speed', 'quality', 'list']).slice(0, 2)).toEqual(['a', 'b'])
  })

  it('breaks the last ties with favourites, then the provider order', () => {
    const scan = measured({ a: 2_000, b: 2_100, c: 2_050 })
    expect(run(scan, ['speed', 'quality', 'list'], ['c'])).toEqual(['c', 'a', 'b', 'd', 'e'])
  })

  it('orders by quality first when asked, and by speed among equals', () => {
    const scan = measured({ a: 5_000, b: 1_000, c: 2_000 }, { a: 1080, b: 720, c: 1080 })
    expect(run(scan, ['quality', 'speed', 'list']).slice(0, 3)).toEqual(['c', 'a', 'b'])
  })

  it('puts a source with no measurement after the measured ones in its tier', () => {
    const scan = measured({ c: 3_000 }, { e: 1080 })
    expect(run(scan, ['speed', 'list', 'quality'])[0]).toBe('c')
    expect(run(scan, ['quality', 'list', 'speed'])[0]).toBe('e')
  })

  it('never lets speed lift a source out of its tier', () => {
    // "may work" is below "works" however it is sorted inside.
    const scan = measured({ a: 500, b: 12_000 }, {}, { a: 'unsure', b: 'stream', c: 'dead' })
    const order = run(scan, ['speed', 'quality', 'list'])
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a'))
    expect(order.at(-1)).toBe('c')
  })
})

describe('scanEpisode', () => {
  it('leaves a movie without an episode', () => {
    expect(scanEpisode('movie', null)).toBeNull()
  })

  it('passes a real episode through', () => {
    expect(scanEpisode('tv', { season: 4, episode: 7 })).toEqual({ season: 4, episode: 7 })
  })

  it('falls back to the first episode when a series is given none', () => {
    // The bug this exists for: a TV request with no episode renders no URL at
    // all, so every provider came back `no-template` and the user was shown a
    // full row of red dots for sources that were never contacted.
    expect(scanEpisode('tv', null)).toEqual({ season: 1, episode: 1 })
    expect(scanEpisode('tv', undefined)).toEqual({ season: 1, episode: 1 })
  })

  it('rejects a nonsense position rather than probing season zero', () => {
    expect(scanEpisode('tv', { season: 0, episode: 0 })).toEqual({ season: 1, episode: 1 })
  })
})

describe('freshScan', () => {
  const now = 1_700_000_000_000
  const day = 24 * 60 * 60 * 1000

  it('returns results taken within the window', () => {
    const scans = [scanOf({ a: 'stream' }, now - 60_000)]
    expect(freshScan(scans, 'tv:tt1', now)?.verdicts).toEqual({ a: 'stream' })
  })

  it('keeps a result for thirty days', () => {
    const scans = [scanOf({ a: 'dead' }, now - 29 * day)]
    expect(freshScan(scans, 'tv:tt1', now)?.verdicts).toEqual({ a: 'dead' })
  })

  it('discards one that has aged out rather than showing it faded', () => {
    const scans = [scanOf({ a: 'stream' }, now - RESULT_TTL_MS - 1)]
    expect(freshScan(scans, 'tv:tt1', now)).toBeNull()
  })

  it('ages each provider on its own clock, keeping the rest of the row', () => {
    const row: ProviderScan = {
      titleKey: 'tv:tt1',
      at: now - day,
      verdicts: { old: 'stream', recent: 'dead' },
      testedAt: { old: now - RESULT_TTL_MS - 1, recent: now - day },
      reasons: { recent: { kind: 'error', status: 500 } },
    }
    const fresh = freshScan([row], 'tv:tt1', now)
    expect(fresh?.verdicts).toEqual({ recent: 'dead' })
    expect(fresh?.reasons).toEqual({ recent: { kind: 'error', status: 500 } })
    expect(fresh?.at).toBe(now - day)
  })

  it('lets a real play since the test overrule a red or amber result', () => {
    // Nobody clicks a red source, so without this a wrong red would hide a
    // working one for a month — and a red outranks play history.
    const scans = [scanOf({ red: 'dead', amber: 'unsure', green: 'stream' }, now - 2 * day)]
    const fresh = freshScan(scans, 'tv:tt1', now, { red: now - day, amber: now - day, green: now - day })
    expect(fresh?.verdicts).toEqual({ green: 'stream' })
  })

  it('keeps a red that is newer than the last play', () => {
    const scans = [scanOf({ red: 'dead' }, now - day)]
    expect(freshScan(scans, 'tv:tt1', now, { red: now - 2 * day })?.verdicts).toEqual({ red: 'dead' })
  })

  it('returns null for a title that has never been scanned', () => {
    expect(freshScan([scanOf({ a: 'stream' }, now)], 'movie:tt9', now)).toBeNull()
  })
})

describe('recordScan', () => {
  it('merges per provider: a new result replaces only the providers it measured', () => {
    // The background tester writes one provider at a time; a row replaced
    // whole would forget every other provider each time.
    const first: ProviderScan = { titleKey: 'tv:tt1', at: 1, verdicts: { a: 'stream', b: 'dead' } }
    const second: ProviderScan = { titleKey: 'tv:tt1', at: 2, verdicts: { b: 'stream' } }
    const [merged] = recordScan([first], second)
    expect(merged?.verdicts).toEqual({ a: 'stream', b: 'stream' })
    // Each keeps its own test time; an old row's providers were tested at its `at`.
    expect(merged?.testedAt).toEqual({ a: 1, b: 2 })
    expect(merged?.at).toBe(2)
  })

  it("replaces a re-tested provider's details entirely, clearing stale ones", () => {
    const first: ProviderScan = {
      titleKey: 'tv:tt1',
      at: 1,
      verdicts: { a: 'dead', b: 'stream' },
      timings: { b: 900 },
      reasons: { a: { kind: 'timeout', seconds: 20 } },
    }
    const second: ProviderScan = {
      titleKey: 'tv:tt1',
      at: 2,
      verdicts: { a: 'stream', b: 'dead' },
      timings: { a: 1200 },
      reasons: { b: { kind: 'error', status: 500 } },
    }
    const [merged] = recordScan([first], second)
    expect(merged?.timings).toEqual({ a: 1200 })
    expect(merged?.reasons).toEqual({ b: { kind: 'error', status: 500 } })
  })

  it('treats how the video arrived and what a TV said like every other detail', () => {
    const first: ProviderScan = {
      titleKey: 'tv:tt1',
      at: 1,
      verdicts: { a: 'stream', b: 'stream' },
      delivery: { a: 'progressive', b: 'progressive' },
      casts: { a: 'played' },
    }
    // `a` re-tested and now serves a playlist; `b` untouched.
    const second: ProviderScan = { titleKey: 'tv:tt1', at: 2, verdicts: { a: 'stream' }, delivery: { a: 'segmented' } }
    const [merged] = recordScan([first], second)
    expect(merged?.delivery).toEqual({ a: 'segmented', b: 'progressive' })
    // The cast that played was of the file `a` no longer hands out.
    expect(merged?.casts).toEqual({})
  })

  it('keeps scans of other titles', () => {
    const other = { titleKey: 'movie:tt2', at: 1, verdicts: {} }
    const next = recordScan([other], { titleKey: 'tv:tt1', at: 2, verdicts: {} })
    expect(next.map((s) => s.titleKey)).toEqual(['movie:tt2', 'tv:tt1'])
  })

  it('drops the least recently updated once full', () => {
    let scans: ProviderScan[] = []
    for (let i = 0; i < MAX_SCANS + 5; i += 1) {
      scans = recordScan(scans, { titleKey: `tv:tt${i}`, at: i, verdicts: {} })
    }
    expect(scans).toHaveLength(MAX_SCANS)
    expect(scans[0]?.titleKey).toBe('tv:tt5')
  })
})

describe('isRetestDue', () => {
  const now = 1_700_000_000_000
  // Greens as they are recorded today, saying how their video arrived.
  const at = (verdict: ProviderScan['verdicts'][string], age: number): ProviderScan => ({
    ...scanOf({ a: verdict }, now - age),
    ...(verdict === 'stream' ? { delivery: { a: 'segmented' as const } } : {}),
  })

  it('re-tests a green once when it does not say how its video arrived', () => {
    // Stored before deliveries were recorded: nobody can say whether it casts.
    expect(isRetestDue(scanOf({ a: 'stream' }, now - 1000), 'a', now)).toBe(true)
    // `unknown` is an answer, so it is not due again for that reason.
    expect(isRetestDue({ ...scanOf({ a: 'stream' }, now - 1000), delivery: { a: 'unknown' } }, 'a', now)).toBe(false)
    // Only greens: a red has no delivery to record.
    expect(isRetestDue(scanOf({ a: 'dead' }, now - 1000), 'a', now)).toBe(false)
  })

  it('is due for a provider never tested', () => {
    expect(isRetestDue(undefined, 'a', now)).toBe(true)
    expect(isRetestDue(scanOf({ b: 'stream' }, now), 'a', now)).toBe(true)
  })

  it('re-tests reds after three days, ambers after four, greens after thirty', () => {
    expect(isRetestDue(at('dead', RETEST_AFTER_MS.dead - 1), 'a', now)).toBe(false)
    expect(isRetestDue(at('dead', RETEST_AFTER_MS.dead), 'a', now)).toBe(true)
    expect(isRetestDue(at('unsure', RETEST_AFTER_MS.unsure - 1), 'a', now)).toBe(false)
    expect(isRetestDue(at('unsure', RETEST_AFTER_MS.unsure), 'a', now)).toBe(true)
    expect(isRetestDue(at('stream', RESULT_TTL_MS - 1), 'a', now)).toBe(false)
    expect(isRetestDue(at('stream', RESULT_TTL_MS), 'a', now)).toBe(true)
  })

  it("judges by the provider's own test time, not the row's", () => {
    const row: ProviderScan = {
      titleKey: 'tv:tt1',
      at: now,
      verdicts: { a: 'dead', b: 'dead' },
      testedAt: { a: now - RETEST_AFTER_MS.dead, b: now },
    }
    expect(isRetestDue(row, 'a', now)).toBe(true)
    expect(isRetestDue(row, 'b', now)).toBe(false)
  })
})

describe('pruneScans', () => {
  it('drops expired results, and rows left empty by that', () => {
    const now = 1_700_000_000_000
    const scans: ProviderScan[] = [
      { titleKey: 'fresh', at: now - 1_000, verdicts: { a: 'stream' } },
      { titleKey: 'stale', at: now - RESULT_TTL_MS - 1, verdicts: { a: 'stream' } },
      {
        titleKey: 'mixed',
        at: now,
        verdicts: { a: 'stream', b: 'dead' },
        testedAt: { a: now, b: now - RESULT_TTL_MS - 1 },
      },
    ]
    const pruned = pruneScans(scans, now)
    expect(pruned.map((s) => s.titleKey)).toEqual(['fresh', 'mixed'])
    expect(pruned[1]?.verdicts).toEqual({ a: 'stream' })
  })
})

describe('scanProgress', () => {
  it('counts settled providers and the ones that streamed', () => {
    const progress = scanProgress({ a: 'stream', b: 'dead', c: 'stream' }, 5)
    expect(progress).toEqual({ done: 3, total: 5, working: 2 })
  })

  it('reports nothing done for a scan that has not started', () => {
    expect(scanProgress({}, 4)).toEqual({ done: 0, total: 4, working: 0 })
  })
})

describe('resumeFirst', () => {
  const ordered = ['a', 'b', 'c', 'd'].map(provider)
  const ids = (list: Provider[]): string[] => list.map((p) => p.id)

  it('starts on the source the title was last watched on, and says where it was', () => {
    // The case this exists for: the ordering puts A first, the user watched on
    // C, and coming back should not mean waiting on A again.
    const result = resumeFirst(ordered, 'c', { c: 'worked' }, null)
    expect(ids(result.providers)).toEqual(['c', 'a', 'b', 'd'])
    expect(result.resume).toEqual({ providerId: 'c', movedFrom: 2 })
  })

  it('keeps the fallback chain in its order behind the resume source', () => {
    // If the resume source fails tonight, Automatic carries on exactly as it
    // would have without it.
    expect(ids(resumeFirst(ordered, 'd', { d: 'worked' }, null).providers)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('reports no move when the resume source was first anyway', () => {
    const result = resumeFirst(ordered, 'a', { a: 'worked' }, null)
    expect(ids(result.providers)).toEqual(['a', 'b', 'c', 'd'])
    expect(result.resume).toEqual({ providerId: 'a', movedFrom: null })
  })

  it('counts a source measured streaming as green even without a play on record', () => {
    // Played, then a newer test the play has not overruled: the test decides.
    const result = resumeFirst(ordered, 'b', { b: 'worked' }, scanOf({ b: 'stream' }))
    expect(result.resume).toEqual({ providerId: 'b', movedFrom: 1 })
  })

  it('does not resume on a source a newer test found dead', () => {
    const result = resumeFirst(ordered, 'c', { c: 'worked' }, scanOf({ c: 'dead' }))
    expect(ids(result.providers)).toEqual(['a', 'b', 'c', 'd'])
    expect(result.resume).toBeNull()
  })

  it('still resumes on a source that played and then merely timed out in a test', () => {
    // Green by `providerRank`: having played this title beats one test that
    // ran out of time, and the dot the user sees is green too. "Resume while
    // green" means exactly what the dot says.
    expect(resumeFirst(ordered, 'c', { c: 'worked' }, scanOf({ c: 'unsure' })).resume).toEqual({
      providerId: 'c',
      movedFrom: 2,
    })
  })

  it('does nothing for a resume source disabled on this device', () => {
    // A disabled source must never be tried, resumed on or not.
    const result = resumeFirst(ordered, 'gone', { gone: 'worked' }, null)
    expect(ids(result.providers)).toEqual(['a', 'b', 'c', 'd'])
    expect(result.resume).toBeNull()
  })

  it('does nothing for a title never watched', () => {
    expect(resumeFirst(ordered, null, {}, null)).toEqual({ providers: ordered, resume: null })
  })
})

describe('recordCast', () => {
  const now = 1_800_000_000_000

  it('files a cast as a green measured now, with what the TV said', () => {
    const [row] = recordCast([], 'tv:tt1', 'a', { delivery: 'progressive', outcome: 'played' }, now)
    expect(row).toMatchObject({
      verdicts: { a: 'stream' },
      testedAt: { a: now },
      delivery: { a: 'progressive' },
      casts: { a: 'played' },
    })
  })

  it("keeps the source's measured start time and quality, which a cast does not measure", () => {
    const tested: ProviderScan = {
      titleKey: 'tv:tt1',
      at: 1,
      verdicts: { a: 'stream', b: 'dead' },
      timings: { a: 900 },
      qualities: { a: 1080 },
      delivery: { a: 'progressive' },
    }
    const [row] = recordCast([tested], 'tv:tt1', 'a', { delivery: 'segmented', outcome: 'refused' }, now)
    expect(row?.timings).toEqual({ a: 900 })
    expect(row?.qualities).toEqual({ a: 1080 })
    expect(row?.delivery).toEqual({ a: 'segmented' })
    expect(row?.casts).toEqual({ a: 'refused' })
    // The other sources are left as they were.
    expect(row?.verdicts.b).toBe('dead')
  })

  it('records no outcome where the television did not answer clearly', () => {
    const [row] = recordCast([], 'tv:tt1', 'a', { delivery: 'progressive', outcome: null }, now)
    expect(row?.casts ?? {}).toEqual({})
  })
})
