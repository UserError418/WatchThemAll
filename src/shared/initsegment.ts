/**
 * The size of a picture, read from the stream's own bytes.
 *
 * An HLS media playlist names no quality — but when it carries fragmented MP4,
 * its `#EXT-X-MAP` points at an init segment: a kilobyte or two of `moov` box
 * that the decoder needs before any frame, and that states the video track's
 * coded width and height. The encoder wrote that number; nothing downstream
 * relabels it. So for a source that serves one rendition and no master, this
 * is the same answer the decoded picture gives, without a page to ask and
 * without waiting for a frame — which is what makes it readable on sources
 * whose player hides its `<video>`, and on the phone, which has no picture to
 * read at all.
 *
 * Pure and in `shared/` for that second reason: the desktop scan and the phone
 * scan fetch the bytes through different keyholes and must read them alike.
 *
 * ## The boxes read
 *
 * ISO BMFF, as every fMP4 packager writes it:
 *
 *     moov
 *       trak                       one per track; the video one is wanted
 *         tkhd                     display width and height, 16.16 fixed point
 *         mdia
 *           hdlr                   handler type: 'vide' for video
 *           minf / stbl / stsd     sample entry: coded width and height
 *
 * The sample entry's size is preferred — it is the size of the frames the
 * decoder produces. `tkhd`'s is the fallback, for a packager that zeroes the
 * entry. Anything malformed or cut short reads as null: a wrong size is worse
 * than none, and a truncated box is not evidence of anything.
 *
 * ## What else the same boxes say: `readInitSegmentCodecs`
 *
 * Whether a television can decode the stream (`streamsignature.ts`): each
 * track's sample entry names its codec by four characters (`avc1`, `hvc1`,
 * `mp4a`, `ac-3`, or `encv` for an encrypted one), and the decoder
 * configuration inside it (`avcC`, `hvcC`, `vpcC`, `av1C`, `esds`) the
 * profile and level. The same reader serves the head of a whole MP4 file,
 * whose `moov` is the same structure; there it may be cut short by the
 * sniff, so it reads as far as the bytes go (`readMovieDuration` too).
 */

import { h264Level, h264Profile, hevcLevel, hevcProfile, type AudioCodec, type VideoSignature } from './codecnames'
import type { Rendition } from './streamquality'
import { readSpsFacts } from './transportstream'

/** A box: its four-character type and where its payload starts and ends. */
interface Box {
  type: string
  start: number
  end: number
}

/**
 * The boxes directly inside `[start, end)`, stopping at the first one that
 * does not fit; or, with `allowCut`, keeping that one as far as the bytes go,
 * for the head of a whole file whose `moov` runs past what was read.
 */
function childBoxes(bytes: Uint8Array, start: number, end: number, allowCut = false): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const boxes: Box[] = []
  let at = start
  while (at + 8 <= end) {
    let size = view.getUint32(at)
    const type = String.fromCharCode(bytes[at + 4]!, bytes[at + 5]!, bytes[at + 6]!, bytes[at + 7]!)
    let header = 8
    if (size === 1) {
      // A 64-bit size. Init segments never need one, but a box that uses it
      // must still be stepped over correctly rather than misread.
      if (at + 16 > end) break
      size = view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12)
      header = 16
    } else if (size === 0) {
      size = end - at
    }
    if (size < header) break
    if (at + size > end) {
      if (allowCut) boxes.push({ type, start: at + header, end })
      break
    }
    boxes.push({ type, start: at + header, end: at + size })
    at += size
  }
  return boxes
}

/** The first box of a type directly inside a box. */
function child(bytes: Uint8Array, parent: Box, type: string): Box | null {
  return childBoxes(bytes, parent.start, parent.end).find((box) => box.type === type) ?? null
}

/** A size worth believing: both sides present, and no bigger than 8K. */
function plausible(width: number, height: number): Rendition | null {
  return width > 0 && height > 0 && width <= 8192 && height <= 8192 ? { width, height } : null
}

