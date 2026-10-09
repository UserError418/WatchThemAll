/**
 * The cast check, run for real on this machine: a fake source on one
 * loopback port, the desktop's own cast proxy on another (`desktopCastPath`),
 * and the check walking it as a receiver would.
 *
 * Each case is an outcome the cast list acts on: reached and read; blocked
 * by the proxy's single set of headers; a "segment" that is a web page; a
 * segment slower to arrive than to play; an advert in the title's place.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { TS_H264_HIGH_2160X1080, WHOLE_MP4_HEAD } from '@shared/streamsignature.fixture'
import { checkCast, paceOf } from './castcheck'
import { checkRootFetch, desktopCastPath } from './castfetch'
import { MIN_WHOLE_FILE_BYTES } from './mediarequest'
import type { CastCheck } from '@shared/types'

/** A media playlist of `count` segments of `seconds` each. */
function media(count: number, seconds = 6, extra = ''): string {
  const lines = ['#EXTM3U', `#EXT-X-TARGETDURATION:${Math.ceil(seconds)}`, extra].filter(Boolean)
  for (let i = 0; i < count; i++) lines.push(`#EXTINF:${seconds},`, `seg${i}.ts`)
  return [...lines, '#EXT-X-ENDLIST', ''].join('\n')
}

const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=2160x1080,CODECS="avc1.640032,mp4a.40.2"\nv/index.m3u8\n'

