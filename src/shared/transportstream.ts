/**
 * The size of a picture, read from the first segment of an MPEG-TS rendition.
 *
 * The TS counterpart of `initsegment.ts`. MPEG-TS has no init segment: each
 * segment opens with a keyframe, and the keyframe carries the H.264 sequence
 * parameter set — the SPS, the encoder's statement of the frame size, in
 * macroblocks and cropping offsets. So the first few kilobytes of the first
 * segment answer the same question the fMP4 init segment does.
 *
 * ## The path to the SPS
 *
 *     188-byte packets  →  PAT (PID 0) names the PMT's PID
 *                       →  PMT names the video stream's PID and codec
 *                       →  that PID's payloads, joined, are the H.264 stream
 *                       →  its first NAL unit of type 7 is the SPS
 *
 * The PAT and PMT are read rather than guessed, so an audio stream that
 * happens to contain the bytes of a start code is never parsed as video.
 *
 * H.264 only. HEVC in TS (stream type 0x24) is rare among the providers and
 * its SPS is a different, longer structure; it reads as null, i.e. unknown.
 * Anything malformed or cut short is null too, never a best guess.
 *
 * ## What else the same bytes say: `readTransportStreamCodecs`
 *
 * Whether a television can decode the stream (`streamsignature.ts`) needs
 * more than the size: which codec the PMT lists for the video and for every
 * audio stream, and the SPS's profile, level and frame rate. HEVC is read
 * there too, as far as its size; its frame rate sits past structures this
 * does not walk, and stays unknown.
 */

import { h264Level, h264Profile, hevcLevel, hevcProfile, type AudioCodec, type VideoSignature } from './codecnames'
import type { Rendition } from './streamquality'

const PACKET = 188
const SYNC = 0x47
/** PMT stream type of H.264 video. */
const STREAM_TYPE_H264 = 0x1b
/** H.264 NAL unit type of a sequence parameter set. */
const NAL_SPS = 7

/**
 * Where the packets start.
 *
 * Normally at byte 0. Some providers disguise their segments as images by
 * prepending a picture's header, which the player skips; a sync byte that
 * repeats every 188 bytes, four times over, is where the real stream begins.
 */
function firstPacket(bytes: Uint8Array): number | null {
  for (let at = 0; at + PACKET * 3 < bytes.length; at++) {
    if (
      bytes[at] === SYNC &&
      bytes[at + PACKET] === SYNC &&
      bytes[at + PACKET * 2] === SYNC &&
      bytes[at + PACKET * 3] === SYNC
    ) {
      return at
    }
  }
  return null
}

interface Packet {
  pid: number
  /** The first packet of a PES packet or a table section. */
  unitStart: boolean
  payload: Uint8Array
}

/** Every whole packet from `start`, with its payload past any adaptation field. */
function packets(bytes: Uint8Array, start: number): Packet[] {
  const found: Packet[] = []
  for (let at = start; at + PACKET <= bytes.length; at += PACKET) {
    if (bytes[at] !== SYNC) break
    const pid = ((bytes[at + 1]! & 0x1f) << 8) | bytes[at + 2]!
    const unitStart = (bytes[at + 1]! & 0x40) !== 0
    const control = (bytes[at + 3]! >> 4) & 0x3
    // 1: payload only; 2: adaptation field only; 3: both.
    if (control !== 1 && control !== 3) continue
    const payloadAt = control === 3 ? at + 5 + bytes[at + 4]! : at + 4
    if (payloadAt >= at + PACKET) continue
    found.push({ pid, unitStart, payload: bytes.subarray(payloadAt, at + PACKET) })
  }
  return found
}

/** A PSI table section from a packet that starts one: past its pointer field. */
function section(packet: Packet): Uint8Array | null {
  if (!packet.unitStart || packet.payload.length < 1) return null
  const at = 1 + packet.payload[0]!
  if (at + 3 > packet.payload.length) return null
  const length = ((packet.payload[at + 1]! & 0x0f) << 8) | packet.payload[at + 2]!
  // Sections longer than one packet do not occur for a PAT or a PMT of one
  // program; one that claims to is read as far as it goes.
  return packet.payload.subarray(at, Math.min(at + 3 + length, packet.payload.length))
}

