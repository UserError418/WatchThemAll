/**
 * The app window's live test run belongs to the title and episode it
 * measures, whoever started it: an automatic test of another title, or of
 * another episode, must not show as this one's. And once a run is over, the
 * stored results decide as soon as a list has read them again (`liverun.ts`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderScanProgress, TitleRef } from '@shared/ipc'

const A: TitleRef = { type: 'tv', imdbId: 'tt0000001', tmdbId: 1 }
const B: TitleRef = { type: 'movie', imdbId: 'tt0000002', tmdbId: 2 }
const S1E1 = { season: 1, episode: 1 }
const S1E2 = { season: 1, episode: 2 }

function progress(
  title: TitleRef,
  verdict: 'stream' | 'dead',
  episode: { season: number; episode: number } | null = null,
  finished = false,
): ProviderScanProgress {
  return {
    titleKey: `${title.type}:${title.imdbId}`,
    title,
    episode,
    testing: [],
    done: 1,
    total: 1,
    verdicts: { vidsrc: verdict },
    timings: {},
    qualities: {},
    qualityKinds: {},
    audio: {},
    reasons: {},
    delivery: {},
    finished,
    cancelled: false,
  } as ProviderScanProgress
}

/** The scan state, listening to a run that speaks when the test says. */
async function listening(): Promise<{
  scan: (typeof import('./scan.svelte'))['scan']
  speak: (p: ProviderScanProgress) => void
}> {
  let speak: (p: ProviderScanProgress) => void = () => {}
  vi.stubGlobal('window', {
    wta: {
      on: {
        providerScan: (cb: (p: ProviderScanProgress) => void) => {
          speak = cb
        },
      },
      providers: { scan: () => new Promise(() => {}), cancelScan: async () => {} },
    },
  })
  const { scan } = await import('./scan.svelte')
  scan.listen()
  return { scan, speak: (p) => speak(p) }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('the live test run', () => {
  it("is not shown on a title's list when it measures another title", async () => {
    const { scan, speak } = await listening()

    // The viewer tests A; its run speaks.
    void scan.start(A, S1E1)
    speak(progress(A, 'stream', S1E1))
    expect(scan.isAbout(A, S1E1)).toBe(true)

    // An automatic test of B starts: A's list must fall back to what is stored.
    speak(progress(B, 'dead'))
    expect(scan.isAbout(A, S1E1)).toBe(false)
    expect(scan.isAbout(B, null)).toBe(true)
  })

  it('is not shown for another episode of the same title', async () => {
    const { scan, speak } = await listening()

    // A first watch's test of S1E2, while the detail view offers S1E1.
    speak(progress(A, 'dead', S1E2))
    expect(scan.isAbout(A, S1E2)).toBe(true)
    expect(scan.isAbout(A, S1E1)).toBe(false)
    expect(scan.overrides(A, S1E1, 0)).toBe(false)
  })

  it('is about the episode asked for from the moment it starts', async () => {
    const { scan } = await listening()

    void scan.start(A, S1E2)
    expect(scan.running).toBe(true)
    expect(scan.isAbout(A, S1E2)).toBe(true)
    expect(scan.overrides(A, S1E2, scan.finished)).toBe(true)
  })

  it('gives way to the stored results once a list has read them after the run', async () => {
    const { scan, speak } = await listening()

    const before = scan.finished
    speak(progress(A, 'dead', S1E2))
    // The list's stored results were read before the run: the run is drawn.
    expect(scan.overrides(A, S1E2, before)).toBe(true)

    speak(progress(A, 'dead', S1E2, true))
    expect(scan.running).toBe(false)
    // Over, but the list has not read since: still the run, not the old state.
    expect(scan.overrides(A, S1E2, before)).toBe(true)
    // Read after it ended: the stored decision, which orders Automatic, colours the dots.
    expect(scan.overrides(A, S1E2, scan.finished)).toBe(false)
  })

  it('counts a run stopped here once, when its last report follows the stop', async () => {
    const { scan, speak } = await listening()

    void scan.start(A, S1E2)
    speak(progress(A, 'stream', S1E2))
    await scan.cancel()
    expect(scan.running).toBe(false)
    const readAfterStop = scan.finished
    expect(scan.overrides(A, S1E2, readAfterStop)).toBe(false)

    // Main's own last report of the cancelled run arrives after the list
    // read afresh: the run must not come back up over that read.
    speak(progress(A, 'stream', S1E2, true))
    expect(scan.finished).toBe(readAfterStop)
    expect(scan.overrides(A, S1E2, readAfterStop)).toBe(false)
  })
})
