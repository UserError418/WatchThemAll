/**
 * Reading what a television would have to decode, from the three places a
 * stream says it: the master's `CODECS`, an fMP4 init segment (or a whole
 * MP4's head), and a TS segment's PMT and SPS.
 *
 * The fixtures are ffmpeg's (`streamsignature.fixture.ts`, and the older
 * `initsegment.fixture.ts` and `transportstream.fixture.ts`). Every case is a
 * way to name a stream wrongly, which the cast list would then hold against
 * a television: a wrong "HEVC" hides a source that plays, a wrong "H.264"
 * offers one that does not. Unknown is always allowed; wrong never is.
 */

import { describe, expect, it } from 'vitest'
import { readInitSegmentCodecs, readMovieDuration } from './initsegment'
import { H264_1920X800, HEVC_1280X720, AUDIO_ONLY } from './initsegment.fixture'
import {
  INIT_H264_HIGH_1080_AC3,
  INIT_HEVC_MAIN10_3840X1600_EAC3,
  TS_H264_HIGH_1080P60_MP3,
  TS_H264_HIGH_2160X1080,
  TS_H264_MAIN_720_AC3,
  TS_H264_MAIN_720_EAC3_DVB,
  TS_HEVC_MAIN_1920X800,
  WHOLE_MP4_HEAD,
} from './streamsignature.fixture'
import { codecsAttribute, describeVideo, isStreamSignature, signatureClass, streamSignature, type StreamSignature } from './streamsignature'
import { disguisedStreamOffset, readTransportStreamCodecs } from './transportstream'
import { TS_AUDIO_ONLY, TS_H264_720_BASELINE, TS_H264_1080 } from './transportstream.fixture'

describe('readTransportStreamCodecs', () => {
  it("reads Videasy's refused shape: H.264 High 5.0 at 2160x1080, 24 fps, with AAC", () => {
    expect(readTransportStreamCodecs(TS_H264_HIGH_2160X1080)).toEqual({
      video: { codec: 'h264', profile: 'high', level: 5, width: 2160, height: 1080, fps: 24 },
      audio: ['aac'],
      sampleAes: false,
    })
  })

  it('reads the frame rate from the VUI, which x264 times in fields', () => {
    expect(readTransportStreamCodecs(TS_H264_HIGH_1080P60_MP3)?.video).toMatchObject({ level: 4.2, fps: 60 })
  })

  it('names MPEG audio as MP3', () => {
    expect(readTransportStreamCodecs(TS_H264_HIGH_1080P60_MP3)?.audio).toEqual(['mp3'])
  })

  it('names AC-3 as ATSC lists it (stream type 0x81)', () => {
    expect(readTransportStreamCodecs(TS_H264_MAIN_720_AC3)).toMatchObject({
      video: { codec: 'h264', profile: 'main', level: 3.1, width: 1280, height: 720, fps: 30 },
      audio: ['ac3'],
    })
  })

  it('names E-AC-3 as DVB lists it: private data, told apart by its descriptor', () => {
    expect(readTransportStreamCodecs(TS_H264_MAIN_720_EAC3_DVB)?.audio).toEqual(['eac3'])
  })

  it('reads HEVC as far as its size, where the size reader stops at the codec', () => {
    expect(readTransportStreamCodecs(TS_HEVC_MAIN_1920X800)).toMatchObject({
      video: { codec: 'hevc', profile: 'main', level: 4, width: 1920, height: 800, fps: null },
      audio: ['aac'],
    })
  })

  it('reads Constrained Baseline as such, not as Baseline', () => {
    expect(readTransportStreamCodecs(TS_H264_720_BASELINE)?.video?.profile).toBe('constrained-baseline')
  })

  it('knows an audio-only stream has no video', () => {
    expect(readTransportStreamCodecs(TS_AUDIO_ONLY)).toEqual({ video: null, audio: ['aac'], sampleAes: false })
  })

  it('still names the codec from the PMT when the segment ends before the SPS', () => {
    // The tables (SDT, PAT, PMT), then a null packet where the video would start.
    const nullPacket = new Uint8Array(188).fill(0xff)
    nullPacket.set([0x47, 0x1f, 0xff, 0x10])
    const tablesOnly = new Uint8Array(4 * 188)
    tablesOnly.set(TS_H264_1080.subarray(0, 3 * 188))
    tablesOnly.set(nullPacket, 3 * 188)
    expect(readTransportStreamCodecs(tablesOnly)?.video).toEqual({
      codec: 'h264',
      profile: null,
      level: null,
      width: null,
      height: null,
      fps: null,
    })
  })

  it('reads nothing from an answer that is not a transport stream', () => {
    expect(readTransportStreamCodecs(new TextEncoder().encode('<html>403</html>'.repeat(100)))).toBeNull()
  })
})