/** The PID of the first program's PMT, from the PAT. */
function pmtPid(all: Packet[]): number | null {
  for (const packet of all) {
    if (packet.pid !== 0) continue
    const table = section(packet)
    // table_id 0; the program loop starts at 8 and leaves 4 bytes of CRC.
    if (!table || table[0] !== 0x00) continue
    for (let at = 8; at + 4 <= table.length - 4; at += 4) {
      const program = (table[at]! << 8) | table[at + 1]!
      if (program !== 0) return ((table[at + 2]! & 0x1f) << 8) | table[at + 3]!
    }
  }
  return null
}

/** The video elementary stream the PMT lists: its PID and its stream type. */
function videoStream(all: Packet[], pmt: number): { pid: number; type: number } | null {
  for (const packet of all) {
    if (packet.pid !== pmt) continue
    const table = section(packet)
    // table_id 2; program_info_length at 10, the stream loop after it.
    if (!table || table[0] !== 0x02 || table.length < 12) continue
    let at = 12 + (((table[10]! & 0x0f) << 8) | table[11]!)
    while (at + 5 <= table.length - 4) {
      const type = table[at]!
      const pid = ((table[at + 1]! & 0x1f) << 8) | table[at + 2]!
      const infoLength = ((table[at + 3]! & 0x0f) << 8) | table[at + 4]!
      // H.264, HEVC, MPEG-2 video: the ones a player would draw.
      if (type === STREAM_TYPE_H264 || type === 0x24 || type === 0x02) return { pid, type }
      at += 5 + infoLength
    }
  }
  return null
}

/** The first SPS NAL unit in an H.264 byte stream, without its start code. */
function firstSps(stream: Uint8Array): Uint8Array | null {
  for (let at = 0; at + 3 < stream.length; at++) {
    if (stream[at] !== 0 || stream[at + 1] !== 0 || stream[at + 2] !== 1) continue
    if ((stream[at + 3]! & 0x1f) !== NAL_SPS) continue
    // The unit runs to the next start code, or the end of what was read.
    let end = at + 4
    while (end + 2 < stream.length && !(stream[end] === 0 && stream[end + 1] === 0 && stream[end + 2]! <= 1)) end++
    return stream.subarray(at + 4, end + 2 < stream.length ? end : stream.length)
  }
  return null
}

/** The SPS's payload with its emulation-prevention bytes (00 00 03) taken out. */
function unescape(nal: Uint8Array): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue
    out.push(nal[i]!)
  }
  return Uint8Array.from(out)
}

/** A bit reader over an SPS, with the Exp-Golomb codes H.264 packs it with. Throws past the end. */
class Bits {
  private at = 0
  constructor(private readonly bytes: Uint8Array) {}

  bit(): number {
    const byte = this.bytes[this.at >> 3]
    if (byte === undefined) throw new RangeError('SPS ended early')
    const bit = (byte >> (7 - (this.at & 7))) & 1
    this.at++
    return bit
  }

  bits(count: number): number {
    let value = 0
    for (let i = 0; i < count; i++) value = value * 2 + this.bit()
    return value
  }

  /** ue(v): unsigned Exp-Golomb. */
  ue(): number {
    let zeros = 0
    while (this.bit() === 0) {
      // 32 leading zeros is not a number any SPS field holds.
      if (++zeros > 31) throw new RangeError('Exp-Golomb code too long')
    }
    return 2 ** zeros - 1 + this.bits(zeros)
  }

  /** se(v): signed Exp-Golomb. */
  se(): number {
    const code = this.ue()
    return code % 2 === 1 ? (code + 1) / 2 : -(code / 2)
  }
}

/** Profiles whose SPS carries the chroma, bit depth and scaling-matrix fields. */
const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135])

/**
 * Step over one scaling list; only its length in bits matters here.
 *
 * Each entry is coded as a change from the one before. A change that lands on
 * zero ends the list — the rest repeat the last value, or the whole list is
 * the default — and nothing further is coded for it.
 */
function skipScalingList(bits: Bits, size: number): void {
  let scale = 8
  for (let j = 0; j < size; j++) {
    scale = (scale + bits.se() + 256) % 256
    if (scale === 0) return
  }
}

/**
 * The displayed frame size an H.264 SPS declares: the coded macroblocks less
 * the cropping — 1920×1088 cropped by 8 rows is the 1080 the viewer sees.
 * Follows the syntax of H.264 section 7.3.2.1.1 up to the cropping fields.
 */
export function readSpsSize(nal: Uint8Array): Rendition | null {
  const facts = readSpsFacts(nal)
  return facts && { width: facts.width, height: facts.height }
}