/** The video track's coded size, from its first sample entry. */
function sampleEntrySize(bytes: Uint8Array, trak: Box): Rendition | null {
  let box: Box | null = child(bytes, trak, 'mdia')
  for (const type of ['minf', 'stbl', 'stsd']) box = box && child(bytes, box, type)
  if (!box) return null
  // stsd is a full box: version and flags, an entry count, then the entries.
  const entries = childBoxes(bytes, box.start + 8, box.end)
  const entry = entries[0]
  // A visual sample entry: 8 bytes of SampleEntry, 16 of reserved and
  // pre-defined fields, then width and height as 16-bit integers.
  if (!entry || entry.end - entry.start < 28) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return plausible(view.getUint16(entry.start + 24), view.getUint16(entry.start + 26))
}

/** The track's display size: the last eight bytes of `tkhd`, as 16.16 fixed point. */
function trackHeaderSize(bytes: Uint8Array, trak: Box): Rendition | null {
  const tkhd = child(bytes, trak, 'tkhd')
  if (!tkhd || tkhd.end - tkhd.start < 84) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return plausible(view.getUint32(tkhd.end - 8) >>> 16, view.getUint32(tkhd.end - 4) >>> 16)
}

/** Whether a track is video, by its handler. */
function isVideo(bytes: Uint8Array, trak: Box): boolean {
  const mdia = child(bytes, trak, 'mdia')
  const hdlr = mdia && child(bytes, mdia, 'hdlr')
  // hdlr: version and flags (4), pre-defined (4), then the handler type.
  if (!hdlr || hdlr.end - hdlr.start < 12) return false
  const at = hdlr.start + 8
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!) === 'vide'
}

/**
 * The picture size an fMP4 init segment declares, or null.
 *
 * Null for an audio-only init segment, for one without a `moov`, and for any
 * bytes that are not an init segment at all — an HTML error page, a truncated
 * download.
 */
export function readInitSegmentSize(bytes: Uint8Array): Rendition | null {
  const moov = childBoxes(bytes, 0, bytes.byteLength).find((box) => box.type === 'moov')
  if (!moov) return null
  for (const trak of childBoxes(bytes, moov.start, moov.end)) {
    if (trak.type !== 'trak' || !isVideo(bytes, trak)) continue
    return sampleEntrySize(bytes, trak) ?? trackHeaderSize(bytes, trak)
  }
  return null
}

/* ── Codecs: what a television would have to decode ───────────────────── */

/** What an init segment, or a whole file's `moov`, says its tracks carry. */
export interface InitSegmentCodecs {
  /** The first video track; null when there is none, or none could be read. */
  video: VideoSignature | null
  /** Every audio track's codec, in the file's order. */
  audio: AudioCodec[]
  /** A sample entry is `encv` or `enca`: common encryption, which is DRM here. */
  encrypted: boolean
}

/** A box's four characters at `at`. */
function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!)
}

/**
 * The first box of a type inside a box, as far as the bytes go: a whole
 * file's `moov` is read from its head, and the box holding what is wanted
 * may run past it while what is wanted does not.
 */
function within(bytes: Uint8Array, parent: Box, type: string): Box | null {
  return childBoxes(bytes, parent.start, parent.end, true).find((box) => box.type === type) ?? null
}

/** A track's handler type: `vide`, `soun`, or another; null when unreadable. */
function handlerOf(bytes: Uint8Array, trak: Box): string | null {
  const mdia = within(bytes, trak, 'mdia')
  const hdlr = mdia && within(bytes, mdia, 'hdlr')
  if (!hdlr || hdlr.end - hdlr.start < 12) return null
  return fourcc(bytes, hdlr.start + 8)
}

/** A track's first sample entry, the box whose type names its codec. */
function sampleEntry(bytes: Uint8Array, trak: Box): Box | null {
  let box: Box | null = within(bytes, trak, 'mdia')
  for (const type of ['minf', 'stbl', 'stsd']) box = box && within(bytes, box, type)
  if (!box) return null
  // The entry itself must be whole: its configuration is what is read.
  return childBoxes(bytes, box.start + 8, box.end)[0] ?? null
}

/**
 * Where a sample entry's own boxes start. A visual entry has 78 bytes of
 * fields first (the size among them); an audio entry 28, or 16 or 36 more in
 * QuickTime's versions 1 and 2.
 */
function entryChildrenAt(bytes: Uint8Array, entry: Box, kind: 'video' | 'audio'): number {
  if (kind === 'video') return entry.start + 78
  const version = entry.end - entry.start >= 10 ? (bytes[entry.start + 8]! << 8) | bytes[entry.start + 9]! : 0
  return entry.start + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0)
}

