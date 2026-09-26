/**
 * What a desktop scan records about each provider: the verdict, and for the
 * ones that streamed, how long the stream took to start.
 *
 * `probeQuality` is replaced by a script, because the real one opens a hidden
 * window against a live provider. What is under test is the bookkeeping around
 * it — which is where a time could end up beside the wrong verdict, or survive
 * a re-check that replaced the measurement it came from.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Provider, ScanReason, StreamDelivery } from '@shared/types'
import type { ProviderScan, ProviderScanProgress } from '@shared/ipc'
import type { ProbeSubject, StreamVerdict } from './streamprobe'
import type { QualityProbeResult } from './qualityprobe'

/** Each provider's answers, in the order its probes will be asked for them. */
const script = new Map<
  string,
  Array<{
    verdict: StreamVerdict
    ms: number | null
    quality?: number
    reason?: ScanReason
    delivery?: StreamDelivery | null
    hold?: Promise<void>
  }>
>()
/** The budget each probe was given, in call order, per provider. */
const budgets = new Map<string, number[]>()

/** What `streamReason` would say for a verdict, where a test does not care which. */
const DEFAULT_REASON: Record<StreamVerdict, ScanReason | null> = {
  stream: null,
  refused: { kind: 'refused', status: 403 },
  timeout: { kind: 'timeout', seconds: 20 },
  'no-media': { kind: 'no-stream' },
  empty: { kind: 'no-stream' },
  'api-error': { kind: 'error', status: 500 },
  blocked: { kind: 'blocked' },
  unreachable: { kind: 'unreachable' },
  'no-template': { kind: 'unsupported' },
}

vi.mock('./qualityprobe', () => ({
  probeQuality: async (provider: Provider, _subject: unknown, options: { timeoutMs: number }): Promise<QualityProbeResult> => {
    budgets.set(provider.id, [...(budgets.get(provider.id) ?? []), options.timeoutMs])
    const answer = script.get(provider.id)?.shift()
    if (!answer) throw new Error(`no scripted answer left for ${provider.id}`)
    // Lets a test keep this probe in flight while something else happens.
    await answer.hold
    const best = answer.quality ?? null
    return {
      providerId: provider.id,
      providerName: provider.name,
      subject: 'Test',
      verdict: answer.verdict,
      reason: answer.reason ?? DEFAULT_REASON[answer.verdict],
      timeToMediaMs: answer.ms,
      delivery: answer.delivery ?? null,
      mediaSamples: [],
      playlists: [],
      wholeFiles: [],
      video: null,
      sniffed: [],
      judgement: {
        outcome: best === null ? 'unreadable' : 'ladder',
        best,
        playing: null,
        contradiction: false,
        decoy: false,
      },
    }
  },
}))

const { createScanService } = await import('./scanservice')

const provider = (id: string): Provider => ({
  id,
  name: id,
  rootUrl: `https://${id}.test/`,
  tv: { urlTemplate: '{rootUrl}tv/{imdb}/{season}/{episode}' },
  movie: { urlTemplate: '{rootUrl}movie/{imdb}' },
})

const subject: ProbeSubject = { imdbId: 'tt1', tmdbId: 1, type: 'movie', label: 'Test' }

/** A scan service over `providers`, and every progress update it sends. */
function scanOf(providers: Provider[]): {
  run: () => Promise<ProviderScan>
  probeOne: (provider: Provider) => Promise<ProviderScan | null>
  progress: ProviderScanProgress[]
} {
  const progress: ProviderScanProgress[] = []
  const service = createScanService({
    providers: () => providers,
    frameUrl: (url) => url,
    onProgress: (update) => progress.push(update),
  })
  return {
    run: () => service.run('movie:tt1', subject),
    probeOne: (one) => service.probeOne('movie:tt1', subject, one),
    progress,
  }
}

