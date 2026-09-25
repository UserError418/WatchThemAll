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
 */

import type { Rendition } from './streamquality'

/** A box: its four-character type and where its payload starts and ends. */
interface Box {
  type: string
  start: number
  end: number
}

/** The boxes directly inside `[start, end)`, stopping at the first one that does not fit. */
function childBoxes(bytes: Uint8Array, start: number, end: number): Box[] {
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
    if (size < header || at + size > end) break
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
