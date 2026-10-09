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