/** What an H.264 SPS declares: its profile, constraints and level as coded, its frame size, and its frame rate. */
export interface SpsFacts {
  profileIdc: number
  /** The constraint flags byte: `constraint_set1_flag` makes Baseline constrained. */
  constraints: number
  levelIdc: number
  width: number
  height: number
  /** From the VUI's timing, when the encoder wrote it; null otherwise. */
  fps: number | null
}

/**
 * Everything `SpsFacts` holds, read in one walk of the SPS. Null when the
 * size cannot be read; a frame rate that cannot be (a VUI cut short, or
 * none) is null on its own, since the size before it is still good.
 */
export function readSpsFacts(nal: Uint8Array): SpsFacts | null {
  try {
    const bits = new Bits(unescape(nal))
    const profile = bits.bits(8)
    const constraints = bits.bits(8)
    const levelIdc = bits.bits(8)
    bits.ue() // seq_parameter_set_id

    let chroma = 1
    let separatePlanes = 0
    if (HIGH_PROFILES.has(profile)) {
      chroma = bits.ue()
      if (chroma === 3) separatePlanes = bits.bit()
      bits.ue() // bit_depth_luma_minus8
      bits.ue() // bit_depth_chroma_minus8
      bits.bit() // qpprime_y_zero_transform_bypass_flag
      if (bits.bit()) {
        for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
          if (bits.bit()) skipScalingList(bits, i < 6 ? 16 : 64)
        }
      }
    }

    bits.ue() // log2_max_frame_num_minus4
    const pocType = bits.ue()
    if (pocType === 0) {
      bits.ue() // log2_max_pic_order_cnt_lsb_minus4
    } else if (pocType === 1) {
      bits.bit() // delta_pic_order_always_zero_flag
      bits.se() // offset_for_non_ref_pic
      bits.se() // offset_for_top_to_bottom_field
      const cycle = bits.ue()
      for (let i = 0; i < cycle; i++) bits.se()
    }
    bits.ue() // max_num_ref_frames
    bits.bit() // gaps_in_frame_num_value_allowed_flag

    const widthInMbs = bits.ue() + 1
    const heightInMapUnits = bits.ue() + 1
    const frameMbsOnly = bits.bit()
    if (!frameMbsOnly) bits.bit() // mb_adaptive_frame_field_flag
    bits.bit() // direct_8x8_inference_flag

    let crop = { left: 0, right: 0, top: 0, bottom: 0 }
    if (bits.bit()) crop = { left: bits.ue(), right: bits.ue(), top: bits.ue(), bottom: bits.ue() }

    // Cropping is counted in chroma samples, and in field pairs when interlaced.
    const chromaArrayType = separatePlanes ? 0 : chroma
    const subWidth = chromaArrayType === 1 || chromaArrayType === 2 ? 2 : 1
    const subHeight = chromaArrayType === 1 ? 2 : 1
    const cropUnitX = chromaArrayType === 0 ? 1 : subWidth
    const cropUnitY = (chromaArrayType === 0 ? 1 : subHeight) * (2 - frameMbsOnly)

    const width = widthInMbs * 16 - cropUnitX * (crop.left + crop.right)
    const height = (2 - frameMbsOnly) * heightInMapUnits * 16 - cropUnitY * (crop.top + crop.bottom)
    if (!(width > 0 && height > 0 && width <= 8192 && height <= 8192)) return null
    return { profileIdc: profile, constraints, levelIdc, width, height, fps: vuiFrameRate(bits) }
  } catch {
    return null
  }
}

/**
 * The frame rate in an SPS's VUI, read from just past the cropping fields;
 * null when the VUI or its timing is absent, or cut short.
 *
 * H.264 times fields, not frames (E.2.1): a frame lasts two ticks, so the
 * rate is `time_scale / (2 × num_units_in_tick)`. x264 writes 48 / 2 for a
 * 24 fps film.
 */
function vuiFrameRate(bits: Bits): number | null {
  try {
    if (!bits.bit()) return null // vui_parameters_present_flag
    if (bits.bit()) {
      // aspect_ratio_info_present_flag; 255 is "extended": a width and height follow.
      if (bits.bits(8) === 255) bits.bits(32)
    }
    if (bits.bit()) bits.bit() // overscan_info_present_flag, overscan_appropriate_flag
    if (bits.bit()) {
      // video_signal_type_present_flag: format, range, and maybe the colour description.
      bits.bits(4)
      if (bits.bit()) bits.bits(24)
    }
    if (bits.bit()) {
      bits.ue() // chroma_sample_loc_type_top_field
      bits.ue() // chroma_sample_loc_type_bottom_field
    }
    if (!bits.bit()) return null // timing_info_present_flag
    const unitsInTick = bits.bits(32)
    const timeScale = bits.bits(32)
    if (unitsInTick === 0 || timeScale === 0) return null
    const fps = timeScale / (2 * unitsInTick)
    return fps > 0 && fps <= 300 ? Math.round(fps * 1000) / 1000 : null
  } catch {
    return null
  }
}

