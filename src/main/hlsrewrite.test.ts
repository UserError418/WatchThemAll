import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  buildCastBundle,
  isFragmentInitSegment,
  isWholeVideoFile,
  isMasterPlaylist,
  isPlaylist,
  rewritePlaylist,
  type Allocate,
} from './hlsrewrite'

/**
 * A stand-in for the proxy's id allocator that keeps the upstream URL visible,
 * so a test can assert *what* was rewritten and as what kind — the real one
 * returns opaque ids and would make every expectation read `s0`, `s1`.
 */
const label: Allocate = (url, kind) => `<${kind}:${url}>`

const BASE = 'https://cdn.example.com/hls/550/index.m3u8'

describe('rewritePlaylist', () => {
  it('resolves relative segment URIs against the playlist URL', () => {
    const body = ['#EXTM3U', '#EXTINF:6.0,', 'seg0.ts', '#EXTINF:6.0,', 'seg1.ts'].join('\n')

    expect(rewritePlaylist(body, BASE, label)).toBe(
      [
        '#EXTM3U',
        '#EXTINF:6.0,',
        '<data:https://cdn.example.com/hls/550/seg0.ts>',
        '#EXTINF:6.0,',
        '<data:https://cdn.example.com/hls/550/seg1.ts>',
      ].join('\n'),
    )
  })

  it('leaves absolute segment URIs absolute but still proxies them', () => {
    const body = '#EXTM3U\n#EXTINF:6,\nhttps://other.example.net/a/seg0.ts'
    expect(rewritePlaylist(body, BASE, label)).toContain('<data:https://other.example.net/a/seg0.ts>')
  })

  it('preserves the query string, which is where segment tokens live', () => {
    const body = '#EXTM3U\n#EXTINF:6,\nseg0.ts?token=abc&e=1699'
    expect(rewritePlaylist(body, BASE, label)).toContain('seg0.ts?token=abc&e=1699>')
  })

  /**
   * The variant URI is on its own line after the tag that describes it, which
   * makes it the one place the format is stateful — and the one place a
   * line-at-a-time rewriter gets the kind wrong.
   */
  it('treats the line after EXT-X-STREAM-INF as a playlist, not a segment', () => {
    const body = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      '360p/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
      '720p/index.m3u8',
    ].join('\n')

    const out = rewritePlaylist(body, BASE, label)
    expect(out).toContain('<playlist:https://cdn.example.com/hls/550/360p/index.m3u8>')
    expect(out).toContain('<playlist:https://cdn.example.com/hls/550/720p/index.m3u8>')
    expect(out).not.toContain('<data:')
  })

  it('rewrites the key URI and leaves the rest of the tag byte-identical', () => {
    const body = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0123456789ABCDEF\n#EXTINF:6,\nseg0.ts'
    const out = rewritePlaylist(body, BASE, label)

    expect(out).toContain(
      '#EXT-X-KEY:METHOD=AES-128,URI="<data:https://cdn.example.com/hls/550/key.bin>",IV=0x0123456789ABCDEF',
    )
  })

  it('rewrites the fMP4 initialisation segment', () => {
    const body = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg0.m4s'
    expect(rewritePlaylist(body, BASE, label)).toContain('URI="<data:https://cdn.example.com/hls/550/init.mp4>"')
  })

  it('treats an EXT-X-MEDIA rendition as a playlist', () => {
    const body = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",URI="audio/en.m3u8"'
    expect(rewritePlaylist(body, BASE, label)).toContain('URI="<playlist:https://cdn.example.com/hls/550/audio/en.m3u8>"')
  })

  it('leaves a NONE key untouched — it has no URI to rewrite', () => {
    const body = '#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:6,\nseg0.ts'
    expect(rewritePlaylist(body, BASE, label)).toContain('#EXT-X-KEY:METHOD=NONE')
  })

  it('round-trips CRLF line endings', () => {
    const body = '#EXTM3U\r\n#EXTINF:6,\r\nseg0.ts\r\n'
    const out = rewritePlaylist(body, BASE, label)
    expect(out.split('\n').every((line) => line === '' || line.endsWith('\r'))).toBe(true)
  })

  it('leaves comments and unknown tags alone', () => {
    const body = '#EXTM3U\n# a comment\n#EXT-X-VERSION:3\n#EXT-X-SOMETHING-NEW:a=b\n#EXTINF:6,\nseg0.ts'
    const out = rewritePlaylist(body, BASE, label)
    expect(out).toContain('# a comment')
    expect(out).toContain('#EXT-X-VERSION:3')
    expect(out).toContain('#EXT-X-SOMETHING-NEW:a=b')
  })

  /**
   * The invariant the whole feature rests on. Any upstream host left in the
   * body is a request the receiver makes *directly*, with no `Referer` — so it
   * 403s, and it does so several seconds in, long after the manifest loaded
   * cleanly. That failure reads as a broken player, not as a missing header,
   * which is why it is worth a property rather than an example.
   */
  it('leaves no upstream URL anywhere in the output', () => {
    const uri = fc.stringMatching(/^[a-z0-9]{1,8}(\/[a-z0-9]{1,8}){0,3}\.(ts|m4s|m3u8)$/)

    fc.assert(
      fc.property(fc.array(uri, { minLength: 1, maxLength: 30 }), (uris) => {
        const body = ['#EXTM3U', ...uris.flatMap((u) => ['#EXTINF:6,', u])].join('\n')
        const out = rewritePlaylist(body, BASE, (absolute, kind) => `${kind === 'playlist' ? 'p' : 's'}:${absolute.length}`)

        expect(out).not.toContain('https://')
        expect(out).not.toContain('cdn.example.com')
      }),
      { numRuns: 50 },
    )
  })

  it('preserves the line count exactly', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z0-9]{1,6}\.ts$/), { maxLength: 20 }), (uris) => {
        const body = ['#EXTM3U', ...uris.flatMap((u) => ['#EXTINF:6,', u])].join('\n')
        expect(rewritePlaylist(body, BASE, label).split('\n')).toHaveLength(body.split('\n').length)
      }),
      { numRuns: 30 },
    )
  })
})

