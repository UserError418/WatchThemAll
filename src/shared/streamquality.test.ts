/**
 * Reading a stream's best quality off its manifest.
 *
 * Every case here is a way to print a *wrong* quality, which is worse than
 * printing none: a label that says 1080p sends the user to that source over a
 * sharper one. Unknown is always allowed; wrong never is.
 */

import { describe, expect, it } from 'vitest'
import { bestQuality, judgeQuality, qualityClass, readLadder } from './streamquality'

const MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio/en.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud"',
  '360/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"',
  '720/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"',
  '1080/index.m3u8',
  '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,RESOLUTION=3840x2160,URI="iframes.m3u8"',
].join('\n')

describe('qualityClass', () => {
  it.each([
    [1920, 1080, 1080],
    [1280, 720, 720],
    [3840, 2160, 2160],
    [854, 480, 480],
    [640, 360, 360],
  ])('%ix%i is %ip', (width, height, expected) => {
    expect(qualityClass({ width, height })).toBe(expected)
  })

  it.each([
    // Fight Club, as VidSrc and VidZee serve it: 2.40:1, and a 1080p release.
    [1920, 800, 1080],
    [1920, 1036, 1080],
    // VidFlix's Fight Club: the 720p release of the same film.
    [1280, 528, 720],
    [1280, 536, 720],
    [3840, 1600, 2160],
  ])('reads a letterboxed %ix%i as %ip, not by its height', (width, height, expected) => {
    expect(qualityClass({ width, height })).toBe(expected)
  })

  it('classes by height when that is all a manifest gave', () => {
    expect(qualityClass({ width: null, height: 1080 })).toBe(1080)
    expect(qualityClass({ width: null, height: 720 })).toBe(720)
  })
})