describe('readInitSegmentCodecs', () => {
  it('reads HEVC Main 10 and E-AC-3 from an fMP4 init segment', () => {
    expect(readInitSegmentCodecs(INIT_HEVC_MAIN10_3840X1600_EAC3)).toEqual({
      video: { codec: 'hevc', profile: 'main10', level: 5, width: 3840, height: 1600, fps: null },
      audio: ['eac3'],
      encrypted: false,
    })
  })

  it('reads H.264 High, its frame rate from the SPS in avcC, and AC-3', () => {
    expect(readInitSegmentCodecs(INIT_H264_HIGH_1080_AC3)).toEqual({
      video: { codec: 'h264', profile: 'high', level: 4, width: 1920, height: 1080, fps: 25 },
      audio: ['ac3'],
      encrypted: false,
    })
  })

  it('reads the profile x264 chose for an RGB source: High 4:4:4', () => {
    // The older fixtures were encoded from testsrc's RGB without -pix_fmt.
    expect(readInitSegmentCodecs(H264_1920X800)?.video).toMatchObject({ codec: 'h264', profile: 'high444', width: 1920, height: 800 })
    expect(readInitSegmentCodecs(HEVC_1280X720)?.video).toMatchObject({ codec: 'hevc', profile: 'rext' })
  })

  it('finds no video in an audio rendition', () => {
    expect(readInitSegmentCodecs(AUDIO_ONLY)).toEqual({ video: null, audio: ['aac'], encrypted: false })
  })

  it("reads a whole MP4's head, and as far as it goes when the moov is cut short", () => {
    expect(readInitSegmentCodecs(WHOLE_MP4_HEAD)).toEqual({
      video: { codec: 'h264', profile: 'high', level: 3.1, width: 1280, height: 536, fps: 24 },
      audio: ['aac'],
      encrypted: false,
    })
    // A sniff that stops inside the moov still reaches the first track.
    expect(readInitSegmentCodecs(WHOLE_MP4_HEAD.subarray(0, 1200))?.video?.codec).toBe('h264')
  })

  it('finds nothing in a file without a moov at its head', () => {
    expect(readInitSegmentCodecs(new TextEncoder().encode('<html>not a film</html>'))).toBeNull()
  })
})

describe('readMovieDuration', () => {
  it("reads a whole file's length from its mvhd, even with the rest of the moov cut off", () => {
    expect(readMovieDuration(WHOLE_MP4_HEAD)).toBeCloseTo(2, 1)
    expect(readMovieDuration(WHOLE_MP4_HEAD.subarray(0, 200))).toBeCloseTo(2, 1)
  })

  it('says nothing for bytes with no moov at their head', () => {
    expect(readMovieDuration(new Uint8Array(64))).toBeNull()
  })
})