/** A transport stream segment: the fixture's opening, padded with null packets. */
function segment(): Buffer {
  const pad = Buffer.alloc(188 * 200, 0xff)
  for (let i = 0; i < 200; i++) pad.set([0x47, 0x1f, 0xff, 0x10], i * 188)
  return Buffer.concat([Buffer.from(TS_H264_HIGH_2160X1080), pad])
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void

let source: Server | null = null
afterEach(() => {
  source?.closeAllConnections()
  source?.close()
  source = null
})

/** A source answering by path; a route not listed answers 404. */
function serve(routes: Record<string, Handler>): Promise<string> {
  return new Promise((resolve) => {
    source = createServer((request, response) => {
      const route = routes[(request.url ?? '').split('?')[0]!]
      if (route) return route(request, response)
      response.writeHead(404)
      response.end()
    })
    source.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(source!.address() as { port: number }).port}`))
  })
}

const text = (body: string, type = 'application/vnd.apple.mpegurl'): Handler => (_q, r) => {
  r.writeHead(200, { 'Content-Type': type })
  r.end(body)
}
const bytes = (body: Buffer, type = 'video/mp2t'): Handler => (_q, r) => {
  r.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length })
  r.end(body)
}

const checkOrNothing = (origin: string, paths: string[], runtimeMinutes: number | null = null, headers: Record<string, string> = {}) =>
  checkCast({
    candidates: paths.map((path) => ({ url: origin + path, headers })),
    runtimeMinutes,
    io: checkRootFetch,
    open: desktopCastPath,
  })

/** A check that must have something to file. */
async function check(...args: Parameters<typeof checkOrNothing>): Promise<CastCheck> {
  const result = await checkOrNothing(...args)
  if (result === null) throw new Error('the check filed nothing')
  return result
}

describe('checkCast, through the desktop proxy', () => {
  it("reaches a master's first variant and its first segment, and reads Videasy's 2160x1080 from it", async () => {
    const origin = await serve({
      '/master.m3u8': text(MASTER),
      '/v/index.m3u8': text(media(450)),
      '/v/seg0.ts': bytes(segment()),
    })
    const result = await check(origin, ['/master.m3u8'], 45)
    expect(result).toMatchObject({
      reach: 'ok',
      identity: 'film',
      seconds: 2700,
      signature: {
        container: 'ts',
        video: { codec: 'h264', profile: 'high', level: 5, width: 2160, height: 1080, fps: 24 },
        audio: ['aac'],
        encryption: 'none',
      },
    })
    expect(result.pace).toBeLessThan(1)
  })

  /*
   * The cause the owner's cast list hid: the page sent each request its own
   * headers, the proxy replays one set, the root's. A source that wants a
   * token on its segments the playlist request did not carry refuses them.
   */
  it("is blocked when the source refuses the proxy's single set of headers", async () => {
    const origin = await serve({
      '/film.m3u8': text(media(450)),
      '/seg0.ts': (request, response) => {
        if (request.headers['x-segment-token'] !== 'yes') {
          response.writeHead(403)
          response.end('forbidden')
          return
        }
        bytes(segment())(request, response)
      },
    })
    expect(await check(origin, ['/film.m3u8'])).toMatchObject({ reach: 'blocked', status: 403, identity: 'unknown' })
  })

  it('is blocked when a playlist the bundle needs is refused', async () => {
    const origin = await serve({ '/master.m3u8': text(MASTER), '/v/index.m3u8': (_q, r) => void (r.writeHead(403), r.end()) })
    expect(await check(origin, ['/master.m3u8'])).toMatchObject({ reach: 'blocked', status: 403 })
  })

  it('says not-media for a segment that is a web page', async () => {
    const origin = await serve({ '/film.m3u8': text(media(450)), '/seg0.ts': text('<html>no video here</html>'.repeat(20), 'text/html') })
    expect(await check(origin, ['/film.m3u8'])).toMatchObject({ reach: 'not-media' })
  })

  it('says slow for a segment that takes longer to arrive than it plays', async () => {
    const origin = await serve({
      // 0.3 s segments; this one takes 0.7 s to come.
      '/film.m3u8': text(media(3000, 0.3)),
      '/seg0.ts': (request, response) => void setTimeout(() => bytes(segment())(request, response), 700),
    })
    const result = await check(origin, ['/film.m3u8'])
    expect(result.reach).toBe('slow')
    expect(result.pace).toBeGreaterThan(1)
  })

  it('reaches a segment behind an image disguise: the proxy strips it, as for a receiver', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
    const origin = await serve({ '/film.m3u8': text(media(450)), '/seg0.ts': bytes(Buffer.concat([png, segment()]), 'image/png') })
    expect(await check(origin, ['/film.m3u8'])).toMatchObject({ reach: 'ok', signature: { video: { width: 2160 } } })
  })

  it("says wrong-length when the only stream is an advert's", async () => {
    const origin = await serve({ '/ad.m3u8': text(media(5)) })
    expect(await check(origin, ['/ad.m3u8'])).toEqual({ reach: 'not-media', identity: 'wrong-length', seconds: 30 })
  })

  it('times a whole file by the film its opening holds', async () => {
    const total = MIN_WHOLE_FILE_BYTES + 1_000_000
    const head = Buffer.from(WHOLE_MP4_HEAD)
    // The fixture's mvhd says 2 s; a film's length makes it the title.
    const view = new DataView(head.buffer, head.byteOffset)
    const mvhd = head.indexOf('mvhd')
    view.setUint32(mvhd + 4 + 16, Math.round(2700 * view.getUint32(mvhd + 4 + 12)))
    const file = Buffer.concat([head, Buffer.alloc(total - head.length)])
    const origin = await serve({
      '/film.mp4': (request, response) => {
        const range = /bytes=(\d+)-(\d+)/.exec(request.headers.range ?? '')
        if (!range) return bytes(file, 'video/mp4')(request, response)
        const [start, end] = [Number(range[1]), Math.min(Number(range[2]), total - 1)]
        response.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 })
        response.end(file.subarray(start, end + 1))
      },
    })
    const result = await check(origin, ['/film.mp4'], 45)
    expect(result).toMatchObject({ reach: 'ok', identity: 'film', signature: { container: 'mp4', video: { codec: 'h264', width: 1280, height: 536 } } })
    expect(result.pace).toBeLessThan(1)
  })

  it('says blocked with the status when nothing could be chosen because the source refused', async () => {
    const origin = await serve({ '/film.m3u8': (_q, r) => void (r.writeHead(410), r.end()) })
    expect(await check(origin, ['/film.m3u8'])).toEqual({ reach: 'blocked', identity: 'unknown', status: 410 })
  })

  it("files nothing when the only refusal was an advert's: the stream was not among what it was given", async () => {
    // Measured 2026-10-09 on MoviesAPI: a tracker's 400 filed as the source blocking casts.
    const origin = await serve({
      '/cuid/': (_q, r) => void (r.writeHead(400), r.end()),
      '/api/config': text('{"ok":true}', 'application/json'),
    })
    expect(await checkOrNothing(origin, ['/cuid/', '/api/config'])).toBeNull()
  })

  it('says not-media when every request answered and none of them is media', async () => {
    const origin = await serve({ '/api/config': text('{"ok":true}', 'application/json') })
    expect(await check(origin, ['/api/config'])).toEqual({ reach: 'not-media', identity: 'unknown' })
  })
})

describe('paceOf', () => {
  it('is the time to arrive over the time to play, for a sample that arrived whole', () => {
    expect(paceOf({ bytes: 3e6, totalBytes: 3e6, elapsedMs: 1500, complete: true }, 6)).toBe(0.25)
  })

  it('projects a sample the deadline cut off from its rate so far, where its size is known', () => {
    // A third arrived in 3 s: the whole would take 9 s, for 6 s of film.
    expect(paceOf({ bytes: 1e6, totalBytes: 3e6, elapsedMs: 3000, complete: false }, 6)).toBe(1.5)
  })

  it('says slow from the time alone once that passed the length, and nothing before', () => {
    expect(paceOf({ bytes: 0, totalBytes: null, elapsedMs: 7000, complete: false }, 6)).toBeCloseTo(1.17)
    expect(paceOf({ bytes: 0, totalBytes: null, elapsedMs: 3000, complete: false }, 6)).toBeNull()
    expect(paceOf({ bytes: 1, totalBytes: 1, elapsedMs: 10, complete: true }, 0)).toBeNull()
  })
})