describe('readLadder', () => {
  it('lists an HLS master rendition by rendition, best first', () => {
    const ladder = readLadder(MASTER)
    expect(ladder.kind).toBe('hls-master')
    expect(ladder.renditions).toEqual([
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
      { width: 640, height: 360 },
    ])
    expect(bestQuality(ladder)).toBe(1080)
  })

  it('does not read a quality off the scrubbing thumbnails', () => {
    // The I-frame playlist above claims 2160p; it is the preview strip.
    expect(bestQuality(readLadder(MASTER))).not.toBe(2160)
  })

  it('finds RESOLUTION wherever it sits among the attributes', () => {
    const body = '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720,BANDWIDTH=1\na.m3u8\n'
    expect(bestQuality(readLadder(body))).toBe(720)
  })

  it('lists a size once, however many bitrates and audio groups repeat it', () => {
    const body = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="a"',
      'a.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,AUDIO="b"',
      'b.m3u8',
    ].join('\n')
    expect(readLadder(body).renditions).toEqual([{ width: 1920, height: 1080 }])
  })

  it('reports a master that names no resolution as naming none', () => {
    const body = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000000\nb.m3u8\n'
    const ladder = readLadder(body)
    expect(ladder.kind).toBe('hls-master')
    expect(bestQuality(ladder)).toBeNull()
  })

  it('reports a media playlist as one rendition of unknown size', () => {
    const body = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg-0.ts\n#EXT-X-ENDLIST\n'
    const ladder = readLadder(body)
    expect(ladder.kind).toBe('hls-media')
    expect(bestQuality(ladder)).toBeNull()
  })

  it('reads the video representations of a DASH manifest and ignores the audio', () => {
    const body = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v1" bandwidth="1500000" width="1280" height="720" codecs="avc1.4d401f"/>
      <Representation id="v2" bandwidth="4500000" width="1920" height="1080" codecs="avc1.640028"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <Representation id="a1" bandwidth="128000" audioSamplingRate="48000"/>
    </AdaptationSet>
  </Period>
</MPD>`
    const ladder = readLadder(body)
    expect(ladder.kind).toBe('dash')
    expect(ladder.renditions).toEqual([
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
    ])
  })

  it("falls back to a DASH adaptation set's maximum when representations give no size", () => {
    const body =
      '<MPD><Period><AdaptationSet mimeType="video/mp4" maxWidth="3840" maxHeight="2160">' +
      '<Representation id="1" bandwidth="1"/></AdaptationSet></Period></MPD>'
    expect(bestQuality(readLadder(body))).toBe(2160)
  })

  it('does not mistake an API answer or a page for a manifest', () => {
    expect(readLadder('{"sources":[{"file":"x.m3u8","label":"1080p"}]}').kind).toBe('unknown')
    expect(readLadder('<!doctype html><html>').kind).toBe('unknown')
  })

  it('tolerates leading whitespace and Windows line endings', () => {
    const body = '\n  #EXTM3U\r\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\r\na.m3u8\r\n'
    expect(bestQuality(readLadder(body))).toBe(720)
  })
})

describe('judgeQuality', () => {
  const ladderOf = (body: string) => readLadder(body)
  const video = (width: number, height: number, runtime: 'plausible' | 'implausible' | 'unknown' = 'plausible') => ({
    rendition: { width, height },
    runtime,
  })

  it('takes the best from the ladder, not from what happens to be playing', () => {
    // An adaptive player in a 1280x720 window decodes 720p from a 1080p ladder.
    const judged = judgeQuality({
      streamed: true,
      playlists: [{ status: 200, ladder: ladderOf(MASTER) }],
      wholeFiles: 0,
      video: video(1280, 720),
    })
    expect(judged).toMatchObject({ outcome: 'ladder', best: 1080, playing: 720, contradiction: false })
  })

  it('takes the best across every master the page fetched', () => {
    const small = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\na.m3u8\n'
    const judged = judgeQuality({
      streamed: true,
      playlists: [
        { status: 200, ladder: ladderOf(small) },
        { status: 200, ladder: ladderOf(MASTER) },
      ],
      wholeFiles: 0,
      video: null,
    })
    expect(judged.best).toBe(1080)
  })

  it('flags a picture better than the ladder claims', () => {
    const small = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\na.m3u8\n'
    const judged = judgeQuality({
      streamed: true,
      playlists: [{ status: 200, ladder: ladderOf(small) }],
      wholeFiles: 0,
      video: video(1920, 1080),
    })
    expect(judged.contradiction).toBe(true)
  })

  it('reads a single whole file off the picture, which is its only rendition', () => {
    const judged = judgeQuality({ streamed: true, playlists: [], wholeFiles: 1, video: video(1920, 800) })
    expect(judged).toMatchObject({ outcome: 'single-file', best: 1080 })
  })

  it('ignores the size of a video whose length does not fit the title', () => {
    // A pre-roll ad, or VidRock's demo-video.mp4 placeholder.
    const judged = judgeQuality({
      streamed: true,
      playlists: [],
      wholeFiles: 1,
      video: video(1920, 1080, 'implausible'),
    })
    expect(judged).toMatchObject({ outcome: 'single-file', best: null, playing: null, decoy: true })
  })

  it('reads HLS with no master at all off its picture, since it has one rendition', () => {
    // 111Movies: one media playlist per title, never a master.
    const media = '#EXTM3U\n#EXTINF:6.0,\nseg.ts\n'
    const judged = judgeQuality({
      streamed: true,
      playlists: [{ status: 200, ladder: ladderOf(media) }],
      wholeFiles: 0,
      video: video(1920, 800),
    })
    expect(judged).toMatchObject({ outcome: 'single-rendition', best: 1080 })
  })

  it('does not read a master without sizes off its picture: there are other renditions', () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=9\nb.m3u8\n'
    const judged = judgeQuality({
      streamed: true,
      playlists: [{ status: 200, ladder: ladderOf(master) }],
      wholeFiles: 0,
      video: video(1280, 720),
    })
    expect(judged).toMatchObject({ outcome: 'unlabelled', best: null, playing: 720 })
  })

  it('leaves HLS without a master unknown when the picture is not the title', () => {
    const media = '#EXTM3U\n#EXTINF:6.0,\nseg.ts\n'
    const judged = judgeQuality({
      streamed: true,
      playlists: [{ status: 200, ladder: ladderOf(media) }],
      wholeFiles: 0,
      video: video(360, 640, 'implausible'),
    })
    expect(judged).toMatchObject({ outcome: 'unlabelled', best: null, decoy: true })
  })

  it("takes the player's own list over the picture, and the ladder over both", () => {
    const media = '#EXTM3U\n#EXTINF:6.0,\nseg.ts\n'
    const fromPlayer = judgeQuality({
      streamed: true,
      playlists: [{ status: 200, ladder: ladderOf(media) }],
      wholeFiles: 0,
      video: video(1280, 720),
      player: 1080,
    })
    expect(fromPlayer).toMatchObject({ outcome: 'player', best: 1080 })

    const fromLadder = judgeQuality({
      streamed: true,
      playlists: [{ status: 200, ladder: ladderOf(MASTER) }],
      wholeFiles: 0,
      video: null,
      player: 2160,
    })
    expect(fromLadder).toMatchObject({ outcome: 'ladder', best: 1080 })
  })

  it('calls playlists that would not answer again sealed', () => {
    const judged = judgeQuality({
      streamed: true,
      playlists: [{ status: 403, ladder: { kind: 'unknown', renditions: [] } }],
      wholeFiles: 0,
      video: null,
    })
    expect(judged.outcome).toBe('sealed')
  })

  it('does not judge a source that did not stream', () => {
    const judged = judgeQuality({ streamed: false, playlists: [], wholeFiles: 0, video: null })
    expect(judged).toMatchObject({ outcome: 'no-stream', best: null })
  })
})
