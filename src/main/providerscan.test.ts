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
  RESULT_TTL_MS,
  RETEST_AFTER_MS,
  castResult,
  isRetestDue,
  kindTested,
  ownRows,
  providerRank,
  resumeFirst,
  scanAwareOrder,
  scanEpisode,
  scanProgress,
  titleResults,
  type ResultSources,
} from './providerscan'
import type { SourceResult } from '@shared/sourceresults'

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

describe('titleResults', () => {
  const now = 1_800_000_000_000
  const day = 24 * 60 * 60 * 1000
  const here = { deviceId: 'pc-1', deviceKind: 'desktop' as const }

  const tested = (providerId: string, verdict: SourceResult['verdict'], at: number, episode = 1): SourceResult => ({
    titleKey: 'tv:tt1',
    season: 1,
    episode,
    providerId,
    at,
    ...here,
    origin: 'test',
    verdict,
  })

  const sources = (parts: Partial<ResultSources['doc']> & { history?: SourceResult[] }): ResultSources => ({
    history: parts.history ?? [],
    doc: {
      deviceId: here.deviceId,
      providerScans: parts.providerScans ?? [],
      sharedScans: parts.sharedScans ?? [],
      streamOutcomes: parts.streamOutcomes ?? [],
    },
  })

  /** For `autotest.ts`: a scan cancelled part-way is not a finished one, and the other kind's tests are not this one's. */
  it('calls a title tested by this kind only once every source has a test from it', () => {
    const partial = [tested('a', 'stream', now - day)]
    expect(kindTested(sources({ history: partial }), 'desktop', 'tv:tt1', ['a', 'b'])).toBe(false)
    const whole = [...partial, tested('b', 'dead', now - day, 3)]
    expect(kindTested(sources({ history: whole }), 'desktop', 'tv:tt1', ['a', 'b'])).toBe(true)
    expect(kindTested(sources({ history: whole }), 'phone', 'tv:tt1', ['a', 'b'])).toBe(false)
    const played = [{ ...tested('a', 'stream', now - day), origin: 'play' as const }]
    expect(kindTested(sources({ history: played }), 'desktop', 'tv:tt1', ['a'])).toBe(false)
  })

  it('reads the history for the episode asked about', () => {
    const history = [tested('a', 'stream', now - day, 1), tested('a', 'dead', now - day, 2)]
    expect(titleResults(sources({ history }), 'tv:tt1', { season: 1, episode: 1 }, 'desktop', now).scan?.verdicts).toEqual({ a: 'stream' })
    expect(titleResults(sources({ history }), 'tv:tt1', { season: 1, episode: 2 }, 'desktop', now).scan?.verdicts).toEqual({ a: 'dead' })
  })

  it('still reads the rows stored before the history, as results of the whole title', () => {
    const own: ProviderScan = { titleKey: 'tv:tt1', at: now - 2 * day, verdicts: { a: 'dead', b: 'stream' } }
    const phone = { titleKey: 'tv:tt1', at: now - day, verdicts: { c: 'stream' as const }, deviceId: 'phone-1', deviceKind: 'phone' as const }
    // The episode's own result decides for a; b and c have only the old rows.
    const read = titleResults(
      sources({ providerScans: [own], sharedScans: [phone], history: [tested('a', 'stream', now - day)] }),
      'tv:tt1',
      { season: 1, episode: 1 },
      'desktop',
      now,
    )
    expect(read.scan?.verdicts).toEqual({ a: 'stream', b: 'stream', c: 'unsure' })
    expect(read.sharedFrom).toEqual({ c: 'phone' })
  })

  it('lets a play in the play log overtake an older failure, as it did', () => {
    const history = [tested('a', 'dead', now - 2 * day)]
    const streamOutcomes = [
      { mediaKey: 'tv:tt1:1:1', providerId: 'a', outcome: 'stream' as const, at: now - day, updatedAt: now - day, deletedAt: null },
    ]
    const read = titleResults(sources({ history, streamOutcomes }), 'tv:tt1', { season: 1, episode: 1 }, 'desktop', now)
    expect(read.scan).toBeNull()
  })
})

describe('ownRows', () => {
  it("is this device's own results only, one title-wide row per title", () => {
    const now = 1_800_000_000_000
    const mine: SourceResult = {
      titleKey: 'tv:tt1',
      season: 1,
      episode: 3,
      providerId: 'a',
      at: now - 1_000,
      deviceId: 'pc-1',
      deviceKind: 'desktop',
      origin: 'test',
      verdict: 'stream',
    }
    const theirs: SourceResult = { ...mine, providerId: 'b', deviceId: 'pc-2' }
    const rows = ownRows(
      { history: [mine, theirs], doc: { deviceId: 'pc-1', providerScans: [], sharedScans: [], streamOutcomes: [] } },
      'desktop',
      now,
    )
    expect(rows.map((row) => [row.titleKey, row.verdicts])).toEqual([['tv:tt1', { a: 'stream' }]])
  })
})

describe('castResult', () => {
  const now = 1_800_000_000_000
  const where = { device: { deviceId: 'pc-1', deviceKind: 'desktop' as const }, titleKey: 'tv:tt1', episode: { season: 2, episode: 5 }, providerId: 'a' }

  it('files a cast as a success seen while playing, with how the video came and what the TV said', () => {
    expect(castResult(where, { delivery: 'progressive', outcome: 'played' }, now)).toEqual({
      titleKey: 'tv:tt1',
      season: 2,
      episode: 5,
      providerId: 'a',
      deviceId: 'pc-1',
      deviceKind: 'desktop',
      at: now,
      origin: 'play',
      verdict: 'stream',
      delivery: 'progressive',
      cast: 'played',
    })
  })

  it('records no answer where the television did not give a clear one', () => {
    expect(castResult(where, { delivery: 'segmented', outcome: null }, now)).not.toHaveProperty('cast')
  })
})
