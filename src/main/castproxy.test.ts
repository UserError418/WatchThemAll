import { createServer, type Server } from 'node:http'
import { describe, it, expect, afterEach } from 'vitest'
import {
  byteRange,
  createCastProxy,
  idFromPath,
  isUpstreamSuccess,
  lanAddress,
  mediaContentType,
  pickLanAddress,
  replayableHeaders,
  type CastProxy,
} from './castproxy'

describe('idFromPath', () => {
  it('strips the .m3u8 the receiver sniffs for', () => {
    expect(idFromPath('/p3.m3u8')).toBe('p3')
  })

  it('leaves a segment id alone', () => {
    expect(idFromPath('/s41')).toBe('s41')
  })

  it('ignores a query string the receiver may append', () => {
    expect(idFromPath('/s41?cast_autoplay=1')).toBe('s41')
  })

  it('does not turn an unknown path into a known one', () => {
    expect(idFromPath('/')).toBe('')
    expect(idFromPath('/../../etc/passwd')).toBe('../../etc/passwd')
  })
})

describe('replayableHeaders', () => {
  /**
   * `Range` is the dangerous one. It was captured from whatever byte the app's
   * own player wanted, and replaying it on a *manifest* request returns a slice
   * of the playlist — a truncated stream that parses cleanly, so the failure
   * reads as a bug in the rewriter rather than a stray header.
   */
  it('drops Range, whatever its casing', () => {
    expect(replayableHeaders({ Range: 'bytes=0-1', referer: 'https://x/' })).toEqual({
      referer: 'https://x/',
    })
    expect(replayableHeaders({ RANGE: 'bytes=0-1' })).toEqual({})
  })

  it('keeps the headers the provider actually gates on', () => {
    const kept = replayableHeaders({
      Referer: 'https://player.example/',
      Origin: 'https://player.example',
      'User-Agent': 'Mozilla/5.0',
      Cookie: 'session=1',
    })
    expect(Object.keys(kept).sort()).toEqual(['Cookie', 'Origin', 'Referer', 'User-Agent'])
  })

  /** Reported length must equal bytes sent, so compression is refused. */
  it('drops Accept-Encoding', () => {
    expect(replayableHeaders({ 'accept-encoding': 'gzip' })).toEqual({})
  })
})

describe('mediaContentType', () => {
  /**
   * Measured, not hypothetical: VidSrc serves transport-stream segments as
   * `text/html`. mpv ignores it; a receiver that sniffs could decide the
   * segment is a web page and refuse the stream.
   */
  it('replaces a text/* answer on binary media', () => {
    expect(mediaContentType('text/html; charset=UTF-8', 'https://cdn/x/seg0.ts')).toBe('video/mp2t')
    expect(mediaContentType('text/plain', 'https://cdn/x/seg0.m4s')).toBe('video/mp4')
  })

  it('falls back to a type that claims nothing when the URL implies nothing', () => {
    expect(mediaContentType('text/html', 'https://cdn/pl/H4sIAAAA')).toBe('application/octet-stream')
    expect(mediaContentType(undefined, 'https://cdn/x')).toBe('application/octet-stream')
  })

  it('believes a provider that answered accurately', () => {
    expect(mediaContentType('video/mp2t', 'https://cdn/x/seg0.ts')).toBe('video/mp2t')
    expect(mediaContentType('application/vnd.apple.mpegurl', 'https://cdn/x/a.m3u8')).toBe(
      'application/vnd.apple.mpegurl',
    )
  })

  it('is not confused by a query string after the extension', () => {
    expect(mediaContentType('text/html', 'https://cdn/seg0.ts?token=abc')).toBe('video/mp2t')
  })
})

