/**
 * A few seconds of a stream, cut out of its playlist so they can be kept.
 *
 * The detail view's preview is the source's own page, and a page takes seconds
 * to start its player: that start-up, not the video's bytes, is where the time
 * goes (sharing the HTTP cache with it was measured as no gain in 2.0.2). So
 * the preview cache (the owner, 2026-09-29) keeps the stream itself, about
 * `WINDOW_SECONDS` of it from where the viewer stopped, and plays it with the
 * app's own `<video>`, which both platforms can do natively for HLS: measured
 * 8-131 ms to the first frame for five sources' real segments on the desktop,
 * 13 ms on the phone's WebView. The source's page still loads behind it and
 * takes over at the same second.
 *
 * This module is the cutting, and nothing else: which playlist to trust, which
 * segments cover a stretch of time, and the playlist that names the copies. It
 * fetches nothing, so it is the same on both platforms and testable without a
 * network. `segmentsave.ts` does the fetching; `segmentcache.ts` keeps count.
 *
 * ## What makes a stream unfit
 *
 * - **Not a whole film.** A live or event playlist moves under the window, and
 *   one without `#EXT-X-ENDLIST` is not known to start at the film's start,
 *   which is what maps a segment to an episode time. Adverts and decoys are
 *   HLS too; the caller holds the playlist's length to the title's
 *   (`lengthVerdict`) before believing it.
 * - **Byte ranges.** One file cut into ranges would need the ranges kept and
 *   served as such. No source measured on 2026-09-29 used them; refused rather
 *   than half-supported.
 * - **Keys other than AES-128.** SAMPLE-AES is DRM-shaped and would not play
 *   from a copy anyway.
 */

/** How much of a stream is kept: the owner's number (2026-09-29). */
export const WINDOW_SECONDS = 25

/** One segment of a media playlist, placed on the film's timeline. */
export interface PlaylistSegment {
  /** Absolute URL. */
  url: string
  /** Its `#EXTINF` length. */
  seconds: number
  /** Where it starts on the film's timeline: the lengths before it, summed. */
  start: number
  /** Its media sequence number, which is also the default AES-128 IV. */
  sequence: number
  /** The `#EXT-X-KEY` line in force for it, with its URI made absolute; null when unencrypted. */
  key: { line: string; url: string | null } | null
  /** The `#EXT-X-MAP` initialisation segment it needs, absolute; null for MPEG-TS. */
  map: { line: string; url: string } | null
  /** Preceded by `#EXT-X-DISCONTINUITY`. */
  discontinuity: boolean
}

export interface MediaPlaylist {
  segments: PlaylistSegment[]
  totalSeconds: number
  targetDuration: number
  version: number | null
}

export type UnfitReason = 'not-a-playlist' | 'master' | 'live' | 'byte-ranges' | 'drm' | 'empty'

export type ParsedMedia = { ok: true; playlist: MediaPlaylist } | { ok: false; reason: UnfitReason }

/** The stretch to keep, and the playlist that will play it from copies. */
export interface StreamWindow {
  /** Film time of the window's first frame. The kept video's 0 is this. */
  startSeconds: number
  endSeconds: number
  segments: PlaylistSegment[]
  /** Keys and initialisation segments the window needs, once each. */
  extras: string[]
}

function absolute(reference: string, base: string): string | null {
  try {
    return new URL(reference, base).toString()
  } catch {
    return null
  }
}

function attribute(line: string, name: string): string | null {
  const match = new RegExp(`${name}=("([^"]*)"|[^,]*)`).exec(line)
  if (!match) return null
  return match[2] ?? match[1] ?? null
}

/** `line` with its `URI="…"` made absolute against `base`, and that URL. */
function absoluteUriLine(line: string, base: string): { line: string; url: string | null } {
  let url: string | null = null
  const rewritten = line.replace(/URI="([^"]*)"/, (whole, reference: string) => {
    url = absolute(reference, base)
    return url === null ? whole : `URI="${url}"`
  })
  return { line: rewritten, url }
}