/**
 * The picture size the first segment of an MPEG-TS rendition declares, or null.
 *
 * Null for audio-only streams, for HEVC and MPEG-2 video, for a segment cut
 * off before its first keyframe's SPS, and for anything that is not TS.
 */
export function readTransportStreamSize(bytes: Uint8Array): Rendition | null {
  const start = firstPacket(bytes)
  if (start === null) return null
  const all = packets(bytes, start)
  const pmt = pmtPid(all)
  const video = pmt === null ? null : videoStream(all, pmt)
  if (!video || video.type !== STREAM_TYPE_H264) return null

  const payloads = all.filter((p) => p.pid === video.pid).map((p) => p.payload)
  const stream = new Uint8Array(payloads.reduce((sum, p) => sum + p.length, 0))
  let at = 0
  for (const payload of payloads) {
    stream.set(payload, at)
    at += payload.length
  }
  const sps = firstSps(stream)
  return sps ? readSpsSize(sps) : null
}

/* ── Disguises ───────────────────────────────────────────────────────────── */

/**
 * Where an MPEG-TS segment starts: its first sync byte. Some sources disguise
 * segments as images, a PNG header in front of the transport stream, which
 * their own players skip and a native player does not. Three sync bytes 188
 * apart within the first few kilobytes are the stream's start; 0 when there
 * is no disguise, or no stream to find.
 *
 * Downloads strip a disguise by this (`transportStreamStart` in
 * `downloads/transfer.ts`, where it was first written), and so do the cast
 * proxies, through `disguisedStreamOffset`.
 */
export function transportStreamOffset(bytes: Uint8Array): number {
  if (bytes[0] === 0x47) return 0
  const limit = Math.min(bytes.length - 377, 4096)
  for (let i = 1; i < limit; i++) {
    if (bytes[i] === 0x47 && bytes[i + 188] === 0x47 && bytes[i + 376] === 0x47) return i
  }
  return 0
}

/**
 * Where a transport stream starts behind an image disguise, or 0 when there
 * is none.
 *
 * Some sources serve their segments as pictures: a PNG's opening bytes in
 * front of the transport stream, on an image CDN that would refuse to host
 * video (2Embed's, measured 2026-09-30). The source's own player skips the
 * prefix; a Cast receiver's does not, and the cast proxies passed the
 * prefix through with `image/png` as the type until 2.0.19.
 *
 * Only behind a PNG or JPEG signature, so the search never runs over a
 * fragmented-MP4 segment or anything else that merely holds three 0x47
 * bytes at the wrong distances. GIF is left alone: its signature starts with
 * the sync byte itself, and none has been seen. `CastProxyServer.java`
 * carries a copy of this rule.
 */
export function disguisedStreamOffset(head: Uint8Array): number {
  const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
  return png || jpeg ? transportStreamOffset(head) : 0
}

/* ── Codecs: what a television would have to decode ───────────────────── */

/** PMT stream types, as ISO/IEC 13818-1 and the ATSC and HLS specifications number them. */
const STREAM_TYPE_MPEG1_VIDEO = 0x01
const STREAM_TYPE_MPEG2_VIDEO = 0x02
const STREAM_TYPE_HEVC = 0x24
/** H.264 under HLS SAMPLE-AES: the slices encrypted, the SPS still in the clear. */
const STREAM_TYPE_H264_SAMPLE_AES = 0xdb
/** Private data: AC-3 or E-AC-3 in DVB's way of carrying them, told apart by a descriptor. */
const STREAM_TYPE_PRIVATE = 0x06

/** Audio stream types and what they carry; the SAMPLE-AES ones are encrypted copies of the first. */
const AUDIO_STREAM_TYPES: ReadonlyMap<number, AudioCodec> = new Map([
  [0x03, 'mp3'],
  [0x04, 'mp3'],
  [0x0f, 'aac'], // ADTS
  [0x11, 'aac'], // LATM
  [0x81, 'ac3'], // ATSC
  [0x87, 'eac3'], // ATSC
  [0xcf, 'aac'], // SAMPLE-AES
  [0xc1, 'ac3'], // SAMPLE-AES
  [0xc2, 'eac3'], // SAMPLE-AES
])
const SAMPLE_AES_STREAM_TYPES = new Set([STREAM_TYPE_H264_SAMPLE_AES, 0xcf, 0xc1, 0xc2])

