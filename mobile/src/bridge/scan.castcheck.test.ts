/**
 * The cast check in the phone's test (`castcheck.ts`, run by `scan.ts`):
 * after a source's verdict, on what its session captured, filed with the run.
 *
 * The probe session is a fake that reports its film playing at once, with
 * one master playlist captured; the check is the caller's, as in the app.
 */

import { expect, it, vi } from 'vitest'
import type { Provider } from '@shared/types'
import type { ProviderScanProgress } from '@shared/ipc'

const MASTER = 'https://cdn.example/master.m3u8'
const ENGINE_LINE = JSON.stringify({
  frame: 'f1',
  videos: [{ duration: 8_340, width: 1920, height: 1080, levels: [{ width: 1920, height: 1080 }], streams: false, audio: [] }],
})

vi.mock('./probeview', () => ({
  openProbe: vi.fn(async () => {
    // A session's log hands each request over once.
    let first = true
    return {
      openedAtMs: 0,
      poll: async () => {
        const requests = first
          ? [
              {
                url: MASTER,
                method: 'GET',
                mainFrame: false,
                headers: { Referer: 'https://a.example/' },
                atMs: 50,
              },
            ]
          : []
        first = false
        // The page script's reading of the source's engine: the film's length
        // and its one level. Without it the quality read waits its few seconds
        // for one (`readQuality`), longer than this test does.
        return { requests, open: true, playingAtMs: 100, quality: [ENGINE_LINE] }
      },
      tap: async () => {},
      close: async () => {},
    }
  }),
  closeAllProbes: vi.fn(async () => 0),
}))
vi.mock('./cast', () => ({
  PEEK_LIMIT_BYTES: 16 * 1024,
  capture: {
    read: async () => ({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080\nv.m3u8\n',
    }),
    peek: async () => ({ status: 200, contentType: '', body: '' }),
  },
}))

const { createScanRunner } = await import('./scan')

const provider = {
  id: 'a',
  name: 'A',
  rootUrl: 'https://a.example/',
  movie: { urlTemplate: '{rootUrl}{imdb}' },
} as unknown as Provider
const film = { imdbId: 'tt1', tmdbId: 1, type: 'movie' as const, season: null, episode: null }

it('checks a source that streamed, after its verdict is out, and files the check with the run', async () => {
  const progress: ProviderScanProgress[] = []
  let release: () => void = () => {}
  const asked: Array<{ urls: string[]; runtime: number | null }> = []
  const scans = createScanRunner({
    providers: () => [provider],
    suspendPlayback: () => {},
    resumePlayback: () => {},
    onProgress: (p) => progress.push(p),
    castCheck: async (requests, runtime) => {
      asked.push({ urls: requests.map((r) => r.url), runtime })
      await new Promise<void>((resolve) => (release = resolve))
      return { reach: 'ok', identity: 'film' }
    },
  })

  const running = scans.run('movie:tt1', { ...film, runtimeMinutes: 139 })
  await vi.waitFor(() => expect(asked).toHaveLength(1))
  expect(progress.some((p) => p.verdicts.a === 'stream' && !p.finished)).toBe(true)
  expect(progress.some((p) => p.finished)).toBe(false)
  release()
  const result = await running

  expect(asked).toEqual([{ urls: [MASTER], runtime: 139 }])
  expect(result.castChecks).toEqual({ a: { reach: 'ok', identity: 'film' } })
  expect(result.verdicts).toEqual({ a: 'stream' })
})
