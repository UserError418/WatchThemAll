/**
 * The pool of three across runs.
 *
 * A test cannot be interrupted, so a scan that is cancelled, or superseded by
 * another, leaves its tests loading. These pin that they still count: against
 * the pool a new scan fills, and in `busy()`, which the automatic tester and
 * the watchlist tester read before starting anything of their own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Provider } from '@shared/types'
import type { QualityProbeResult } from './qualityprobe'

/** Tests loading now, the most seen at once, and how to let the oldest finish. */
let loading = 0
let peak = 0
const waiting: Array<() => void> = []

vi.mock('./qualityprobe', () => ({
  probeQuality: async (provider: Provider): Promise<QualityProbeResult> => {
    loading += 1
    peak = Math.max(peak, loading)
    await new Promise<void>((resolve) => waiting.push(resolve))
    loading -= 1
    return {
      providerId: provider.id,
      providerName: provider.name,
      subject: 'Test',
      verdict: 'stream',
      reason: null,
      timeToMediaMs: 1_000,
      delivery: null,
      mediaSamples: [],
      playlists: [],
      requests: [],
      castCandidates: [],
      wholeFiles: [],
      video: null,
      sniffed: [],
      engines: [],
      film: { kind: 'unknown' },
      audio: [],
      judgement: { outcome: 'unreadable', best: null, kind: null, playing: null, contradiction: false, decoy: false },
    }
  },
}))

const { createScanService } = await import('./scanservice')

const provider = (id: string): Provider =>
  ({ id, name: id, rootUrl: 'https://example.com/', movie: { urlTemplate: '{rootUrl}movie/{imdb}' }, tv: null }) as unknown as Provider
const subject = { imdbId: 'tt1', tmdbId: 1, type: 'movie' as const, label: 'movie:tt1', runtimeMinutes: null }
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Every service a test made, so none of its runs outlives the test. */
const services: Array<ReturnType<typeof createScanService>> = []

function serviceOf(ids: string[]) {
  const service = createScanService({ providers: () => ids.map(provider), frameUrl: (url) => url, onProgress: () => {} })
  services.push(service)
  return service
}

afterEach(async () => {
  // Cancelled first, so a run waiting for the pool starts nothing new while
  // the tests still loading are let finish.
  for (const service of services.splice(0)) service.cancel()
  while (waiting.length > 0) {
    waiting.shift()!()
    await settle()
  }
  loading = 0
  peak = 0
})

describe('the pool of three across runs', () => {
  /** The bug: a second scan started three more beside the first one's three. */
  it('never has more than three tests loading when a second scan supersedes the first', async () => {
    const service = serviceOf(['a', 'b', 'c', 'd', 'e', 'f'])
    void service.run('movie:tt1', subject)
    await settle()
    void service.run('movie:tt2', subject)
    await settle()

    expect(peak).toBe(3)
  })

  it('fills the pool for the new scan as the old one\'s tests end', async () => {
    const service = serviceOf(['a', 'b', 'c'])
    void service.run('movie:tt1', subject)
    await settle()
    void service.run('movie:tt2', subject)
    await settle()

    waiting.shift()!()
    // The new scan looks again at its one-second poll.
    await new Promise((resolve) => setTimeout(resolve, 1_100))

    expect(loading).toBe(3)
    expect(peak).toBe(3)
  })

  /** The bug: cancelling said idle at once, and the automatic tester started three more. */
  it('stays busy while a cancelled scan still has tests loading', async () => {
    const service = serviceOf(['a', 'b', 'c'])
    void service.run('movie:tt1', subject)
    await settle()

    service.cancel()

    expect({ busy: service.busy(), loading }).toEqual({ busy: true, loading: 3 })
  })
})