/** The boxes inside a sample entry, and the format it stands for: an encrypted entry's original, from `sinf`/`frma`. */
function entryContents(bytes: Uint8Array, entry: Box, kind: 'video' | 'audio'): { format: string; boxes: Box[]; encrypted: boolean } {
  const boxes = childBoxes(bytes, entryChildrenAt(bytes, entry, kind), entry.end)
  if (entry.type !== 'encv' && entry.type !== 'enca') return { format: entry.type, boxes, encrypted: false }
  const sinf = boxes.find((b) => b.type === 'sinf')
  const frma = sinf && child(bytes, sinf, 'frma')
  const format = frma && frma.end - frma.start >= 4 ? fourcc(bytes, frma.start) : entry.type
  return { format, boxes, encrypted: true }
}

/** The video a visual sample entry describes. */
function videoEntry(bytes: Uint8Array, entry: Box): { video: VideoSignature; encrypted: boolean } {
  const { format, boxes, encrypted } = entryContents(bytes, entry, 'video')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const size = entry.end - entry.start >= 28 ? plausible(view.getUint16(entry.start + 24), view.getUint16(entry.start + 26)) : null
  const video: VideoSignature = { codec: 'other', profile: null, level: null, width: size?.width ?? null, height: size?.height ?? null, fps: null }
  const config = (type: string): Box | null => boxes.find((b) => b.type === type) ?? null

  if (format === 'avc1' || format === 'avc3') {
    video.codec = 'h264'
    const avcC = config('avcC')
    if (avcC && avcC.end - avcC.start >= 6) {
      video.profile = h264Profile(bytes[avcC.start + 1]!, bytes[avcC.start + 2]!)
      video.level = h264Level(bytes[avcC.start + 3]!)
      // The first SPS, for the frame rate its VUI states (the entry's size is already known).
      if ((bytes[avcC.start + 5]! & 0x1f) > 0 && avcC.end - avcC.start >= 9) {
        const length = view.getUint16(avcC.start + 6)
        const sps = bytes.subarray(avcC.start + 9, Math.min(avcC.start + 8 + length, avcC.end))
        video.fps = readSpsFacts(sps)?.fps ?? null
      }
    }
  } else if (format === 'hvc1' || format === 'hev1') {
    video.codec = 'hevc'
    const hvcC = config('hvcC')
    if (hvcC && hvcC.end - hvcC.start >= 13) {
      video.profile = hevcProfile(bytes[hvcC.start + 1]! & 0x1f)
      video.level = hevcLevel(bytes[hvcC.start + 12]!)
    }
  } else if (format === 'vp09') {
    video.codec = 'vp9'
    const vpcC = config('vpcC')
    if (vpcC && vpcC.end - vpcC.start >= 6) {
      video.profile = `profile${bytes[vpcC.start + 4]!}`
      video.level = bytes[vpcC.start + 5]! / 10
    }
  } else if (format === 'av01') {
    video.codec = 'av1'
    const av1C = config('av1C')
    if (av1C && av1C.end - av1C.start >= 2) {
      const profile = bytes[av1C.start + 1]! >> 5
      const levelIndex = bytes[av1C.start + 1]! & 0x1f
      video.profile = ['main', 'high', 'professional'][profile] ?? null
      video.level = 2 + (levelIndex >> 2) + (levelIndex & 3) / 10
    }
  } else if (format === 'vp08') {
    video.codec = 'vp8'
  } else if (format === 'mp4v') {
    video.codec = 'other'
  }
  return { video, encrypted }
}

/** The audio codec an audio sample entry carries. */
function audioEntry(bytes: Uint8Array, entry: Box): { audio: AudioCodec; encrypted: boolean } {
  const { format, boxes, encrypted } = entryContents(bytes, entry, 'audio')
  switch (format) {
    case 'mp4a': {
      const esds = boxes.find((b) => b.type === 'esds')
      return { audio: esds ? esdsCodec(bytes, esds) : 'aac', encrypted }
    }
    case 'ac-3':
      return { audio: 'ac3', encrypted }
    case 'ec-3':
      return { audio: 'eac3', encrypted }
    case 'Opus':
      return { audio: 'opus', encrypted }
    case 'fLaC':
      return { audio: 'flac', encrypted }
    case '.mp3':
      return { audio: 'mp3', encrypted }
    default:
      return { audio: 'other', encrypted }
  }
}