/**
 * Read a media playlist, or say why it cannot be kept.
 *
 * `url` is where it was fetched from, for resolving relative segment names;
 * segment URLs come back absolute.
 */
export function parseMediaPlaylist(body: string, url: string): ParsedMedia {
  if (!body.trimStart().startsWith('#EXTM3U')) return { ok: false, reason: 'not-a-playlist' }
  if (/^#EXT-X-STREAM-INF:/m.test(body)) return { ok: false, reason: 'master' }

  const segments: PlaylistSegment[] = []
  let sequence = 0
  let targetDuration = 0
  let version: number | null = null
  let ended = false
  let pendingSeconds: number | null = null
  let pendingDiscontinuity = false
  let key: PlaylistSegment['key'] = null
  let map: PlaylistSegment['map'] = null
  let start = 0

  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = Number(line.slice(22)) || 0
      else if (line.startsWith('#EXT-X-TARGETDURATION:')) targetDuration = Number(line.slice(22)) || 0
      else if (line.startsWith('#EXT-X-VERSION:')) version = Number(line.slice(15)) || null
      else if (line.startsWith('#EXT-X-ENDLIST')) ended = true
      else if (line.startsWith('#EXT-X-BYTERANGE:')) return { ok: false, reason: 'byte-ranges' }
      else if (line.startsWith('#EXT-X-DISCONTINUITY') && !line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE'))
        pendingDiscontinuity = true
      else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:EVENT')) return { ok: false, reason: 'live' }
      else if (line.startsWith('#EXTINF:')) pendingSeconds = Number.parseFloat(line.slice(8))
      else if (line.startsWith('#EXT-X-KEY:')) {
        const method = attribute(line, 'METHOD')
        if (method === 'NONE') key = null
        else if (method === 'AES-128') key = absoluteUriLine(line, url)
        else return { ok: false, reason: 'drm' }
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const resolved = absoluteUriLine(line, url)
        if (resolved.url === null) return { ok: false, reason: 'not-a-playlist' }
        if (attribute(line, 'BYTERANGE') !== null) return { ok: false, reason: 'byte-ranges' }
        map = { line: resolved.line, url: resolved.url }
      }
      continue
    }
    // A segment's URI, after its #EXTINF.
    const segmentUrl = absolute(line, url)
    if (segmentUrl === null || pendingSeconds === null || !Number.isFinite(pendingSeconds)) {
      pendingSeconds = null
      continue
    }
    segments.push({
      url: segmentUrl,
      seconds: pendingSeconds,
      start,
      sequence: sequence + segments.length,
      key,
      map,
      discontinuity: pendingDiscontinuity,
    })
    start += pendingSeconds
    pendingSeconds = null
    pendingDiscontinuity = false
  }

  if (!ended) return { ok: false, reason: 'live' }
  if (segments.length === 0) return { ok: false, reason: 'empty' }
  return { ok: true, playlist: { segments, totalSeconds: start, targetDuration, version } }
}

/**
 * The segments covering `lengthSeconds` from `fromSeconds`: the one playing at
 * that second, and on until the stretch is covered. Empty past the end.
 */
export function selectWindow(playlist: MediaPlaylist, fromSeconds: number, lengthSeconds = WINDOW_SECONDS): StreamWindow | null {
  const from = Math.max(0, fromSeconds)
  const until = from + lengthSeconds
  const segments = playlist.segments.filter((s) => s.start + s.seconds > from && s.start < until)
  if (segments.length === 0) return null
  const extras = new Set<string>()
  for (const s of segments) {
    if (s.key?.url) extras.add(s.key.url)
    if (s.map) extras.add(s.map.url)
  }
  const last = segments[segments.length - 1]!
  return { startSeconds: segments[0]!.start, endSeconds: last.start + last.seconds, segments, extras: [...extras] }
}

