/**
 * What proves a stream on the phone, where no response status is ever seen.
 *
 * `confirmPlaylists` is the check that stops a refused playlist counting as a
 * stream: before it, a player that asked for `master.m3u8` at 0.3 s and was
 * turned away was filed as working in 0.3 s.
 */

import { beforeEach, expect, it, vi } from 'vitest'

const peek = vi.fn()
vi.mock('./probeview', () => ({ openProbe: vi.fn(), closeAllProbes: vi.fn() }))
vi.mock('./cast', () => ({ capture: { peek: (...args: unknown[]) => peek(...args) }, PEEK_LIMIT_BYTES: 16 * 1024 }))

const { confirmPlaylists } = await import('./scan')

const request = (url: string, atMs: number) => ({ url, headers: {}, atMs })
const PLAYLIST = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow.m3u8\n'

beforeEach(() => {
  peek.mockReset()
})

it('does not count a playlist the server refused', async () => {
  peek.mockResolvedValue({ status: 403, contentType: 'text/html', body: 'Forbidden' })
  expect(await confirmPlaylists([request('https://cdn.example/master.m3u8', 300)], new Set(), new Map())).toBeNull()
})

it('does not count a playlist answered with a web page', async () => {
  peek.mockResolvedValue({ status: 200, contentType: 'text/html', body: '<!doctype html><p>gone</p>' })
  expect(await confirmPlaylists([request('https://cdn.example/master.m3u8', 300)], new Set(), new Map())).toBeNull()
})

it('counts the earliest playlist that answers as one, timed by its own request', async () => {
  peek.mockImplementation(async (c: { url: string }) => {
    return c.url.includes('dead') ? { status: 404, contentType: '', body: '' } : { status: 200, contentType: 'application/x-mpegurl', body: PLAYLIST }
  })
  const named = [request('https://good.example/master.m3u8', 2_400), request('https://dead.example/master.m3u8', 300)]
  const bodies = new Map<string, string>()
  const proof = await confirmPlaylists(named, new Set(), bodies)
  expect(proof?.url).toBe('https://good.example/master.m3u8')
  expect(proof?.atMs).toBe(2_400)
  // Kept for the quality read, which would otherwise fetch it again.
  expect(bodies.get('https://good.example/master.m3u8')).toBe(PLAYLIST)
})

it('asks about each playlist once', async () => {
  peek.mockResolvedValue({ status: 403, contentType: '', body: '' })
  const peeked = new Set<string>()
  const named = [request('https://cdn.example/master.m3u8', 300)]
  await confirmPlaylists(named, peeked, new Map())
  await confirmPlaylists(named, peeked, new Map())
  expect(peek).toHaveBeenCalledTimes(1)
})