describe('codecsAttribute', () => {
  it.each([
    ['avc1.640028,mp4a.40.2', { codec: 'h264', profile: 'high', level: 4 }, ['aac']],
    ['avc1.42E01E', { codec: 'h264', profile: 'constrained-baseline', level: 3 }, []],
    ['avc1.4d401f,mp4a.40.5', { codec: 'h264', profile: 'main', level: 3.1 }, ['aac']],
    ['avc1.100.40', { codec: 'h264', profile: 'high', level: 4 }, []],
    ['hvc1.2.4.L153.B0,ec-3', { codec: 'hevc', profile: 'main10', level: 5.1 }, ['eac3']],
    ['hev1.1.6.L93.90,mp4a.40.2', { codec: 'hevc', profile: 'main', level: 3.1 }, ['aac']],
    ['vp09.00.40.08,opus', { codec: 'vp9', profile: 'profile0', level: 4 }, ['opus']],
    ['av01.0.08M.08', { codec: 'av1', profile: 'main', level: 4 }, []],
  ])('reads %s', (codecs, video, audio) => {
    const read = codecsAttribute(codecs)
    expect(read.video).toMatchObject(video)
    expect(read.audio).toEqual(audio)
  })

  it('names MP3 under its MPEG-4 and MPEG-1 object types', () => {
    expect(codecsAttribute('mp4a.40.34').audio).toEqual(['mp3'])
    expect(codecsAttribute('mp4a.6B').audio).toEqual(['mp3'])
    expect(codecsAttribute('mp4a.69,ac-3').audio).toEqual(['mp3', 'ac3'])
  })

  it('keeps an unfamiliar video codec as other, never as nothing', () => {
    expect(codecsAttribute('dvh1.05.06').video?.codec).toBe('other')
  })

  it('has no video for an audio-only CODECS', () => {
    expect(codecsAttribute('mp4a.40.2').video).toBeNull()
  })
})

describe('streamSignature', () => {
  it("is the TS segment's reading, packaged as TS", () => {
    expect(streamSignature({ segment: readTransportStreamCodecs(TS_H264_HIGH_2160X1080), keyMethod: null })).toEqual({
      container: 'ts',
      video: { codec: 'h264', profile: 'high', level: 5, width: 2160, height: 1080, fps: 24 },
      audio: ['aac'],
      encryption: 'none',
    })
  })

  it("believes the bytes over the master, and fills the bytes' gaps from it", () => {
    const signature = streamSignature({
      // The master claims 1080p at level 4.0; the segment's SPS says 2160x1080 at 5.0.
      variant: { codecs: 'avc1.640028,mp4a.40.2', width: 1920, height: 1080, frameRate: 23.976 },
      segment: { video: { codec: 'h264', profile: 'high', level: 5, width: 2160, height: 1080, fps: null }, audio: [], sampleAes: false },
    })
    expect(signature.video).toEqual({ codec: 'h264', profile: 'high', level: 5, width: 2160, height: 1080, fps: 23.976 })
    // The audio of a rendition kept apart from the video is only in the master.
    expect(signature.audio).toEqual(['aac'])
  })

  it('takes the master alone when no segment could be read', () => {
    expect(
      streamSignature({ variant: { codecs: 'hvc1.2.4.L153.B0', width: 3840, height: 2160, frameRate: 24 }, initSegment: true }),
    ).toEqual({
      container: 'fmp4',
      video: { codec: 'hevc', profile: 'main10', level: 5.1, width: 3840, height: 2160, fps: 24 },
      audio: [],
      encryption: 'none',
    })
  })

  it('does not let a master that names another codec overrule the bytes', () => {
    const signature = streamSignature({
      variant: { codecs: 'avc1.640028', width: 1920, height: 1080, frameRate: 25 },
      init: readInitSegmentCodecs(INIT_HEVC_MAIN10_3840X1600_EAC3),
    })
    expect(signature.video).toMatchObject({ codec: 'hevc', profile: 'main10', width: 3840, height: 1600, fps: 25 })
  })

  it('reads encryption from the key method, and from the bytes when the playlist did not say', () => {
    expect(streamSignature({ keyMethod: 'AES-128' }).encryption).toBe('aes-128')
    expect(streamSignature({ keyMethod: 'SAMPLE-AES' }).encryption).toBe('sample-aes')
    expect(streamSignature({ keyMethod: 'SAMPLE-AES-CTR' }).encryption).toBe('sample-aes')
    expect(streamSignature({ init: { video: null, audio: [], encrypted: true } }).encryption).toBe('other')
  })

  it("is a whole file's own reading, packaged as MP4", () => {
    expect(streamSignature({ file: readInitSegmentCodecs(WHOLE_MP4_HEAD) }).container).toBe('mp4')
  })

  it('knows nothing from nothing', () => {
    expect(streamSignature({})).toEqual({ container: null, video: null, audio: [], encryption: 'none' })
  })
})

