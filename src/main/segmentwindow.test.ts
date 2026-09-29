import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  masterVariants,
  parseMediaPlaylist,
  pickVariant,
  segmentExtension,
  selectWindow,
  windowPlaylist,
  type MediaPlaylist,
} from './segmentwindow'

const BASE = 'https://cdn.example/hls/ep/index.m3u8'

/** A VOD playlist of `count` segments of `seconds` each, named like VidSrc's. */
function vod(count: number, seconds = 5.005, head = ''): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:0', head]
  for (let i = 0; i < count; i++) lines.push(`#EXTINF:${seconds},`, `seg-${i}.ts?t=abc`)
  lines.push('#EXT-X-ENDLIST')
  return lines.filter((l) => l !== '').join('\n')
}

function parsed(body: string): MediaPlaylist {
  const result = parseMediaPlaylist(body, BASE)
  if (!result.ok) throw new Error(result.reason)
  return result.playlist
}

describe('parseMediaPlaylist', () => {
  it('places every segment on the film timeline, with absolute URLs', () => {
    const playlist = parsed(vod(4))
    expect(playlist.segments.map((s) => s.start)).toEqual([0, 5.005, 10.01, 15.015])
    expect(playlist.segments[0]!.url).toBe('https://cdn.example/hls/ep/seg-0.ts?t=abc')
    expect(playlist.totalSeconds).toBeCloseTo(20.02)
  })

  it('refuses what cannot be kept', () => {
    expect(parseMediaPlaylist('<html>', BASE)).toEqual({ ok: false, reason: 'not-a-playlist' })
    expect(parseMediaPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8', BASE)).toEqual({ ok: false, reason: 'master' })
    expect(parseMediaPlaylist(vod(3).replace('#EXT-X-ENDLIST', ''), BASE)).toEqual({ ok: false, reason: 'live' })
    expect(parseMediaPlaylist(vod(2, 5, '#EXT-X-BYTERANGE:100@0'), BASE)).toEqual({ ok: false, reason: 'byte-ranges' })
    expect(parseMediaPlaylist(vod(2, 5, '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"'), BASE)).toEqual({ ok: false, reason: 'drm' })
  })

  it('keeps AES-128 keys and fMP4 maps with the segments they apply to', () => {
    const body = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MEDIA-SEQUENCE:40',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-KEY:METHOD=AES-128,URI="/keys/1"',
      '#EXTINF:6,',
      'a.m4s',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXTINF:6,',
      'b.m4s',
      '#EXT-X-ENDLIST',
    ].join('\n')
    const [a, b] = parsed(body).segments
    expect(a!.key?.url).toBe('https://cdn.example/keys/1')
    expect(a!.map?.url).toBe('https://cdn.example/hls/ep/init.mp4')
    expect(a!.sequence).toBe(40)
    expect(b!.key).toBeNull()
    expect(b!.sequence).toBe(41)
  })
})

describe('selectWindow', () => {
  it('takes the segment playing at the second, and on until the stretch is covered', () => {
    const window = selectWindow(parsed(vod(200)), 600, 25)!
    expect(window.startSeconds).toBeCloseTo(595.595)
    expect(window.segments.map((s) => s.sequence)).toEqual([119, 120, 121, 122, 123, 124])
    expect(window.endSeconds).toBeGreaterThanOrEqual(625)
  })

  it('stops at the end of the film', () => {
    const playlist = parsed(vod(10))
    expect(selectWindow(playlist, 48)!.segments.map((s) => s.sequence)).toEqual([9])
    expect(selectWindow(playlist, 60)).toBeNull()
  })

  it('always covers the second asked for, and never more than one segment past the stretch', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 1, max: 12, noNaN: true }), { minLength: 1, maxLength: 60 }),
        fc.double({ min: 0, max: 400, noNaN: true }),
        (lengths, from) => {
          const body = ['#EXTM3U', ...lengths.flatMap((l, i) => [`#EXTINF:${l},`, `s${i}.ts`]), '#EXT-X-ENDLIST'].join('\n')
          const playlist = parsed(body)
          const window = selectWindow(playlist, from, 25)
          if (from >= playlist.totalSeconds) {
            expect(window).toBeNull()
            return
          }
          expect(window!.startSeconds).toBeLessThanOrEqual(from)
          const last = window!.segments[window!.segments.length - 1]!
          expect(last.start).toBeLessThan(from + 25)
          expect(window!.endSeconds).toBeGreaterThanOrEqual(Math.min(from + 25, playlist.totalSeconds) - 1e-9)
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe('windowPlaylist', () => {
  it('names the copies, keeps the sequence for the IVs, and ends the list', () => {
    const body = vod(20, 5, '#EXT-X-KEY:METHOD=AES-128,URI="k.bin",IV=0x01')
    const window = selectWindow(parsed(body), 10, 10)!
    const names = new Map<string, string>()
    const text = windowPlaylist(window, 3, (url) => {
      if (!names.has(url)) names.set(url, url.includes('k.bin') ? 'k0.key' : `s${names.size}.ts`)
      return names.get(url)!
    })
    expect(text).toContain('#EXT-X-MEDIA-SEQUENCE:2')
    expect(text).toContain('#EXT-X-KEY:METHOD=AES-128,URI="k0.key",IV=0x01')
    expect(text).not.toContain('cdn.example')
    expect(text.trim().endsWith('#EXT-X-ENDLIST')).toBe(true)
    expect(text.match(/#EXTINF/g)).toHaveLength(2)
  })
})

describe('variants', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=749325,RESOLUTION=640x360',
    '360/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2876777,RESOLUTION=1280x720',
    '720/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=3840x2160',
    '2160/index.m3u8',
  ].join('\n')

  it('keeps the one the player was fetching', () => {
    const variants = masterVariants(master, BASE)
    expect(pickVariant(variants, new Set(['https://cdn.example/hls/ep/360/index.m3u8']))?.height).toBe(360)
  })

  it('else the best at or under 1080 lines', () => {
    expect(pickVariant(masterVariants(master, BASE), new Set())?.height).toBe(720)
  })
})

describe('segmentExtension', () => {
  it('tells MPEG-TS from fragmented MP4 by their first bytes', () => {
    const ts = new Uint8Array(400)
    ts[0] = 0x47
    ts[188] = 0x47
    expect(segmentExtension(ts)).toBe('ts')
    const mp4 = new Uint8Array([0, 0, 0, 24, ...'moof'.split('').map((c) => c.charCodeAt(0))])
    expect(segmentExtension(mp4)).toBe('m4s')
    expect(segmentExtension(new TextEncoder().encode('<html><body>'))).toBeNull()
  })
})
