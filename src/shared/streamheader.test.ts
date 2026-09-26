/**
 * Choosing which bytes of a single rendition to ask for.
 *
 * A wrong choice here is quiet: a header URL resolved against the wrong base
 * answers 404, and the source reads as unknown when it could have been read.
 */

import { describe, expect, it } from 'vitest'
import { HEADER_BYTES, readStreamHeader, streamHeaderOf } from './streamheader'
import { readMediaPlaylist } from './streamquality'
import { H264_1920X800 } from './initsegment.fixture'
import { TS_H264_1080 } from './transportstream.fixture'

const PLAYLIST_URL = 'https://cdn.example/vd/abc/index-s1080p.m3u8?token=1'

describe('streamHeaderOf', () => {
  it('asks for an fMP4 init segment, beside the playlist', () => {
    const media = readMediaPlaylist('#EXTM3U\n#EXT-X-MAP:URI="init-s1080p.mp4"\n#EXTINF:6,\nseg-1.m4s\n')
    expect(streamHeaderOf(media, PLAYLIST_URL)).toEqual({
      source: 'init',
      url: 'https://cdn.example/vd/abc/init-s1080p.mp4',
      range: { offset: 0, length: HEADER_BYTES },
    })
  })

  it("asks for only the init segment's range when it is packed into a larger file", () => {
    const media = readMediaPlaylist('#EXTM3U\n#EXT-X-MAP:URI="main.mp4",BYTERANGE="812@0"\n#EXTINF:6,\nmain.mp4\n')
    expect(streamHeaderOf(media, PLAYLIST_URL)?.range).toEqual({ offset: 0, length: 812 })
  })

  it('asks for the opening of the first segment when there is no init segment', () => {
    // Videasy's TS shape: a root-relative path on the playlist's host.
    const media = readMediaPlaylist('#EXTM3U\n#EXTINF:7.8,\n/r6/s/first\n#EXTINF:6,\n/r6/s/second\n')
    expect(streamHeaderOf(media, PLAYLIST_URL)).toEqual({
      source: 'segment',
      url: 'https://cdn.example/r6/s/first',
      range: { offset: 0, length: HEADER_BYTES },
    })
  })

  it('keeps an absolute segment URL on its own host', () => {
    const media = readMediaPlaylist('#EXTM3U\n#EXTINF:6,\nhttps://other.example/seg.ts\n')
    expect(streamHeaderOf(media, PLAYLIST_URL)?.url).toBe('https://other.example/seg.ts')
  })

  it('has nothing to ask for when the playlist lists nothing', () => {
    expect(streamHeaderOf(readMediaPlaylist('#EXTM3U\n#EXT-X-ENDLIST\n'), PLAYLIST_URL)).toBeNull()
  })
})

describe('readStreamHeader', () => {
  it('reads each kind of header with its own parser', () => {
    expect(readStreamHeader('init', H264_1920X800)).toEqual({ width: 1920, height: 800 })
    expect(readStreamHeader('segment', TS_H264_1080)).toEqual({ width: 1920, height: 1080 })
  })

  it('does not read one kind as the other', () => {
    expect(readStreamHeader('segment', H264_1920X800)).toBeNull()
    expect(readStreamHeader('init', TS_H264_1080)).toBeNull()
  })
})
