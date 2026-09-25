/**
 * Reading a picture size out of the first segment of an MPEG-TS rendition.
 *
 * The fixtures are real ffmpeg output (see `transportstream.fixture.ts`),
 * chosen for the SPS fields that change the arithmetic: cropping, the
 * High-profile fields and their scaling matrices, interlacing, 4:4:4 chroma.
 * Each is a way to print a size that is close but wrong — 1088 for 1080, 540
 * for an interlaced 1080 — and a close wrong size can still land in the wrong
 * class. Anything unreadable must be null.
 */

import { describe, expect, it } from 'vitest'
import { readSpsSize, readTransportStreamSize } from './transportstream'
import {
  SPS_WITH_SCALING_LISTS,
  TS_AUDIO_ONLY,
  TS_H264_1080,
  TS_H264_1080I,
  TS_H264_1920X800,
  TS_H264_444_1280X536,
  TS_H264_720_BASELINE,
  TS_HEVC_720,
} from './transportstream.fixture'

describe('readTransportStreamSize', () => {
  it('reads the cropped size, not the coded macroblocks', () => {
    // 1080 is not a multiple of 16: it is coded as 1088 and cropped by 8.
    expect(readTransportStreamSize(TS_H264_1080)).toEqual({ width: 1920, height: 1080 })
  })

  it('reads a Baseline SPS, which has no High-profile fields', () => {
    expect(readTransportStreamSize(TS_H264_720_BASELINE)).toEqual({ width: 1280, height: 720 })
  })

  it("reads a letterboxed film's size as it is coded", () => {
    expect(readTransportStreamSize(TS_H264_1920X800)).toEqual({ width: 1920, height: 800 })
  })

  it('steps over scaling lists to reach the size', () => {
    // The lists sit between the profile fields and the size; misjudging one's
    // length by a single code shifts every field after it.
    expect(readSpsSize(SPS_WITH_SCALING_LISTS)).toEqual({ width: 1920, height: 800 })
  })

  it('counts an interlaced picture in field pairs', () => {
    expect(readTransportStreamSize(TS_H264_1080I)).toEqual({ width: 1920, height: 1080 })
  })

  it('crops 4:4:4 in luma samples', () => {
    // 536 = 34 macroblocks (544) less 8 rows; in 4:2:0 units that would be 16.
    expect(readTransportStreamSize(TS_H264_444_1280X536)).toEqual({ width: 1280, height: 536 })
  })

  it('knows nothing from an audio-only stream', () => {
    expect(readTransportStreamSize(TS_AUDIO_ONLY)).toBeNull()
  })

  it('leaves HEVC unknown rather than reading it as H.264', () => {
    expect(readTransportStreamSize(TS_HEVC_720)).toBeNull()
  })

  it('finds the stream behind a disguise', () => {
    // Some providers serve segments behind a fake image header, which the
    // player skips; the packets start wherever the sync bytes begin.
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
    const disguised = new Uint8Array(png.length + TS_H264_1080.length)
    disguised.set(png)
    disguised.set(TS_H264_1080, png.length)
    expect(readTransportStreamSize(disguised)).toEqual({ width: 1920, height: 1080 })
  })

  it('reads nothing from a segment cut off before its SPS', () => {
    for (const packets of [0, 1, 2, 3]) {
      expect(readTransportStreamSize(TS_H264_1080.subarray(0, packets * 188))).toBeNull()
    }
  })

  it('reads nothing from an answer that is not a transport stream', () => {
    expect(readTransportStreamSize(new TextEncoder().encode('<html>403 Forbidden</html>'.repeat(40)))).toBeNull()
  })
})