describe('isPlaylist / isMasterPlaylist', () => {
  it('recognises a playlist by its required first tag', () => {
    expect(isPlaylist('#EXTM3U\n#EXTINF:6,\na.ts')).toBe(true)
    expect(isPlaylist('\n  #EXTM3U\n')).toBe(true)
    expect(isPlaylist('<html>nope</html>')).toBe(false)
  })

  it('separates a master from a media playlist', () => {
    expect(isMasterPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8')).toBe(true)
    expect(isMasterPlaylist('#EXTM3U\n#EXTINF:6,\na.ts')).toBe(false)
  })
})

describe('buildCastBundle', () => {
  /** A two-level tree: master -> two variants -> two segments each. */
  const TREE: Record<string, string> = {
    'https://cdn.example.com/master.m3u8': [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000',
      'v360.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2400000',
      'v720.m3u8',
    ].join('\n'),
    'https://cdn.example.com/v360.m3u8': '#EXTM3U\n#EXTINF:6,\n360/a.ts\n#EXTINF:6,\n360/b.ts',
    'https://cdn.example.com/v720.m3u8': '#EXTM3U\n#EXTINF:6,\n720/a.ts\n#EXTINF:6,\n720/b.ts',
  }

  const fetchTree = async (url: string): Promise<string> => {
    const body = TREE[url]
    if (body === undefined) throw new Error(`unexpected fetch: ${url}`)
    return body
  }

  it('resolves the whole playlist tree, not just the master', async () => {
    const bundle = await buildCastBundle('https://cdn.example.com/master.m3u8', 'hls', fetchTree)

    expect(bundle.playlists).toHaveLength(3)
    expect(bundle.targets.map((t) => t.url).sort()).toEqual([
      'https://cdn.example.com/360/a.ts',
      'https://cdn.example.com/360/b.ts',
      'https://cdn.example.com/720/a.ts',
      'https://cdn.example.com/720/b.ts',
    ])
  })

  it('points the receiver at the master and gives every playlist an .m3u8 name', async () => {
    const bundle = await buildCastBundle('https://cdn.example.com/master.m3u8', 'hls', fetchTree)

    const master = bundle.playlists.find((p) => p.id === bundle.rootId)
    expect(master).toBeDefined()
    // Relative, so the proxy's own address never has to be known here.
    expect(master?.body).toMatch(/^p\d+\.m3u8$/m)
    expect(master?.body).not.toContain('https://')
  })

  it('registers every segment exactly once even when two variants share one', async () => {
    const shared: Record<string, string> = {
      'https://cdn.example.com/master.m3u8': [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=1',
        'v1.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2',
        'v2.m3u8',
      ].join('\n'),
      'https://cdn.example.com/v1.m3u8': '#EXTM3U\n#EXTINF:6,\nshared.ts',
      'https://cdn.example.com/v2.m3u8': '#EXTM3U\n#EXTINF:6,\nshared.ts',
    }

    const bundle = await buildCastBundle('https://cdn.example.com/master.m3u8', 'hls', async (u) => shared[u] ?? '')

    expect(bundle.targets).toHaveLength(1)
    expect(new Set(bundle.targets.map((t) => t.id)).size).toBe(1)
  })

  it('fetches a rendition shared by two variants only once', async () => {
    const fetched: string[] = []
    const withAudio: Record<string, string> = {
      'https://cdn.example.com/master.m3u8': [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="audio.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"',
        'v1.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2,AUDIO="a"',
        'v2.m3u8',
      ].join('\n'),
      'https://cdn.example.com/audio.m3u8': '#EXTM3U\n#EXTINF:6,\nau.ts',
      'https://cdn.example.com/v1.m3u8': '#EXTM3U\n#EXTINF:6,\n1.ts',
      'https://cdn.example.com/v2.m3u8': '#EXTM3U\n#EXTINF:6,\n2.ts',
    }

    await buildCastBundle('https://cdn.example.com/master.m3u8', 'hls', async (u) => {
      fetched.push(u)
      return withAudio[u] ?? ''
    })

    expect(fetched.filter((u) => u.endsWith('audio.m3u8'))).toHaveLength(1)
  })

  it('handles a media playlist served directly, with no master above it', async () => {
    const direct = '#EXTM3U\n#EXTINF:6,\na.ts\n#EXTINF:6,\nb.ts'
    const bundle = await buildCastBundle('https://cdn.example.com/x/index.m3u8', 'hls', async () => direct)

    expect(bundle.playlists).toHaveLength(1)
    expect(bundle.targets).toHaveLength(2)
    expect(bundle.playlists[0]?.id).toBe(bundle.rootId)
  })

  /**
   * Progressive MP4 is a single file the receiver can play as-is. Parsing it
   * would be both meaningless and, at feature length, a way to run the phone
   * out of memory.
   */
  it('passes a progressive stream straight through without parsing it', async () => {
    const bundle = await buildCastBundle('https://cdn.example.com/film.mp4', 'progressive', async () => {
      throw new Error('must not fetch')
    })

    expect(bundle.playlists).toHaveLength(0)
    expect(bundle.targets).toEqual([{ id: bundle.rootId, url: 'https://cdn.example.com/film.mp4' }])
  })

  it('stops following playlists that point at themselves', async () => {
    const loop = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nloop.m3u8'
    let calls = 0

    const bundle = await buildCastBundle('https://cdn.example.com/loop.m3u8', 'hls', async () => {
      calls += 1
      if (calls > 10) throw new Error('followed a loop forever')
      return loop
    })

    // Self-referential: the id is allocated once, so it is queued once.
    expect(calls).toBeLessThanOrEqual(2)
    expect(bundle.playlists.length).toBeLessThanOrEqual(2)
  })
})

describe('isFragmentInitSegment', () => {
  /**
   * The strings below are the shape of what a real provider handed the
   * television: `ftyp`, a `moov` carrying `mvex`, and no `mdat` anywhere. The
   * receiver reported the film's true duration off it and never drew a frame.
   */
  const INIT_SEGMENT = 'ftypisomisomavc1moovmvhdmvextrextrakmdiaminf'
  const REAL_FILE = 'ftypisomisommp42moovmvhdtrakmdiaminfstblmdat video-bytes'

  it('recognises an init segment by mvex without mdat', () => {
    expect(isFragmentInitSegment(INIT_SEGMENT)).toBe(true)
  })

  it('passes a whole file that carries its media', () => {
    expect(isFragmentInitSegment(REAL_FILE)).toBe(false)
  })

  /* A fragment carries mdat, so only the header-only case is rejected. */
  it('passes a media fragment', () => {
    expect(isFragmentInitSegment('stypmoofmfhdtrafmdat bytes')).toBe(false)
  })

  it('is not fooled by a playlist or by an empty body', () => {
    expect(isFragmentInitSegment('#EXTM3U' + String.fromCharCode(10))).toBe(false)
    expect(isFragmentInitSegment('')).toBe(false)
  })
})

describe('isWholeVideoFile', () => {
  it('accepts a self-contained file, wherever its moov sits', () => {
    expect(isWholeVideoFile('ftypisommp42moovmvhdtrakmdat video')).toBe(true)
    // Never prepared for streaming: the index is at the end, past what was
    // sniffed, so the body holds no `moov` at all.
    expect(isWholeVideoFile('ftypisommp42mdat lots and lots of video bytes')).toBe(true)
  })

  it('rejects a media fragment, which would play for six seconds', () => {
    expect(isWholeVideoFile('stypmsdhmoofmfhdtrafmdat bytes')).toBe(false)
  })

  it('rejects an initialisation segment, which would play for none', () => {
    expect(isWholeVideoFile('ftypisomisomavc1moovmvhdmvextrex')).toBe(false)
  })
})
