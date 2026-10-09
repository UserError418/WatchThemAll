/**
 * Which capture a cast hands over, and which a cast check checks.
 *
 * Each case is a way the old rule ("the newest playlist, else a whole file")
 * put the wrong thing on a television: a master's audio rendition, which a
 * page fetches after the master and so is newer; an advert's playlist; a
 * decoy file. The network is a table of answers, as a source would give them.
 */

import { describe, expect, it } from 'vitest'
import { chooseCastRoot, couldBeRoot, PEEK_BYTES, rootRefusal, rootSignature, type FetchedText, type RootFetch } from './castroot'
import { MIN_WHOLE_FILE_BYTES } from './mediarequest'
import { TS_H264_HIGH_2160X1080, WHOLE_MP4_HEAD, INIT_H264_HIGH_1080_AC3 } from '@shared/streamsignature.fixture'

const CDN = 'https://cdn.example/hls/'

/** A media playlist of `seconds`, in six-second segments named with `ext`. */
function media(seconds: number, ext = 'ts', extra = ''): string {
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', extra].filter(Boolean)
  for (let at = 0, i = 0; at < seconds; at += 6, i++) lines.push(`#EXTINF:${Math.min(6, seconds - at)},`, `seg${i}.${ext}`)
  lines.push('#EXT-X-ENDLIST', '')
  return lines.join('\n')
}

const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub",NAME="English",URI="subs/en.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"',
  '720/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"',
  '1080/index.m3u8',
].join('\n')

interface Route {
  status?: number
  type?: string
  total?: number | null
  body?: string
  bytes?: Uint8Array
}

/** A source as a table: each URL's answer. Unlisted URLs do not answer. */
function network(routes: Record<string, Route>): RootFetch & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    async text(url, _headers, limit): Promise<FetchedText | null> {
      asked.push(url)
      const route = routes[url]
      if (!route) return null
      const body = route.body ?? (route.bytes ? new TextDecoder('latin1').decode(route.bytes) : '')
      return { status: route.status ?? 200, contentType: route.type ?? 'application/vnd.apple.mpegurl', totalBytes: route.total ?? null, body: body.slice(0, limit) }
    },
    async bytes(url, headers, limit) {
      const route = routes[url]
      if (!route) return null
      const all = route.bytes ?? new TextEncoder().encode(route.body ?? '')
      const range = /bytes=(\d+)-(\d+)/.exec(headers['Range'] ?? '')
      const start = range ? Number(range[1]) : 0
      return { status: range ? 206 : (route.status ?? 200), bytes: all.subarray(start, start + limit) }
    },
  }
}

const at = (path: string): { url: string; headers: Record<string, string> } => ({ url: CDN + path, headers: { Referer: 'https://player.example/' } })

/** A whole MP4's head that says it runs `seconds`: the fixture with its mvhd duration rewritten. */
function fileOf(seconds: number): Uint8Array {
  const copy = WHOLE_MP4_HEAD.slice()
  const mvhd = new TextDecoder('latin1').decode(copy).indexOf('mvhd')
  const view = new DataView(copy.buffer)
  const timescale = view.getUint32(mvhd + 4 + 12)
  view.setUint32(mvhd + 4 + 16, Math.round(seconds * timescale))
  return copy
}

