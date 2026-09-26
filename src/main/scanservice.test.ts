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
import type { Provider } from '@shared/types'
import type { ProviderScan, ProviderScanProgress } from '@shared/ipc'
import type { ProbeSubject, StreamVerdict } from './streamprobe'
import type { QualityProbeResult } from './qualityprobe'

/** Each provider's answers, in the order its probes will be asked for them. */
const script = new Map<string, Array<{ verdict: StreamVerdict; ms: number | null; quality?: number }>>()

vi.mock('./qualityprobe', () => ({
  probeQuality: async (provider: Provider): Promise<QualityProbeResult> => {
    const answer = script.get(provider.id)?.shift()
    if (!answer) throw new Error(`no scripted answer left for ${provider.id}`)
    const best = answer.quality ?? null
    return {
      providerId: provider.id,
      providerName: provider.name,
      subject: 'Test',
      verdict: answer.verdict,
      timeToMediaMs: answer.ms,
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
  progress: ProviderScanProgress[]
} {
  const progress: ProviderScanProgress[] = []
  const service = createScanService({
    providers: () => providers,
    frameUrl: (url) => url,
    onProgress: (update) => progress.push(update),
  })
  return { run: () => service.run('movie:tt1', subject), progress }
}

describe('scan timings and qualities', () => {
  beforeEach(() => script.clear())

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
