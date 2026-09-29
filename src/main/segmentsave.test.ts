import { describe, expect, it } from 'vitest'
import { saveStreamWindow, type SaveIo } from './segmentsave'

const TS = (() => {
  const bytes = new Uint8Array(400)
  bytes[0] = 0x47
  bytes[188] = 0x47
  return bytes
})()

function playlist(count: number, seconds: number, prefix: string): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6']
  for (let i = 0; i < count; i++) lines.push(`#EXTINF:${seconds},`, `${prefix}${i}.ts`)
  return [...lines, '#EXT-X-ENDLIST'].join('\n')
}

/** A network: text by URL, segment bytes by URL (anything under /seg/ is a TS segment unless listed as broken). */
function fakeIo(texts: Record<string, string>, broken: string[] = []) {
  const written: Record<string, string> = {}
  const downloads: string[] = []
  const io: SaveIo = {
    async fetchText(url) {
      return url in texts ? { status: 200, body: texts[url]! } : null
    },
    async download(url, _headers, name) {
      downloads.push(`${name} <- ${url}`)
      if (broken.includes(url)) return { status: 200, bytes: 20, head: new TextEncoder().encode('<html>blocked</html>') }
      return { status: 200, bytes: 1_300_000, head: TS }
    },
    async writeText(name, text) {
      written[name] = text
    },
  }
  return { io, written, downloads }
}

const FILM = { seconds: 600, duration: 2518.7 }
const HEADERS = { Referer: 'https://source.example/' }

describe('saveStreamWindow', () => {
  it("keeps the film's window, passing over an advert's playlist", async () => {
    const { io, written, downloads } = fakeIo({
      'https://ads.example/pre.m3u8': playlist(3, 10, 'ad'),
      'https://cdn.example/ep/index.m3u8': playlist(504, 5, 'https://cdn.example/seg/'),
    })
    const outcome = await saveStreamWindow(
      [
        { url: 'https://ads.example/pre.m3u8', headers: HEADERS },
        { url: 'https://cdn.example/ep/index.m3u8', headers: HEADERS },
      ],
      FILM,
      42,
      io,
    )
    expect(outcome).toEqual({ ok: true, startSeconds: 600, endSeconds: 625, bytes: 5 * 1_300_000 })
    expect(downloads[0]).toBe('s0.ts <- https://cdn.example/seg/120.ts')
    expect(written['index.m3u8']).toContain('s4.ts')
    expect(written['index.m3u8']).not.toContain('cdn.example')
  })

  it('takes the best variant when only the master was captured as a playlist', async () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x720\n720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360\n360.m3u8'
    const { io, downloads } = fakeIo({
      'https://cdn.example/master.m3u8': master,
      'https://cdn.example/720.m3u8': playlist(504, 5, 'https://cdn.example/seg720/'),
    })
    const outcome = await saveStreamWindow([{ url: 'https://cdn.example/master.m3u8', headers: HEADERS }], FILM, 42, io)
    expect(outcome.ok).toBe(true)
    expect(downloads[0]).toBe('s0.ts <- https://cdn.example/seg720/120.ts')
  })

  it('keeps what arrived before an error page, when that is enough', async () => {
    const { io, written } = fakeIo(
      { 'https://cdn.example/ep/index.m3u8': playlist(504, 5, 'https://cdn.example/seg/') },
      ['https://cdn.example/seg/123.ts'],
    )
    const outcome = await saveStreamWindow([{ url: 'https://cdn.example/ep/index.m3u8', headers: HEADERS }], FILM, 42, io)
    expect(outcome).toEqual({ ok: true, startSeconds: 600, endSeconds: 615, bytes: 3 * 1_300_000 })
    expect(written['index.m3u8']?.match(/#EXTINF/g)).toHaveLength(3)
  })

  it('refuses a playlist that is not the film the player showed', async () => {
    const { io } = fakeIo({ 'https://cdn.example/other.m3u8': playlist(200, 5, 'https://cdn.example/seg/') })
    const outcome = await saveStreamWindow([{ url: 'https://cdn.example/other.m3u8', headers: HEADERS }], FILM, 42, io)
    expect(outcome).toEqual({ ok: false, reason: 'not-the-film' })
  })
})