/** One elementary stream the PMT lists, with its descriptors' tags and bodies. */
interface ElementaryStream {
  pid: number
  type: number
  descriptors: Array<{ tag: number; body: Uint8Array }>
}

/** Every elementary stream the PMT lists, in its order. */
function elementaryStreams(all: Packet[], pmt: number): ElementaryStream[] {
  for (const packet of all) {
    if (packet.pid !== pmt) continue
    const table = section(packet)
    if (!table || table[0] !== 0x02 || table.length < 12) continue
    const streams: ElementaryStream[] = []
    let at = 12 + (((table[10]! & 0x0f) << 8) | table[11]!)
    while (at + 5 <= table.length - 4) {
      const type = table[at]!
      const pid = ((table[at + 1]! & 0x1f) << 8) | table[at + 2]!
      const infoLength = ((table[at + 3]! & 0x0f) << 8) | table[at + 4]!
      const descriptors: ElementaryStream['descriptors'] = []
      const end = Math.min(at + 5 + infoLength, table.length - 4)
      for (let d = at + 5; d + 2 <= end; ) {
        const length = table[d + 1]!
        descriptors.push({ tag: table[d]!, body: table.subarray(d + 2, Math.min(d + 2 + length, end)) })
        d += 2 + length
      }
      streams.push({ pid, type, descriptors })
      at += 5 + infoLength
    }
    return streams
  }
  return []
}

/**
 * What a private-data stream carries, if it is audio this names: DVB's
 * AC-3 (descriptor 0x6A) or E-AC-3 (0x7A) descriptor, or a registration
 * descriptor (0x05) naming either. Anything else private (subtitles, timed
 * metadata) is not audio, and is left out rather than guessed at.
 */
function privateAudio(stream: ElementaryStream): AudioCodec | null {
  for (const { tag, body } of stream.descriptors) {
    if (tag === 0x6a) return 'ac3'
    if (tag === 0x7a) return 'eac3'
    if (tag === 0x05 && body.length >= 4) {
      const format = String.fromCharCode(body[0]!, body[1]!, body[2]!, body[3]!)
      if (format === 'AC-3') return 'ac3'
      if (format === 'EAC3') return 'eac3'
    }
  }
  return null
}

/** One PID's payloads, joined: its elementary stream as far as the bytes go. */
function payloadOf(all: Packet[], pid: number): Uint8Array {
  const payloads = all.filter((p) => p.pid === pid).map((p) => p.payload)
  const stream = new Uint8Array(payloads.reduce((sum, p) => sum + p.length, 0))
  let at = 0
  for (const payload of payloads) {
    stream.set(payload, at)
    at += payload.length
  }
  return stream
}

/**
 * The first HEVC NAL unit of a type in a byte stream, without its start
 * code; its two-byte header stays on. HEVC's NAL type is bits 1–6 of the
 * first header byte, where H.264's is the low five bits of its one.
 */
function firstHevcNal(stream: Uint8Array, type: number): Uint8Array | null {
  for (let at = 0; at + 4 < stream.length; at++) {
    if (stream[at] !== 0 || stream[at + 1] !== 0 || stream[at + 2] !== 1) continue
    if (((stream[at + 3]! >> 1) & 0x3f) !== type) continue
    let end = at + 5
    while (end + 2 < stream.length && !(stream[end] === 0 && stream[end + 1] === 0 && stream[end + 2]! <= 1)) end++
    return stream.subarray(at + 3, end + 2 < stream.length ? end : stream.length)
  }
  return null
}

/** HEVC NAL unit type of a sequence parameter set. */
const HEVC_NAL_SPS = 33

/**
 * What an HEVC SPS declares: its profile, level and displayed size.
 * Follows H.265 section 7.3.2.2 as far as the conformance window; the
 * frame rate lies in the VUI, past fields this does not walk.
 */