describe('pickLanAddress', () => {
  /**
   * The bug this exists to prevent, found on the build machine: it runs
   * Tailscale, whose 100.x address can enumerate ahead of the real one. Handing
   * that to a Chromecast produces a URL that resolves nowhere and a cast that
   * times out saying nothing useful.
   */
  it('prefers a real LAN address over a Tailscale one, whatever the order', () => {
    expect(pickLanAddress(['100.101.102.103', '192.168.1.20'])).toBe('192.168.1.20')
    expect(pickLanAddress(['192.168.1.20', '100.101.102.103'])).toBe('192.168.1.20')
  })

  it('accepts every private range a home network uses', () => {
    expect(pickLanAddress(['10.0.0.5'])).toBe('10.0.0.5')
    expect(pickLanAddress(['172.20.1.4'])).toBe('172.20.1.4')
    expect(pickLanAddress(['192.168.1.1'])).toBe('192.168.1.1')
  })

  /** 172.32 is public space, not the private 172.16–31 block. */
  it('does not mistake 172.32 for a private address', () => {
    expect(pickLanAddress(['172.32.0.1', '10.1.2.3'])).toBe('10.1.2.3')
  })

  /** A self-assigned address means DHCP failed; nothing is expecting it. */
  it('takes a link-local address only when there is nothing else', () => {
    expect(pickLanAddress(['169.254.9.9', '100.100.1.1'])).toBe('100.100.1.1')
    expect(pickLanAddress(['169.254.9.9'])).toBe('169.254.9.9')
  })

  it('answers null rather than guessing when there is no address', () => {
    expect(pickLanAddress([])).toBeNull()
  })
})

