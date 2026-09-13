import { describe, it, expect } from 'vitest'
import { idFromPath, mediaContentType, pickLanAddress, replayableHeaders } from './castproxy'

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
    expect(pickLanAddress(['100.69.226.123', '192.168.178.157'])).toBe('192.168.178.157')
    expect(pickLanAddress(['192.168.178.157', '100.69.226.123'])).toBe('192.168.178.157')
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