describe('signatureClass', () => {
  const videasy: StreamSignature = {
    container: 'ts',
    video: { codec: 'h264', profile: 'high', level: 5, width: 2160, height: 1080, fps: 24 },
    audio: ['aac'],
    encryption: 'none',
  }

  it('is the same for the same encode, whichever source serves it', () => {
    const other = { ...videasy, video: { ...videasy.video!, fps: 25 } }
    expect(signatureClass(videasy)).toBe('ts/h264/high/5/2160x1080/30fps/aac/none')
    expect(signatureClass(other)).toBe(signatureClass(videasy))
  })

  it('differs for another frame size: a refusal of 2160x1080 says nothing of 1920x1080', () => {
    const smaller = { ...videasy, video: { ...videasy.video!, width: 1920 } }
    expect(signatureClass(smaller)).not.toBe(signatureClass(videasy))
  })

  it('is null when the codec or the size is unknown: two unknowns are not alike', () => {
    expect(signatureClass({ ...videasy, video: null })).toBeNull()
    expect(signatureClass({ ...videasy, video: { ...videasy.video!, width: null } })).toBeNull()
    expect(signatureClass({ ...videasy, video: { ...videasy.video!, codec: 'other' } })).toBeNull()
  })
})

describe('describeVideo and isStreamSignature', () => {
  it('words the video as the cast list says it', () => {
    expect(describeVideo({ codec: 'h264', profile: 'high', level: 5, width: 2160, height: 1080, fps: 24 })).toBe('H.264 2160×1080')
  })

  it('takes a signature back from storage, and turns away one malformed', () => {
    const signature = streamSignature({ segment: readTransportStreamCodecs(TS_H264_HIGH_2160X1080) })
    expect(isStreamSignature(JSON.parse(JSON.stringify(signature)))).toBe(true)
    expect(isStreamSignature({ ...signature, audio: 'aac' })).toBe(false)
    expect(isStreamSignature({ ...signature, video: { codec: 'h264', width: '2160' } })).toBe(false)
    expect(isStreamSignature(null)).toBe(false)
  })
})

describe('disguisedStreamOffset', () => {
  const ts = new Uint8Array(4 * 188)
  for (let i = 0; i < 4; i++) ts[i * 188] = 0x47
  const behind = (prefix: number[]): Uint8Array => {
    const out = new Uint8Array(prefix.length + ts.length)
    out.set(prefix)
    out.set(ts, prefix.length)
    return out
  }

  it('finds a transport stream behind a PNG or JPEG signature', () => {
    expect(disguisedStreamOffset(behind([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(8)
    expect(disguisedStreamOffset(behind([0xff, 0xd8, 0xff, 0xe0, 0, 16]))).toBe(6)
  })

  it('leaves alone a plain segment, and bytes that only happen to hold sync bytes', () => {
    expect(disguisedStreamOffset(ts)).toBe(0)
    // fMP4: a box, not a picture, whatever 0x47s it carries.
    expect(disguisedStreamOffset(behind([0, 0, 0, 24, 0x73, 0x74, 0x79, 0x70]))).toBe(0)
  })
})