export function readHevcSps(nal: Uint8Array): Pick<VideoSignature, 'profile' | 'level' | 'width' | 'height'> | null {
  try {
    const bits = new Bits(unescape(nal))
    bits.bits(16) // the NAL unit header
    bits.bits(4) // sps_video_parameter_set_id
    const subLayers = bits.bits(3) // sps_max_sub_layers_minus1
    bits.bit() // sps_temporal_id_nesting_flag

    // profile_tier_level(1, subLayers)
    bits.bits(3) // general_profile_space, general_tier_flag
    const profileIdc = bits.bits(5)
    bits.bits(32) // general_profile_compatibility_flags
    bits.bits(48) // the source, constraint and reserved flags
    const levelIdc = bits.bits(8)
    const present: Array<{ profile: number; level: number }> = []
    for (let i = 0; i < subLayers; i++) present.push({ profile: bits.bit(), level: bits.bit() })
    if (subLayers > 0) for (let i = subLayers; i < 8; i++) bits.bits(2)
    for (const layer of present) {
      if (layer.profile) {
        bits.bits(32)
        bits.bits(32)
        bits.bits(24)
      }
      if (layer.level) bits.bits(8)
    }

    bits.ue() // sps_seq_parameter_set_id
    const chroma = bits.ue()
    if (chroma === 3) bits.bit() // separate_colour_plane_flag
    let width = bits.ue()
    let height = bits.ue()
    if (bits.bit()) {
      // The conformance window, in chroma samples.
      const subWidth = chroma === 1 || chroma === 2 ? 2 : 1
      const subHeight = chroma === 1 ? 2 : 1
      width -= subWidth * (bits.ue() + bits.ue())
      height -= subHeight * (bits.ue() + bits.ue())
    }
    if (!(width > 0 && height > 0 && width <= 8192 && height <= 8192)) return null
    return { profile: hevcProfile(profileIdc), level: hevcLevel(levelIdc), width, height }
  } catch {
    return null
  }
}

/** What the first segment of an MPEG-TS rendition carries, for a television to decode. */
export interface TransportStreamCodecs {
  /** The video stream, as far as its SPS was reached; null for audio only. */
  video: VideoSignature | null
  /** Every audio stream's codec, in the PMT's order. */
  audio: AudioCodec[]
  /** The PMT lists SAMPLE-AES streams: the segments are encrypted beyond what AES-128 HLS does. */
  sampleAes: boolean
}

/**
 * The codecs the first segment of an MPEG-TS rendition carries, from its PMT,
 * with the video's profile, level, size and frame rate from its SPS.
 *
 * Null for anything that is not a transport stream with a PMT. A PMT read
 * before the video's SPS arrives still names the codec, with the rest null.
 */
export function readTransportStreamCodecs(bytes: Uint8Array): TransportStreamCodecs | null {
  const start = firstPacket(bytes)
  if (start === null) return null
  const all = packets(bytes, start)
  const pmt = pmtPid(all)
  if (pmt === null) return null
  const streams = elementaryStreams(all, pmt)
  if (streams.length === 0) return null

  const audio: AudioCodec[] = []
  let video: VideoSignature | null = null
  for (const stream of streams) {
    const sound = stream.type === STREAM_TYPE_PRIVATE ? privateAudio(stream) : AUDIO_STREAM_TYPES.get(stream.type)
    if (sound) audio.push(sound)
    else if (video === null) video = videoOf(all, stream)
  }
  return { video, audio, sampleAes: streams.some((s) => SAMPLE_AES_STREAM_TYPES.has(s.type)) }
}

/** The video a stream carries, read from its SPS where it has one this can read; null when it is not video. */
function videoOf(all: Packet[], stream: ElementaryStream): VideoSignature | null {
  const unread = { profile: null, level: null, width: null, height: null, fps: null }
  switch (stream.type) {
    case STREAM_TYPE_H264:
    case STREAM_TYPE_H264_SAMPLE_AES: {
      const sps = firstSps(payloadOf(all, stream.pid))
      const facts = sps && readSpsFacts(sps)
      if (!facts) return { codec: 'h264', ...unread }
      return {
        codec: 'h264',
        profile: h264Profile(facts.profileIdc, facts.constraints),
        level: h264Level(facts.levelIdc),
        width: facts.width,
        height: facts.height,
        fps: facts.fps,
      }
    }
    case STREAM_TYPE_HEVC: {
      const sps = firstHevcNal(payloadOf(all, stream.pid), HEVC_NAL_SPS)
      const facts = sps && readHevcSps(sps)
      return { codec: 'hevc', ...unread, ...(facts ?? {}) }
    }
    case STREAM_TYPE_MPEG2_VIDEO:
      return { codec: 'mpeg2', ...unread }
    case STREAM_TYPE_MPEG1_VIDEO:
      return { codec: 'other', ...unread }
    default:
      return null
  }
}