describe('chooseCastRoot', () => {
  it("takes the master, not the audio rendition fetched after it, nor the variant", async () => {
    const io = network({
      [CDN + 'master.m3u8']: { body: MASTER },
      [CDN + '720/index.m3u8']: { body: media(2700) },
      [CDN + 'audio/en.m3u8']: { body: media(2700, 'aac') },
    })
    // Newest first, as the capture lists them: the audio, the variant, the master.
    const choice = await chooseCastRoot([at('audio/en.m3u8'), at('720/index.m3u8'), at('master.m3u8')], io, null)
    expect(choice.root).toMatchObject({ kind: 'hls', url: CDN + 'master.m3u8', mediaUrl: CDN + '720/index.m3u8', length: 'unknown' })
    // The variant is where a player starts: the first listed, with what the master says of it.
    expect(choice.root?.kind === 'hls' && choice.root.variant).toMatchObject({ width: 1280, height: 720, codecs: 'avc1.4d401f,mp4a.40.2' })
  })

  it('passes over a master-listed rendition even with no master in hand to prefer', async () => {
    const io = network({
      [CDN + 'master.m3u8']: { status: 403, body: 'forbidden' },
      [CDN + 'audio/en.m3u8']: { body: media(2700, 'aac') },
      [CDN + 'subs/en.m3u8']: { body: media(2700, 'vtt') },
      [CDN + '720/index.m3u8']: { body: media(2700) },
    })
    const choice = await chooseCastRoot([at('subs/en.m3u8'), at('audio/en.m3u8'), at('720/index.m3u8'), at('master.m3u8')], io, null)
    expect(choice.root).toMatchObject({ kind: 'hls', url: CDN + '720/index.m3u8', variant: null })
    expect(choice.passedOver).toEqual(expect.arrayContaining([{ why: 'status', status: 403, media: true }, { why: 'rendition' }]))
  })

  it("passes over an advert's playlist for the film's, though the advert's is newer", async () => {
    const io = network({ [CDN + 'ad.m3u8']: { body: media(30) }, [CDN + 'film.m3u8']: { body: media(7000) } })
    const choice = await chooseCastRoot([at('ad.m3u8'), at('film.m3u8')], io, null)
    expect(choice.root).toMatchObject({ url: CDN + 'film.m3u8', seconds: 7000 })
    expect(choice.passedOver).toContainEqual({ why: 'length', seconds: 30 })
  })

  it("holds the length to TMDB's runtime when it is known", async () => {
    const io = network({ [CDN + 'other.m3u8']: { body: media(30 * 60) }, [CDN + 'film.m3u8']: { body: media(118 * 60) } })
    const choice = await chooseCastRoot([at('other.m3u8'), at('film.m3u8')], io, 120)
    expect(choice.root).toMatchObject({ url: CDN + 'film.m3u8', length: 'plausible' })
  })

  it("skips a master whose variant is an advert's length, for a media playlist that fits", async () => {
    const io = network({
      [CDN + 'master.m3u8']: { body: MASTER },
      [CDN + '720/index.m3u8']: { body: media(20) },
      [CDN + 'film.m3u8']: { body: media(2700) },
    })
    const choice = await chooseCastRoot([at('master.m3u8'), at('film.m3u8')], io, null)
    expect(choice.root).toMatchObject({ url: CDN + 'film.m3u8' })
  })

  it("tries the master's second variant when the first does not answer", async () => {
    const io = network({
      [CDN + 'master.m3u8']: { body: MASTER },
      [CDN + '720/index.m3u8']: { status: 404 },
      [CDN + '1080/index.m3u8']: { body: media(2700) },
    })
    const choice = await chooseCastRoot([at('master.m3u8')], io, null)
    expect(choice.root).toMatchObject({ url: CDN + 'master.m3u8', mediaUrl: CDN + '1080/index.m3u8' })
  })

  it('reads a playlist the peek cut short in full, for its length', async () => {
    const long = media(7200)
    expect(long.length).toBeGreaterThan(PEEK_BYTES)
    const choice = await chooseCastRoot([at('film.m3u8')], network({ [CDN + 'film.m3u8']: { body: long } }), 120)
    expect(choice.root).toMatchObject({ seconds: 7200, length: 'plausible' })
    expect(choice.bodies.get(CDN + 'film.m3u8')).toBe(long)
  })

  it('takes a whole film before a playlist, its length read from its head', async () => {
    const io = network({
      [CDN + 'film.mp4']: { type: 'video/mp4', total: 900_000_000, bytes: fileOf(7100) },
      [CDN + 'master.m3u8']: { body: MASTER },
      [CDN + '720/index.m3u8']: { body: media(7100) },
    })
    const choice = await chooseCastRoot([at('master.m3u8'), at('film.mp4')], io, 120)
    expect(choice.root).toMatchObject({ kind: 'progressive', url: CDN + 'film.mp4', length: 'plausible', totalBytes: 900_000_000 })
    expect(choice.root?.kind === 'progressive' && Math.round(choice.root.seconds!)).toBe(7100)
  })

  it('passes over a whole file smaller than any programme: an advert', async () => {
    const io = network({ [CDN + 'ad.mp4']: { type: 'video/mp4', total: MIN_WHOLE_FILE_BYTES - 1, bytes: fileOf(7100) }, [CDN + 'film.m3u8']: { body: media(7100) } })
    const choice = await chooseCastRoot([at('ad.mp4'), at('film.m3u8')], io, null)
    expect(choice.root).toMatchObject({ kind: 'hls' })
    expect(choice.passedOver).toContainEqual({ why: 'small', bytes: MIN_WHOLE_FILE_BYTES - 1 })
  })

  it("passes over a big file whose length is not the title's: VidLux's decoy", async () => {
    const io = network({ [CDN + 'decoy.mp4']: { type: 'video/mp4', total: 297_000_000, bytes: fileOf(240) } })
    const choice = await chooseCastRoot([at('decoy.mp4')], io, 45)
    expect(choice.root).toBeNull()
    expect(choice.passedOver).toContainEqual({ why: 'length', seconds: 240 })
    expect(rootRefusal(choice.passedOver, 'VidLux', 45)).toBe('VidLux serves a 4 min video here where the title runs 45 min, not the title. Try another source.')
  })

  it('takes a big file that keeps its moov at its end, its length unknown rather than wrong', async () => {
    const io = network({ [CDN + 'film.mp4']: { type: 'video/mp4', total: 900_000_000, bytes: new Uint8Array(64).fill(1) } })
    const choice = await chooseCastRoot([at('film.mp4')], io, 120)
    expect(choice.root).toMatchObject({ kind: 'progressive', seconds: null, length: 'unknown' })
  })

  it('never takes a piece of a stream for a file: an fMP4 init segment', async () => {
    const io = network({ [CDN + 'init.mp4']: { type: 'video/mp4', total: 1316, bytes: INIT_H264_HIGH_1080_AC3 } })
    expect((await chooseCastRoot([at('init.mp4')], io, null)).root).toBeNull()
  })

  it('does not ask about segments and page files at all', async () => {
    const io = network({})
    await chooseCastRoot([at('seg1.ts'), at('a.js'), at('poster.jpg'), at('x.vtt'), at('api/source?id=1')], io, null)
    expect(io.asked).toEqual([CDN + 'api/source?id=1'])
    expect(couldBeRoot('file:///etc/passwd')).toBe(false)
  })

  it('notes a DASH manifest, which no cast sends', async () => {
    const io = network({ [CDN + 'manifest.mpd']: { type: 'application/dash+xml', body: '<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011">' } })
    const choice = await chooseCastRoot([at('manifest.mpd')], io, null)
    expect(choice).toMatchObject({ root: null, passedOver: [{ why: 'dash' }] })
  })
})

