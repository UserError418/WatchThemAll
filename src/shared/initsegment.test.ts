/**
 * Reading a picture size out of an fMP4 init segment.
 *
 * The fixtures are real ffmpeg output (see `initsegment.fixture.ts`). As with
 * the manifests, the failures that matter are the ones that print a *wrong*
 * size — the audio track's zeros, a truncated box read as a number — so every
 * case that cannot be read must come back null, not a guess.
 */

import { describe, expect, it } from 'vitest'
import { readInitSegmentSize } from './initsegment'
import { AUDIO_FIRST_854X480, AUDIO_ONLY, H264_1920X800, HEVC_1280X720 } from './initsegment.fixture'

/** Where a four-character box type first appears in the bytes. */
function indexOfType(bytes: Uint8Array, type: string): number {
  const needle = [...type].map((c) => c.charCodeAt(0))
  return bytes.findIndex((_, i) => needle.every((code, j) => bytes[i + j] === code))
}

describe('readInitSegmentSize', () => {
  it('reads the coded size of an H.264 track', () => {
    expect(readInitSegmentSize(H264_1920X800)).toEqual({ width: 1920, height: 800 })
  })

  it('reads an HEVC track', () => {
    expect(readInitSegmentSize(HEVC_1280X720)).toEqual({ width: 1280, height: 720 })
  })

  it('finds the video track when the audio track comes first', () => {
    // The audio sample entry has no width or height; reading the first track
    // blindly would take its bytes for a size.
    expect(readInitSegmentSize(AUDIO_FIRST_854X480)).toEqual({ width: 854, height: 480 })
  })

  it('knows nothing from an audio rendition', () => {
    expect(readInitSegmentSize(AUDIO_ONLY)).toBeNull()
  })

  it('falls back to the track header when the sample entry gives no size', () => {
    const copy = H264_1920X800.slice()
    // The avc1 entry's width and height: 24 bytes into its payload, which
    // starts 4 bytes after its type.
    copy.fill(0, indexOfType(copy, 'avc1') + 28, indexOfType(copy, 'avc1') + 32)
    expect(readInitSegmentSize(copy)).toEqual({ width: 1920, height: 800 })
  })

  it('gives up when neither box states a size', () => {
    const copy = H264_1920X800.slice()
    copy.fill(0, indexOfType(copy, 'avc1') + 28, indexOfType(copy, 'avc1') + 32)
    const tkhdEnd = indexOfType(copy, 'tkhd') - 4 + new DataView(copy.buffer).getUint32(indexOfType(copy, 'tkhd') - 4)
    copy.fill(0, tkhdEnd - 8, tkhdEnd)
    expect(readInitSegmentSize(copy)).toBeNull()
  })

  it('reads nothing from a download cut short', () => {
    // A capped read that stopped inside `moov` must not read past the end or
    // take whatever it reached for the answer.
    for (const length of [0, 7, 40, 300, 600]) {
      expect(readInitSegmentSize(H264_1920X800.subarray(0, length))).toBeNull()
    }
  })

  it('reads nothing from an answer that is not an init segment', () => {
    // What a host sends instead when the token has expired.
    const page = new TextEncoder().encode('<!doctype html><html><body>403 Forbidden</body></html>')
    expect(readInitSegmentSize(page)).toBeNull()
  })

  it('reads a segment that sits at an offset inside a larger buffer', () => {
    // A Node Buffer is usually a view into a shared pool, so offset zero of the
    // view is not offset zero of its ArrayBuffer.
    const pooled = new Uint8Array(H264_1920X800.byteLength + 16)
    pooled.set(H264_1920X800, 16)
    expect(readInitSegmentSize(pooled.subarray(16))).toEqual({ width: 1920, height: 800 })
  })
})
