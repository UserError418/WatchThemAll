/**
 * Where a single rendition states its own picture size, and how to read it.
 *
 * A media playlist names no size, but the stream it lists does, in bytes the
 * decoder needs before its first frame: fMP4 in the `#EXT-X-MAP` init segment
 * (`initsegment.ts`), MPEG-TS in the SPS at the head of its first segment
 * (`transportstream.ts`). This picks which and reads it.
 *
 * Shared because the desktop scan and the phone scan fetch these bytes through
 * different keyholes — Node's `fetch`, and `capture.peekBytes` — and must
 * agree on what to fetch and how to read what came back.
 */

import { readInitSegmentSize } from './initsegment'
import type { MediaPlaylist, Rendition } from './streamquality'
import { readTransportStreamSize } from './transportstream'

/**
 * The most bytes to read of a header.
 *
 * An init segment is a `moov` with no sample tables: one or two kilobytes, ten
 * with DRM headers. A TS segment states its size in the SPS at the head of its
 * first keyframe, within the first few packets. The cap is for a host that
 * ignores the byte range and starts sending the whole segment.
 */
export const HEADER_BYTES = 64 * 1024

/** Where one media playlist's stream states its size. */
export interface StreamHeader {
  source: 'init' | 'segment'
  url: string
  /** The bytes to ask for: the init segment's own range, or the segment's opening. */
  range: { offset: number; length: number }
}

/** The header to fetch for a media playlist read from `playlistUrl`, or null if it lists nothing. */
export function streamHeaderOf(media: MediaPlaylist, playlistUrl: string): StreamHeader | null {
  const opening = { offset: 0, length: HEADER_BYTES }
  if (media.init !== null) {
    const url = resolve(media.init, playlistUrl)
    return url === null ? null : { source: 'init', url, range: media.initRange ?? opening }
  }
  if (media.firstSegment !== null) {
    const url = resolve(media.firstSegment, playlistUrl)
    return url === null ? null : { source: 'segment', url, range: opening }
  }
  return null
}

/** The picture size a fetched header states, or null when it states none this can read. */
export function readStreamHeader(source: StreamHeader['source'], bytes: Uint8Array): Rendition | null {
  return source === 'init' ? readInitSegmentSize(bytes) : readTransportStreamSize(bytes)
}

/** A playlist's relative reference as an absolute URL, or null if it will not parse. */
function resolve(reference: string, base: string): string | null {
  try {
    return new URL(reference, base).href
  } catch {
    return null
  }
}