describe('chooseCastRoot with a deadline', () => {
  it("stops asking about further candidates once the cast check's time for it is up", async () => {
    let clock = 0
    const io = network({ [CDN + 'film.m3u8']: { body: media(2700) } })
    const slow: RootFetch = {
      ...io,
      // Each batch of four takes a second of the check's clock.
      text: async (url, headers, limit) => {
        clock += 250
        return io.text(url, headers, limit)
      },
    }
    const late = ['a', 'b', 'c', 'd'].map((x) => at(`api/${x}`))
    const choice = await chooseCastRoot([...late, at('film.m3u8')], slow, null, { deadline: 1_000, now: () => clock })
    // The film's playlist was in the second batch, never asked about.
    expect(choice.root).toBeNull()
    expect(choice.complete).toBe(false)
    expect(io.asked).toEqual(late.map((c) => c.url))
    // Without one, as for a cast, every candidate is asked about.
    expect((await chooseCastRoot([...late, at('film.m3u8')], io, null)).root).toMatchObject({ url: CDN + 'film.m3u8' })
  })

  it("tells a refusal of the stream's from an advert's: only one named as media counts", async () => {
    // Measured 2026-10-09: MoviesAPI's page beside a tracker answering 400.
    const io = network({
      [CDN + 'cuid/']: { status: 400, body: '' },
      [CDN + 'film.m3u8']: { status: 403, body: 'forbidden' },
    })
    const choice = await chooseCastRoot([at('cuid/'), at('film.m3u8')], io, null)
    expect(choice.root).toBeNull()
    expect(choice.complete).toBe(true)
    expect(choice.passedOver).toEqual([
      { why: 'status', status: 400, media: false },
      { why: 'status', status: 403, media: true },
    ])
  })
})