/**
 * The playlist that plays a window from its copies. `nameOf` gives each
 * segment's, key's and map's file name, relative to the playlist.
 *
 * The media sequence is the first kept segment's own: an AES-128 key without
 * an IV attribute uses the sequence number as its IV, so renumbering would
 * decrypt every segment wrongly.
 */
export function windowPlaylist(window: StreamWindow, version: number | null, nameOf: (url: string) => string): string {
  const target = Math.max(1, Math.ceil(Math.max(...window.segments.map((s) => s.seconds))))
  const lines = ['#EXTM3U', `#EXT-X-VERSION:${version ?? 3}`, `#EXT-X-TARGETDURATION:${target}`]
  lines.push(`#EXT-X-MEDIA-SEQUENCE:${window.segments[0]!.sequence}`, '#EXT-X-PLAYLIST-TYPE:VOD')
  let key: string | null = null
  let map: string | null = null
  for (const s of window.segments) {
    const keyLine = s.key?.url ? s.key.line.replace(s.key.url, nameOf(s.key.url)) : s.key?.line ?? null
    if (keyLine !== key) {
      lines.push(keyLine ?? '#EXT-X-KEY:METHOD=NONE')
      key = keyLine
    }
    const mapLine = s.map ? s.map.line.replace(s.map.url, nameOf(s.map.url)) : null
    if (mapLine !== null && mapLine !== map) {
      lines.push(mapLine)
      map = mapLine
    }
    if (s.discontinuity) lines.push('#EXT-X-DISCONTINUITY')
    lines.push(`#EXTINF:${s.seconds.toFixed(6)},`, nameOf(s.url))
  }
  lines.push('#EXT-X-ENDLIST', '')
  return lines.join('\n')
}

/** One variant of a master playlist. */
export interface Variant {
  url: string
  bandwidth: number
  height: number | null
}

/** The variants a master playlist offers, with absolute URLs. */
export function masterVariants(body: string, url: string): Variant[] {
  const variants: Variant[] = []
  let pending: { bandwidth: number; height: number | null } | null = null
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const resolution = attribute(line, 'RESOLUTION')
      const height = resolution ? Number(resolution.split('x')[1]) : NaN
      pending = { bandwidth: Number(attribute(line, 'BANDWIDTH')) || 0, height: Number.isFinite(height) ? height : null }
    } else if (pending !== null && line !== '' && !line.startsWith('#')) {
      const resolved = absolute(line, url)
      if (resolved !== null) variants.push({ url: resolved, ...pending })
      pending = null
    }
  }
  return variants
}

/**
 * The variant to keep: the one the player itself was fetching (it had chosen
 * for the screen and the connection), else the best at or under 1080 lines.
 */
export function pickVariant(variants: Variant[], fetched: ReadonlySet<string>): Variant | null {
  const used = variants.find((v) => fetched.has(v.url))
  if (used) return used
  const fitting = variants.filter((v) => v.height === null || v.height <= 1080)
  const pool = fitting.length > 0 ? fitting : variants
  return pool.reduce<Variant | null>((best, v) => (best === null || v.bandwidth > best.bandwidth ? v : best), null)
}

/**
 * What a downloaded segment is, from its first bytes, for its file name: the
 * copies are served by extension on the phone (Capacitor guesses the type from
 * it), and sources disguise segments as HTML or images upstream.
 */
export function segmentExtension(head: Uint8Array): 'ts' | 'm4s' | null {
  // MPEG-TS: a sync byte every 188 bytes.
  if (head.length >= 189 && head[0] === 0x47 && head[188] === 0x47) return 'ts'
  if (head.length >= 1 && head[0] === 0x47 && head.length < 189) return 'ts'
  // ISO BMFF: a box type in bytes 4-7.
  if (head.length >= 8) {
    const type = String.fromCharCode(head[4]!, head[5]!, head[6]!, head[7]!)
    if (['ftyp', 'styp', 'moof', 'sidx', 'moov', 'emsg', 'prft'].includes(type)) return 'm4s'
  }
  return null
}
