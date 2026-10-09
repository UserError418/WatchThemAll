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
import type { FrameReading } from '@shared/enginereader'

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
  expect(await readQuality(new Map(), requests)).toMatchObject({ best: 720, kind: 'offered' })
})

it('files the rendition beside a master that would not answer as a floor', async () => {
  read.mockImplementation(async (c: { url: string }) =>
    c.url === MASTER ? { status: 403, contentType: 'text/html', body: 'Forbidden' } : { status: 200, contentType: '', body: MEDIA },
  )
  // The header's 854x480 is the rung the player started on, not the best.
  expect(await readQuality(new Map(), requests)).toMatchObject({ best: 480, kind: 'floor' })
})

/** A whole media playlist: `count` segments of six seconds, ended. */
const whole = (count: number): string =>
  ['#EXTM3U', ...Array.from({ length: count }, (_, i) => `#EXTINF:6.0,\nseg${i}.ts`), '#EXT-X-ENDLIST'].join('\n')
/** One frame's engine reading: a video of `duration` seconds whose engine lists `heights`. */
const engine = (duration: number, heights: number[], audio: string[] = []): FrameReading => ({
  videos: [{ duration, width: 0, height: 0, levels: heights.map((height) => ({ width: 0, height })), streams: false, audio }],
})

it("files the engine's own list as an offer where no playlist answers, as a play does", async () => {
  // VidSrc's playlists answer 403 to the phone's own fetch: measured 2026-09-26.
  read.mockResolvedValue({ status: 403, contentType: 'text/html', body: 'ip not in range' })
  const page = { engines: () => [engine(8_340, [480, 1080], ['en'])], runtimeMinutes: 139 }
  expect(await readQuality(new Map(), requests, page)).toEqual({ best: 1080, kind: 'offered', audio: ['en'], film: { kind: 'film' } })
  // No header is asked for: the engine's list says more than one rung could.
  expect(peekBytes).not.toHaveBeenCalled()
})

it('reads a master\'s audio renditions', async () => {
  const withAudio = `#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="ja",NAME="Japanese",URI="ja.m3u8"\n${LADDER.slice('#EXTM3U\n'.length)}`
  read.mockImplementation(async (c: { url: string }) =>
    c.url === MASTER ? { status: 200, contentType: '', body: withAudio } : { status: 200, contentType: '', body: MEDIA },
  )
  expect((await readQuality(new Map(), requests)).audio).toEqual(['ja'])
})

it('calls a clip in the film\'s place something else, by its whole playlist or its video', async () => {
  // 167 s: VidRock's clip for the 139-minute Fight Club.
  read.mockImplementation(async (c: { url: string }) =>
    c.url === MASTER ? { status: 403, contentType: '', body: '' } : { status: 200, contentType: '', body: whole(28) },
  )
  const page = { engines: () => [engine(167, [])], runtimeMinutes: 139 }
  expect((await readQuality(new Map(), requests, page)).film).toEqual({ kind: 'other', seconds: 168 })
})

it('says nothing about the film when no length is known', async () => {
  // MEDIA has no ENDLIST: what was read may be part of it.
  read.mockImplementation(async (c: { url: string }) =>
    c.url === MASTER ? { status: 200, contentType: '', body: LADDER } : { status: 200, contentType: '', body: MEDIA },
  )
  expect((await readQuality(new Map(), requests, { engines: () => [], runtimeMinutes: 139 })).film).toEqual({ kind: 'unknown' })
})