describe('scan timings and qualities', () => {
  beforeEach(() => {
    script.clear()
    budgets.clear()
  })

  it('records the time to stream for providers that streamed, and nothing for the rest', async () => {
    script.set('fast', [{ verdict: 'stream', ms: 2_300 }])
    script.set('blocked', [{ verdict: 'blocked', ms: null }])
    // A provider can fetch media and still be judged something else — a probe
    // that saw a request but blamed a bot check. Its time is not a stream time.
    script.set('odd', [{ verdict: 'blocked', ms: 4_000 }])

    const { run } = scanOf([provider('fast'), provider('blocked'), provider('odd')])
    const scan = await run()

    expect(scan.verdicts).toEqual({ fast: 'stream', blocked: 'unsure', odd: 'unsure' })
    expect(scan.timings).toEqual({ fast: 2_300 })
  })

  it('takes the time from the re-check when the re-check is what streamed', async () => {
    // Dead in the crowd, streaming alone: the time that stands is the one
    // measured alongside the verdict that stands.
    script.set('starved', [
      { verdict: 'no-media', ms: null },
      { verdict: 'stream', ms: 9_100 },
    ])
    const { run } = scanOf([provider('starved')])
    const scan = await run()

    expect(scan.verdicts).toEqual({ starved: 'stream' })
    expect(scan.timings).toEqual({ starved: 9_100 })
  })

  it('records the best quality where the stream said, and only for streams', async () => {
    script.set('ladder', [{ verdict: 'stream', ms: 2_000, quality: 1080 }])
    script.set('silent', [{ verdict: 'stream', ms: 3_000 }])
    // A quality read off a page that then failed the verdict is not a quality.
    script.set('blocked', [{ verdict: 'blocked', ms: null, quality: 720 }])

    const { run } = scanOf([provider('ladder'), provider('silent'), provider('blocked')])
    const scan = await run()

    expect(scan.qualities).toEqual({ ladder: 1080 })
  })

  it('publishes the times as they settle, so the pickers can show them live', async () => {
    script.set('a', [{ verdict: 'stream', ms: 3_800 }])
    const { run, progress } = scanOf([provider('a')])
    await run()

    const last = progress.at(-1)
    expect(last?.finished).toBe(true)
    expect(last?.timings).toEqual({ a: 3_800 })
    // Published as copies: a later settle must not rewrite an update already sent.
    expect(progress[0]?.timings).toEqual({})
  })
})

describe('why a source failed', () => {
  beforeEach(() => {
    script.clear()
    budgets.clear()
  })

  it('paints a backend 500 red and says so', async () => {
    script.set('vidfast', [
      { verdict: 'api-error', ms: null, reason: { kind: 'error', status: 500 } },
      { verdict: 'api-error', ms: null, reason: { kind: 'error', status: 500 } },
    ])
    const scan = await scanOf([provider('vidfast')]).run()
    expect(scan.verdicts).toEqual({ vidfast: 'dead' })
    expect(scan.reasons).toEqual({ vidfast: { kind: 'error', status: 500 } })
  })

  it('keeps a bot check amber: the player carries cookies the test does not', async () => {
    script.set('guarded', [{ verdict: 'blocked', ms: null }])
    const scan = await scanOf([provider('guarded')]).run()
    expect(scan.verdicts).toEqual({ guarded: 'unsure' })
    expect(scan.reasons).toEqual({ guarded: { kind: 'blocked' } })
  })

  it('tests every red a second time with the longer budget, and the second reason stands', async () => {
    script.set('slow', [
      { verdict: 'api-error', ms: null, reason: { kind: 'error', status: 500 } },
      { verdict: 'timeout', ms: null, reason: { kind: 'timeout', seconds: 25 } },
    ])
    const scan = await scanOf([provider('slow')]).run()
    expect(budgets.get('slow')).toEqual([20_000, 25_000])
    expect(scan.reasons).toEqual({ slow: { kind: 'timeout', seconds: 25 } })
  })

  it('does not test a source twice when it cannot express the title', async () => {
    script.set('movies-only', [{ verdict: 'no-template', ms: null }])
    const scan = await scanOf([provider('movies-only')]).run()
    expect(budgets.get('movies-only')).toEqual([20_000])
    expect(scan.reasons).toEqual({ 'movies-only': { kind: 'unsupported' } })
  })

  it('drops the reason when the re-check streamed', async () => {
    script.set('starved', [
      { verdict: 'timeout', ms: null },
      { verdict: 'stream', ms: 19_200 },
    ])
    const scan = await scanOf([provider('starved')]).run()
    expect(scan.verdicts).toEqual({ starved: 'stream' })
    expect(scan.reasons).toEqual({})
  })

  it('records when each provider was tested', async () => {
    script.set('a', [{ verdict: 'stream', ms: 1_000 }])
    const before = Date.now()
    const scan = await scanOf([provider('a')]).run()
    expect(scan.testedAt?.a).toBeGreaterThanOrEqual(before)
  })
})

describe('how the video arrived', () => {
  beforeEach(() => {
    script.clear()
    budgets.clear()
  })

  it('records it for sources that streamed, and nothing for the rest', async () => {
    script.set('a', [{ verdict: 'stream', ms: 900, delivery: 'progressive' }])
    script.set('b', [{ verdict: 'stream', ms: 1_200, delivery: 'segmented' }])
    script.set('c', [{ verdict: 'no-media', ms: null }, { verdict: 'no-media', ms: null }])
    const scan = await scanOf([provider('a'), provider('b'), provider('c')]).run()
    expect(scan.delivery).toEqual({ a: 'progressive', b: 'segmented' })
  })

  it('records a stream whose traffic showed nothing as unknown, which is an answer', async () => {
    // Absent would read as "tested before deliveries existed" and be due again forever.
    script.set('a', [{ verdict: 'stream', ms: 900, delivery: null }])
    const result = await scanOf([provider('a')]).probeOne(provider('a'))
    expect(result?.delivery).toEqual({ a: 'unknown' })
  })
})