/**
 * What an `mp4a` entry's `esds` says it holds, by the decoder configuration's
 * object type: AAC nearly always, MP3 now and then. An `esds` this cannot
 * walk reads as AAC, which is what `mp4a` means unless it says otherwise.
 */
function esdsCodec(bytes: Uint8Array, esds: Box): AudioCodec {
  // A full box (4 bytes), then descriptors: tag, a length of 1–4 bytes, the body.
  let at = esds.start + 4
  const readLength = (): number => {
    let length = 0
    for (let i = 0; i < 4 && at < esds.end; i++) {
      const byte = bytes[at++]!
      length = (length << 7) | (byte & 0x7f)
      if ((byte & 0x80) === 0) break
    }
    return length
  }
  if (bytes[at++] !== 0x03) return 'aac' // ES_Descriptor
  readLength()
  const flags = bytes[at + 2] ?? 0
  at += 3 // ES_ID and its flags
  if (flags & 0x80) at += 2 // dependsOn_ES_ID
  if (flags & 0x40) at += 1 + (bytes[at] ?? 0) // URL
  if (flags & 0x20) at += 2 // OCR_ES_Id
  if (bytes[at++] !== 0x04) return 'aac' // DecoderConfigDescriptor
  readLength()
  const objectType = bytes[at]
  return objectType === 0x69 || objectType === 0x6b ? 'mp3' : 'aac'
}

/**
 * The codecs an fMP4 init segment declares, or a whole MP4 file's `moov` at
 * its head: the first video track, and every audio track. Null when there is
 * no `moov` in the bytes (a file that keeps it at its end, or no MP4 at all).
 */
export function readInitSegmentCodecs(bytes: Uint8Array): InitSegmentCodecs | null {
  const moov = childBoxes(bytes, 0, bytes.byteLength, true).find((box) => box.type === 'moov')
  if (!moov) return null
  let video: VideoSignature | null = null
  const audio: AudioCodec[] = []
  let encrypted = false
  for (const trak of childBoxes(bytes, moov.start, moov.end, true)) {
    if (trak.type !== 'trak') continue
    const handler = handlerOf(bytes, trak)
    const entry = handler === 'vide' || handler === 'soun' ? sampleEntry(bytes, trak) : null
    if (!entry) continue
    if (handler === 'vide' && video === null) {
      const read = videoEntry(bytes, entry)
      video = read.video
      // The entry may zero its size; the track header has the display size then.
      if (video.width === null) {
        const size = trackHeaderSize(bytes, trak)
        if (size) Object.assign(video, size)
      }
      encrypted ||= read.encrypted
    } else if (handler === 'soun') {
      const read = audioEntry(bytes, entry)
      audio.push(read.audio)
      encrypted ||= read.encrypted
    }
  }
  return { video, audio, encrypted }
}

/**
 * How long a whole MP4 file runs, in seconds, from its `mvhd`; null when the
 * head read holds no `moov` (a file not prepared for streaming keeps it at
 * its end) or the header says nothing usable.
 *
 * The cast path holds a whole file's length to the title's
 * (`lengthVerdict`), as it does a playlist's: a decoy is a whole file too.
 * Only the `moov`'s opening is needed, so the rest of it may be cut off.
 */
export function readMovieDuration(bytes: Uint8Array): number | null {
  const moov = childBoxes(bytes, 0, bytes.byteLength, true).find((box) => box.type === 'moov')
  const mvhd = moov && childBoxes(bytes, moov.start, moov.end, true).find((box) => box.type === 'mvhd')
  if (!mvhd) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = bytes[mvhd.start]
  // Version, flags; then two times of 4 bytes (or 8), the timescale, and the duration.
  const scaleAt = mvhd.start + (version === 1 ? 20 : 12)
  const durationEnd = scaleAt + 4 + (version === 1 ? 8 : 4)
  if (durationEnd > mvhd.end) return null
  const timescale = view.getUint32(scaleAt)
  const duration = version === 1 ? view.getUint32(scaleAt + 4) * 2 ** 32 + view.getUint32(scaleAt + 8) : view.getUint32(scaleAt + 4)
  if (timescale === 0 || duration === 0 || duration === 0xffffffff) return null
  return duration / timescale
}
