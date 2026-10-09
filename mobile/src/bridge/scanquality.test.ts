/**
 * What the phone's test files as a source's quality, and what it is worth.
 *
 * The phone sees no response statuses, so a playlist the player was refused
 * and one that answered look alike in its log; only asking again tells them
 * apart. A master that would not answer, beside a variant that did, used to
 * pass the variant off as the only rendition: MoviesAPI read 240p here where
 * every desktop reading of the same title is a 720p ladder.
 */

import { beforeEach, expect, it, vi } from 'vitest'
import { AUDIO_FIRST_854X480 } from '@shared/initsegment.fixture'

const read = vi.fn()
const peekBytes = vi.fn()
vi.mock('./probeview', () => ({ openProbe: vi.fn(), closeAllProbes: vi.fn() }))
vi.mock('./cast', () => ({
  capture: { read: (...args: unknown[]) => read(...args), peekBytes: (...args: unknown[]) => peekBytes(...args) },
  PEEK_LIMIT_BYTES: 16 * 1024,
}))

const { readQuality } = await import('./scan')

const request = (url: string, atMs: number) => ({ url, headers: {}, atMs })
const MASTER = 'https://cdn.example/ep/master.m3u8'
const VARIANT = 'https://cdn.example/ep/240/index.m3u8'

const LADDER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=426x240',
  '240/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
  '720/index.m3u8',
].join('\n')
/** A film-length fMP4 media playlist: its init segment states the rendition's size. */
const MEDIA = ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', ...Array.from({ length: 300 }, (_, i) => `#EXTINF:6.0,\nseg${i}.m4s`)].join('\n')

beforeEach(() => {
  read.mockReset()
  peekBytes.mockReset()
  peekBytes.mockResolvedValue({ status: 200, bytes: AUDIO_FIRST_854X480 })
})

const requests = async () => [request(MASTER, 100), request(VARIANT, 200)]

it('files a master it could read as what the source offers', async () => {
  read.mockImplementation(async (c: { url: string }) =>
    c.url === MASTER ? { status: 200, contentType: '', body: LADDER } : { status: 200, contentType: '', body: MEDIA },
  )
  expect(await readQuality(new Map(), requests)).toEqual({ best: 720, kind: 'offered' })
})

it('files the rendition beside a master that would not answer as a floor', async () => {
  read.mockImplementation(async (c: { url: string }) =>
    c.url === MASTER ? { status: 403, contentType: 'text/html', body: 'Forbidden' } : { status: 200, contentType: '', body: MEDIA },
  )
  // The header's 854x480 is the rung the player started on, not the best.
  expect(await readQuality(new Map(), requests)).toEqual({ best: 480, kind: 'floor' })
})
