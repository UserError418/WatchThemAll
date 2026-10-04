/**
 * The app window's live test run belongs to the title it measures, whoever
 * started it: an automatic test of another title must not show as this one's.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderScanProgress, TitleRef } from '@shared/ipc'

const A: TitleRef = { type: 'tv', imdbId: 'tt0000001', tmdbId: 1 }
const B: TitleRef = { type: 'movie', imdbId: 'tt0000002', tmdbId: 2 }

function progress(title: TitleRef, verdict: 'stream' | 'dead'): ProviderScanProgress {
  return {
    titleKey: `${title.type}:${title.imdbId}`,
    title,
    episode: null,
    testing: [],
    done: 1,
    total: 1,
    verdicts: { vidsrc: verdict },
    timings: {},
    qualities: {},
    reasons: {},
    delivery: {},
    finished: false,
    cancelled: false,
  } as ProviderScanProgress
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('the live test run', () => {
  it("is not shown on a title's list when it measures another title", async () => {
    let speak: (p: ProviderScanProgress) => void = () => {}
    vi.stubGlobal('window', {
      wta: {
        on: { providerScan: (cb: (p: ProviderScanProgress) => void) => (speak = cb) },
        providers: { scan: () => new Promise(() => {}), cancelScan: async () => {} },
      },
    })
    const { scan } = await import('./scan.svelte')
    scan.listen()

    // The viewer tests A; its run speaks.
    void scan.start(A, null)
    speak(progress(A, 'stream'))
    expect(scan.matches(A)).toBe(true)

    // An automatic test of B starts: A's list must fall back to what is stored.
    speak(progress(B, 'dead'))
    expect(scan.matches(A)).toBe(false)
    expect(scan.matches(B)).toBe(true)
  })
})
