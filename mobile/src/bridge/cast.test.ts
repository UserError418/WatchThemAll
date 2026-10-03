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
/** Set to make the source refuse its variant playlist, as some answer a second request. */
let refuseVariant = false
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
    if (refuseVariant && url === VARIANT) return { status: 403, contentType: 'text/plain', body: '' }
    return { status: 200, contentType: 'application/vnd.apple.mpegurl', body: bodies[url] ?? '' }
  }),
  startProxy: vi.fn(async () => ({ base: 'http://192.168.0.2:8080/' })),
  loadMedia: vi.fn(async () => {}),
  stopProxy: vi.fn(async () => {}),
}

vi.mock('@capacitor/core', () => ({ registerPlugin: () => native }))

const { createCastBridge } = await import('./cast')

beforeEach(() => {
  fetched.length = 0
  refuseVariant = false
  native.stopProxy.mockClear()
})

it('does not fetch again a playlist it read while identifying the stream', async () => {
  const result = await createCastBridge().beam({ title: 'Film', subtitle: '', providerName: 'A', startSeconds: 0 })

  expect(result).toMatchObject({ ok: true, delivery: 'segmented' })
  expect(fetched.filter((url) => url === MASTER)).toHaveLength(1)
  expect(fetched.filter((url) => url === VARIANT)).toHaveLength(1)
  expect(native.loadMedia).toHaveBeenCalledTimes(1)
})

it('leaves the proxy serving when a new beam fails before it reaches the proxy', async () => {
  // Only the master was captured, and the variant the bundle must read is refused.
  native.candidates.mockResolvedValueOnce({ candidates: [{ url: MASTER, headers: {}, atMs: 1 }] })
  refuseVariant = true

  const result = await createCastBridge().beam({ title: 'Film', subtitle: '', providerName: 'B', startSeconds: 0 })

  expect(result.ok).toBe(false)
  expect(native.stopProxy).not.toHaveBeenCalled()
})

it('takes the proxy down when the attempt that loaded it fails', async () => {
  native.loadMedia.mockRejectedValueOnce(new Error('not connected to a Chromecast'))

  const result = await createCastBridge().beam({ title: 'Film', subtitle: '', providerName: 'A', startSeconds: 0 })

  expect(result.ok).toBe(false)
  expect(native.stopProxy).toHaveBeenCalledTimes(1)
})