describe('rootRefusal', () => {
  it('says why when only renditions were left', () => {
    expect(rootRefusal([{ why: 'rendition' }], 'VidZee', null)).toBe('VidZee hands out only a separate sound or subtitle stream. Try another source.')
  })

  it('has nothing to say about statuses alone: the caller words those', () => {
    expect(rootRefusal([{ why: 'status', status: 403, media: true }], 'VidZee', null)).toBeNull()
  })
})

describe('rootSignature', () => {
  it("reads a TS root's first segment opening: Videasy's 2160x1080", async () => {
    const io = network({
      [CDN + 'film.m3u8']: { body: media(2700) },
      [CDN + 'seg0.ts']: { type: 'video/mp2t', bytes: TS_H264_HIGH_2160X1080 },
    })
    const { root } = await chooseCastRoot([at('film.m3u8')], io, null)
    expect(await rootSignature(root!, io)).toEqual({
      container: 'ts',
      video: { codec: 'h264', profile: 'high', level: 5, width: 2160, height: 1080, fps: 24 },
      audio: ['aac'],
      encryption: 'none',
    })
  })

  it("reads an fMP4 root's init segment, under the master's word for the rest", async () => {
    const io = network({
      [CDN + 'master.m3u8']: { body: MASTER },
      [CDN + '720/index.m3u8']: { body: media(2700, 'm4s', '#EXT-X-MAP:URI="init.mp4"') },
      [CDN + '720/init.mp4']: { type: 'video/mp4', bytes: INIT_H264_HIGH_1080_AC3 },
    })
    const { root } = await chooseCastRoot([at('master.m3u8')], io, null)
    const signature = await rootSignature(root!, io)
    expect(signature).toMatchObject({ container: 'fmp4', video: { codec: 'h264', width: 1920, height: 1080, fps: 25 } })
    // The init's AC-3 and the master's AAC (its audio group) are both heard.
    expect(signature.audio).toEqual(['ac3', 'aac'])
  })

  it('reads only the master and the key method for an encrypted TS root', async () => {
    const io = network({
      [CDN + 'master.m3u8']: { body: MASTER },
      [CDN + '720/index.m3u8']: { body: media(2700, 'ts', '#EXT-X-KEY:METHOD=AES-128,URI="k.bin"') },
      [CDN + '720/seg0.ts']: { bytes: new Uint8Array(4096).fill(7) },
    })
    const { root } = await chooseCastRoot([at('master.m3u8')], io, null)
    expect(await rootSignature(root!, io)).toMatchObject({
      container: null,
      video: { codec: 'h264', profile: 'main', level: 3.1, width: 1280, height: 720 },
      encryption: 'aes-128',
    })
  })

  it("reads a whole file's codecs from the head the choice already read", async () => {
    const io = network({ [CDN + 'film.mp4']: { type: 'video/mp4', total: 900_000_000, bytes: fileOf(7100) } })
    const { root } = await chooseCastRoot([at('film.mp4')], io, null)
    expect(await rootSignature(root!, io)).toMatchObject({ container: 'mp4', video: { codec: 'h264', width: 1280, height: 536 } })
  })
})
