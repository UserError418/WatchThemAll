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
 */

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
  try {
    const bits = new Bits(unescape(nal))
    const profile = bits.bits(8)
    bits.bits(16) // constraint flags, level
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
    return width > 0 && height > 0 && width <= 8192 && height <= 8192 ? { width, height } : null
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
