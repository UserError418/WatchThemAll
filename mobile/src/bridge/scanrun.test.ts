/**
 * One phone test from end to end, against a fake probe session: the page
 * script's engine reading and the playlists it fetched decide what is filed.
 *
 * The session's log, its page script's quality lines and the network are all
 * scripted; what is under test is what the runner makes of them: a clip in
 * the film's place is amber with its reason, and a ladder found after the
 * verdict is filed again under the test's own moment.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Provider } from '@shared/types'
import type { ProviderScan } from '@shared/ipc'
import type { StreamFetch } from '@shared/streamfetch'
import { mediaPlaylist } from '@shared/downloads/downloads.fixture'

const read = vi.fn()
/** What the page script said, as `ProbeSession` hands its lines back. */
let qualityLines: string[] = []

vi.mock('./probeview', () => ({
  openProbe: vi.fn(async () => {
    const openedAtMs = Date.now()
    let polled = 0
    return {
      id: 'probe-1',
      openedAtMs,
      documentStartScript: true,
      audioMuted: true,
      // The master first, then a segment: the segment proves the stream.
      poll: async () => ({
        requests:
          polled++ === 0
            ? [
                { seq: 1, url: 'https://cdn.test/master.m3u8', method: 'GET', headers: {}, mainFrame: false, atMs: openedAtMs + 300 },
                { seq: 2, url: 'https://cdn.test/seg0.ts', method: 'GET', headers: {}, mainFrame: false, atMs: openedAtMs + 600 },
              ]
            : [],
        missed: 0,
        open: true,
        playingAtMs: null,
        quality: qualityLines,
      }),
      tap: async () => {},
      close: async () => {},
    }
  }),
  closeAllProbes: vi.fn(async () => 0),
}))
vi.mock('./cast', () => ({
  capture: { read: (...args: unknown[]) => read(...args), peek: vi.fn(), peekBytes: vi.fn(async () => null) },
  PEEK_LIMIT_BYTES: 16 * 1024,
}))

const { createScanRunner } = await import('./scan')

const provider = { id: 'vidrock', name: 'VidRock', rootUrl: 'https://vidrock.test/', movie: { urlTemplate: '{rootUrl}{imdb}' } } as unknown as Provider
const fightClub = { imdbId: 'tt0137523', tmdbId: 550, type: 'movie' as const, season: null, episode: null, runtimeMinutes: 139 }

const master = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="en",NAME="English",URI="en.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x800,AUDIO="a"',
  '1080.m3u8',
].join('\n')

/** The page script's line for one frame whose video runs `duration` seconds. */
const line = (duration: number): string => JSON.stringify({ frame: 'f1', videos: [{ duration, width: 1280, height: 536, levels: [], streams: false, audio: [] }] })

function runner(fetch: StreamFetch = { fetchText: async () => null }) {
  return createScanRunner({
    providers: () => [provider],
    suspendPlayback: () => {},
    resumePlayback: () => {},
    onProgress: () => {},
    fetch,
  })
}

beforeEach(() => {
  read.mockReset()
  qualityLines = []
  // The runner polls every half second and waits up to four for a quality.
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** A run, with the runner's clock moved on until it is over. */
async function finished<T>(run: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(10_000)
  return run
}

it("files a clip in the film's place as amber, with the reason in words", async () => {
  // Measured 2026-10-04: VidRock's 167 s clip for the 139-minute Fight Club.
  qualityLines = [line(167)]
  read.mockResolvedValue({ status: 403, contentType: '', body: '' })
  const scan = await finished(runner().run('movie:tt0137523', fightClub))
  expect(scan.verdicts).toEqual({ vidrock: 'unsure' })
  expect(scan.reasons).toEqual({ vidrock: { kind: 'wrong-video', seconds: 167, expectedMinutes: 139, title: 'film' } })
  expect(scan.qualities).toEqual({})
})

it('leaves a source green when no length is known', async () => {
  read.mockResolvedValue({ status: 403, contentType: '', body: '' })
  const scan = await finished(runner().run('movie:tt0137523', fightClub))
  expect(scan.verdicts).toEqual({ vidrock: 'stream' })
})

it("files the source's ladder again under the test's moment once it is found after the run", async () => {
  // Its playlists answer the test's own read with a refusal; asked again
  // after the verdict, its master answers.
  qualityLines = [line(8_340)]
  read.mockResolvedValue({ status: 403, contentType: '', body: '' })
  let open: () => void = () => {}
  const gate = new Promise<void>((resolve) => (open = resolve))
  const fetch: StreamFetch = {
    async fetchText(url) {
      await gate
      if (url === 'https://cdn.test/master.m3u8') return { status: 200, body: master }
      if (url === 'https://cdn.test/1080.m3u8') return { status: 200, body: mediaPlaylist('https://cdn.test/s', 834, 10) }
      return null
    },
  }
  const refiled: ProviderScan[] = []
  const scan = await finished(runner(fetch).run('movie:tt0137523', fightClub, { refile: (row) => refiled.push(row) }))
  expect(scan.verdicts).toEqual({ vidrock: 'stream' })
  expect(scan.qualities).toEqual({})

  open()
  await vi.waitFor(() => expect(refiled).toHaveLength(1))
  expect(refiled[0]).toMatchObject({
    at: scan.testedAt?.vidrock,
    verdicts: { vidrock: 'stream' },
    qualities: { vidrock: 1080 },
    qualityKinds: { vidrock: 'offered' },
    audio: { vidrock: ['en'] },
  })
})
