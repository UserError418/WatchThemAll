/**
 * The phone's hand-over to a television: which requests `beam` makes.
 *
 * Against a fake of the native Cast plugin. What is pinned is that a playlist
 * read while identifying the stream is not fetched a second time to build the
 * bundle the proxy serves.
 */

import { beforeEach, expect, it, vi } from 'vitest'

const MASTER = 'https://cdn.example/master.m3u8'
const VARIANT = 'https://cdn.example/720/index.m3u8'

const bodies: Record<string, string> = {
  [MASTER]: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=1280x720\n720/index.m3u8\n',
  [VARIANT]: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg0.ts\n#EXT-X-ENDLIST\n',
}

const fetched: string[] = []
const native = {
  candidates: vi.fn(async () => ({
    // Newest first, as the native side hands them over.
    candidates: [
      { url: VARIANT, headers: {}, atMs: 2 },
      { url: MASTER, headers: {}, atMs: 1 },
    ],
  })),
  fetchText: vi.fn(async ({ url }: { url: string }) => {
    fetched.push(url)
    return { status: 200, contentType: 'application/vnd.apple.mpegurl', body: bodies[url] ?? '' }
  }),
  startProxy: vi.fn(async () => ({ base: 'http://192.168.0.2:8080/' })),
  loadMedia: vi.fn(async () => {}),
}

vi.mock('@capacitor/core', () => ({ registerPlugin: () => native }))

const { createCastBridge } = await import('./cast')

beforeEach(() => {
  fetched.length = 0
})

it('does not fetch again a playlist it read while identifying the stream', async () => {
  const result = await createCastBridge().beam({ title: 'Film', subtitle: '', providerName: 'A', startSeconds: 0 })

  expect(result).toMatchObject({ ok: true, delivery: 'segmented' })
  expect(fetched.filter((url) => url === MASTER)).toHaveLength(1)
  expect(fetched.filter((url) => url === VARIANT)).toHaveLength(1)
  expect(native.loadMedia).toHaveBeenCalledTimes(1)
})