describe('testing one provider for the background tester', () => {
  beforeEach(() => {
    script.clear()
    budgets.clear()
  })

  it('probes alone with the longer budget and returns a one-provider result', async () => {
    script.set('a', [{ verdict: 'timeout', ms: null, reason: { kind: 'timeout', seconds: 25 } }])
    const result = await scanOf([provider('a')]).probeOne(provider('a'))
    expect(budgets.get('a')).toEqual([25_000])
    expect(result?.verdicts).toEqual({ a: 'dead' })
    expect(result?.reasons).toEqual({ a: { kind: 'timeout', seconds: 25 } })
    expect(result?.testedAt?.a).toBe(result?.at)
  })

  it('throws its result away when a scan by hand started meanwhile', async () => {
    // A result taken while competing with a full scan is the starved kind the
    // re-check exists to discard; the scan by hand measures it properly anyway.
    let release: () => void = () => {}
    const hold = new Promise<void>((resolve) => (release = resolve))
    // The background probe is held open; the scan by hand runs to completion
    // meanwhile; only then does the background probe finish.
    script.set('a', [
      { verdict: 'stream', ms: 1_000, hold },
      { verdict: 'stream', ms: 1_000 },
    ])
    const { run, probeOne } = scanOf([provider('a')])
    const pending = probeOne(provider('a'))
    await run()
    release()
    expect(await pending).toBeNull()
  })
})

describe('three sources under test at every moment', () => {
  beforeEach(() => {
    script.clear()
    budgets.clear()
  })

  /** A probe answer that waits until the test releases it. */
  function held(verdict: StreamVerdict): { answer: { verdict: StreamVerdict; ms: number | null; hold: Promise<void> }; release: () => void } {
    let release: () => void = () => {}
    const hold = new Promise<void>((resolve) => (release = resolve))
    return { answer: { verdict, ms: verdict === 'stream' ? 1_000 : null, hold }, release }
  }

  /** Let the scan's loop run until it waits on a probe again. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  /** Which providers have had a probe started, and how many each. */
  const started = (): Record<string, number> =>
    Object.fromEntries([...budgets.entries()].map(([id, list]) => [id, list.length]))

  it('never runs more than three, and starts the next the moment one ends', async () => {
    const probes = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((id) => [id, held('stream')]))
    for (const [id, probe] of Object.entries(probes)) script.set(id, [probe.answer])

    const { run } = scanOf(['a', 'b', 'c', 'd', 'e'].map(provider))
    const done = run()
    await settle()
    expect(started()).toEqual({ a: 1, b: 1, c: 1 })

    probes.b?.release()
    await settle()
    expect(started()).toEqual({ a: 1, b: 1, c: 1, d: 1 })

    for (const probe of Object.values(probes)) probe.release()
    const scan = await done
    expect(Object.keys(scan.verdicts)).toHaveLength(5)
  })

  it("runs a red's second test alongside the first tests still going, not after them", async () => {
    const a = held('no-media')
    const aAgain = held('stream')
    const b = held('stream')
    const c = held('stream')
    const d = held('stream')
    script.set('a', [a.answer, aAgain.answer])
    script.set('b', [b.answer])
    script.set('c', [c.answer])
    script.set('d', [d.answer])

    const { run, progress } = scanOf(['a', 'b', 'c', 'd'].map(provider))
    const done = run()
    await settle()

    a.release() // red: its second test joins the queue behind d
    await settle()
    expect(started()).toEqual({ a: 1, b: 1, c: 1, d: 1 })

    b.release() // a slot frees while c and d are still on their first test
    await settle()
    expect(started()).toEqual({ a: 2, b: 1, c: 1, d: 1 })
    expect(budgets.get('a')).toEqual([20_000, 25_000])

    const during = progress.at(-1)
    expect(during?.testing).toEqual([
      { providerId: 'c', providerName: 'c', recheck: false },
      { providerId: 'd', providerName: 'd', recheck: false },
      { providerId: 'a', providerName: 'a', recheck: true },
    ])

    for (const probe of [aAgain, c, d]) probe.release()
    const scan = await done
    expect(scan.verdicts).toEqual({ a: 'stream', b: 'stream', c: 'stream', d: 'stream' })
    expect(progress.at(-1)?.testing).toEqual([])
  })

  it('lists every source under test, not only the latest to start', async () => {
    const probes = ['a', 'b', 'c'].map(() => held('stream'))
    ;['a', 'b', 'c'].forEach((id, i) => script.set(id, [probes[i]!.answer]))

    const { run, progress } = scanOf(['a', 'b', 'c'].map(provider))
    const done = run()
    await settle()
    expect(progress.at(-1)?.testing.map((t) => t.providerId)).toEqual(['a', 'b', 'c'])

    for (const probe of probes) probe.release()
    await done
  })
})