describe('byteRange', () => {
  it('reads the ranges a receiver asks for, within the file', () => {
    expect(byteRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(byteRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 })
    expect(byteRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(byteRange('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('sends the whole file for no range, or one it cannot serve', () => {
    expect(byteRange(undefined, 1000)).toBeNull()
    expect(byteRange('bytes=2000-', 1000)).toBeNull()
    expect(byteRange('items=0-1', 1000)).toBeNull()
  })
})

describe('what the proxy saw', () => {
  /** A source: `/ok` answers with a segment, `/refused` with 403, as a source without its headers does. */
  let source: Server | null = null
  let proxy: CastProxy | null = null

  afterEach(() => {
    proxy?.stop()
    proxy = null
    source?.close()
    source = null
  })

  const startSource = (): Promise<string> =>
    new Promise((resolve) => {
      source = createServer((request, response) => {
        response.writeHead(request.url === '/ok' ? 200 : 403, { 'Content-Type': 'video/mp2t' })
        response.end('segment')
      })
      source.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(source!.address() as { port: number }).port}`))
    })

  it('takes a 2xx, ranges included, as the source serving', () => {
    expect(isUpstreamSuccess(200)).toBe(true)
    expect(isUpstreamSuccess(206)).toBe(true)
    expect(isUpstreamSuccess(403)).toBe(false)
    expect(isUpstreamSuccess(302)).toBe(false)
  })

  /*
   * The two counts a cast's answer is filed by (`castOutcomeOf`). A segment
   * the source refused is the source blocking the cast; without the count it
   * was filed as the television refusing the format.
   */
  it.skipIf(lanAddress() === null)('counts what the receiver asked for, and what the source refused or never answered', async () => {
    const origin = await startSource()
    proxy = createCastProxy()
    const base = await proxy.start({
      playlists: { p0: '#EXTM3U\n' },
      // Nothing listens on port 1: the source never answers at all.
      targets: { s0: `${origin}/ok`, s1: `${origin}/refused`, s2: 'http://127.0.0.1:1/segment.ts' },
      headers: {},
    })
    // The receiver's view of this machine is its LAN address; loopback reaches the same port.
    const local = base.replace(/\/\/[^:/]+:/, '//127.0.0.1:')

    expect((await fetch(`${local}p0.m3u8`)).status).toBe(200)
    expect((await fetch(`${local}s0`)).status).toBe(200)
    expect((await fetch(`${local}s1`)).status).toBe(403)
    expect((await fetch(`${local}s2`)).status).toBe(502)
    // Not registered: nothing the receiver was given, so not counted.
    expect((await fetch(`${local}s9`)).status).toBe(404)

    expect(proxy.served()).toBe(4)
    expect(proxy.upstreamFailures()).toBe(2)

    // The next stream starts counting from nothing.
    await proxy.start({ playlists: {}, targets: {}, headers: {} })
    expect(proxy.upstreamFailures()).toBe(0)
  })
})

describe('serving a body', () => {
  let source: Server | null = null
  let proxy: CastProxy | null = null

  afterEach(() => {
    proxy?.stop()
    proxy = null
    source?.closeAllConnections()
    source?.close()
    source = null
  })

  const serve = (handler: Parameters<typeof createServer>[1]): Promise<string> =>
    new Promise((resolve) => {
      source = createServer(handler)
      source.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(source!.address() as { port: number }).port}`))
    })

  const through = async (targets: Record<string, string>): Promise<string> => {
    proxy = createCastProxy({ loopback: true })
    return proxy.start({ playlists: {}, targets, headers: {} })
  }

  /*
   * The bug: every body was read whole before the receiver got a byte, under
   * one 20-second timeout. A film asked for with an open range never
   * arrived in time and was answered 502. Here the source sends a megabyte
   * and then holds the rest back until the receiver has the first bytes:
   * buffered, this would wait for ever.
   */
  it('streams a whole film asked for with an open range, before the source has finished', async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const size = 40 * 1024 * 1024
    const origin = await serve((request, response) => {
      expect(request.headers.range).toBe('bytes=0-')
      response.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': size, 'Content-Range': `bytes 0-${size - 1}/${size}` })
      response.write(Buffer.alloc(1024 * 1024, 1))
      void held.then(() => {
        for (let sent = 1024 * 1024; sent < size; sent += 1024 * 1024) response.write(Buffer.alloc(1024 * 1024, 2))
        response.end()
      })
    })
    const base = await through({ s0: `${origin}/film.mp4` })

    const answer = await fetch(`${base}s0`, { headers: { Range: 'bytes=0-' } })
    expect(answer.status).toBe(206)
    expect(answer.headers.get('content-length')).toBe(String(size))
    expect(answer.headers.get('content-range')).toBe(`bytes 0-${size - 1}/${size}`)
    const reader = answer.body!.getReader()
    const first = await reader.read()
    expect(first.value?.[0]).toBe(1)
    release()
    let total = first.value!.byteLength
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
    }
    expect(total).toBe(size)
    expect(proxy!.upstreamFailures()).toBe(0)
  })

  it('strips an image disguise off a whole segment, and names it a transport stream', async () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]
    const ts = Buffer.alloc(188 * 20)
    for (let i = 0; i < 20; i++) ts[i * 188] = 0x47
    const disguised = Buffer.concat([Buffer.from(png), ts])
    const origin = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': disguised.length })
      response.end(disguised)
    })
    const base = await through({ s0: `${origin}/seg0.png` })

    const answer = await fetch(`${base}s0`)
    expect(answer.headers.get('content-type')).toBe('video/mp2t')
    expect(answer.headers.get('content-length')).toBe(String(ts.length))
    expect(Buffer.from(await answer.arrayBuffer()).equals(ts)).toBe(true)
  })

  it('leaves a range of a disguised segment as the source sent it: its offsets count the disguise', async () => {
    const disguised = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(188 * 4, 0x47)])
    const origin = await serve((_request, response) => {
      response.writeHead(206, { 'Content-Type': 'image/png', 'Content-Range': `bytes 0-99/${disguised.length}`, 'Content-Length': 100 })
      response.end(disguised.subarray(0, 100))
    })
    const base = await through({ s0: `${origin}/seg0.png` })
    const answer = await fetch(`${base}s0`, { headers: { Range: 'bytes=0-99' } })
    expect(answer.headers.get('content-type')).toBe('image/png')
    expect((await answer.arrayBuffer()).byteLength).toBe(100)
  })

  it('gives a segment sent without a length one, as the phone does', async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'video/mp2t' })
      response.write(Buffer.alloc(300_000, 0x47))
      response.end(Buffer.alloc(200_000, 0x47))
    })
    const base = await through({ s0: `${origin}/seg0.ts` })
    const answer = await fetch(`${base}s0`)
    expect(answer.headers.get('content-length')).toBe('500000')
    expect((await answer.arrayBuffer()).byteLength).toBe(500_000)
  })

  it('does not count a receiver hanging up as the source failing', async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 50_000_000 })
      response.write(Buffer.alloc(1024 * 1024))
      // And then nothing: the receiver gives up first.
    })
    const base = await through({ s0: `${origin}/film.mp4` })
    const controller = new AbortController()
    const answer = await fetch(`${base}s0`, { signal: controller.signal })
    await answer.body!.getReader().read()
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(proxy!.served()).toBe(1)
    expect(proxy!.upstreamFailures()).toBe(0)
  })

  it('counts a source that refuses, as soon as it answers', async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(403, { 'Content-Type': 'text/plain' })
      response.end('forbidden')
    })
    const base = await through({ s0: `${origin}/seg0.ts` })
    expect((await fetch(`${base}s0`)).status).toBe(403)
    expect(proxy!.upstreamFailures()).toBe(1)
  })

  it('listens on loopback only when asked for the cast check', async () => {
    proxy = createCastProxy({ loopback: true })
    expect(await proxy.start({ playlists: {}, targets: {}, headers: {} })).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
  })
})
