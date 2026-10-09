/**
 * Which stream to download, at which quality, and the playlist that plays it
 * from the folder. Pure: fetching goes through the injected `StreamFetch`.
 *
 * ## From a capture to a plan
 *
 * The source is loaded hidden and plays for a few seconds; what its page
 * fetched is the capture (newest first). A player fetches a master playlist
 * and then the rendition it chose, or goes straight to a rendition. A master
 * is preferred: it is what lets the viewer's quality cap choose. Without one,
 * the rendition the player fetched is the only one known.
 *
 * ## The right film, before anything is kept
 *
 * Adverts and decoys are HLS too, and a source can serve a different video
 * in the film's place (a trailer, a clip, another episode). The playlist's
 * whole length is held to TMDB's runtime (`lengthVerdict`) before a single
 * segment is fetched, and a source that fails says so in words ("VidRock
 * plays something else here"), so the next source is tried.
 *
 * ## What is refused
 *
 * DRM (SAMPLE-AES and other key methods), byte ranges, live playlists, and
 * masters that keep the sound in a separate rendition: a video-only rendition
 * would download as a silent film. AES-128 is fine: `transfer.ts` decrypts
 * each segment as it arrives, so the local playlist has no key line.
 */

import { lengthVerdict } from '../runtimecheck'
import { parseMediaPlaylist, type MediaPlaylist, type UnfitReason } from '../segmentwindow'
import type { CapturedRequest, StreamFetch } from '../streamfetch'
import { masterVariants, qualityClass, type Variant } from '../streamquality'
import type { QualityCap } from './types'

/** One segment to fetch, as `plan.json` keeps it. */
export interface PlannedSegment {
  url: string
  seconds: number
  /** Its media sequence number: the IV of an AES-128 key line that names none. */
  sequence: number
  /** The AES-128 key's URL; null when the segment is in the clear. */
  keyUrl: string | null
  /** The key line's own IV, as written (`0x…`); null when it names none. */
  iv: string | null
  /** Which of the plan's initialisation segments it needs; null for MPEG-TS. */
  map: number | null
  discontinuity: boolean
}

/**
 * Everything a download needs to fetch its stream, and to resume after a
 * restart: kept as `plan.json` in the download's folder.
 */
export interface DownloadPlan {
  /** The media playlist the segments came from. */
  playlistUrl: string
  /** The headers the source's page fetched it with: `Referer`, `Origin`, the UA, cookies. */
  headers: Record<string, string>
  format: 'ts' | 'fmp4'
  /** The initialisation segments' URLs, for fMP4. */
  maps: string[]
  segments: PlannedSegment[]
  totalSeconds: number
  /** The rendition's height and bit rate, when the master said. */
  height: number | null
  /**
   * Its width, when the master said: with the height, what names its
   * quality class (1920×800 is 1080p). Absent from plans written before it
   * was kept.
   */
  width?: number | null
  bandwidth: number | null
}

export type PlanOutcome = { ok: true; plan: DownloadPlan } | { ok: false; reason: string }

export interface PlanOptions {
  /** TMDB's runtime in minutes, or null when it does not say. */
  expectedMinutes: number | null
  cap: QualityCap
  /** The source's name, for the reason given when it is refused. */
  sourceName: string
  /** Film or episode, for that reason too. */
  kind: 'film' | 'episode'
}

/** Enough of a response to see `#EXTM3U` and whether it is a master. */
const SNIFF_BYTES = 16 * 1024

/**
 * How many captured requests are sniffed. The capture keeps playlists and
 * the source's API calls, not its segments, so the chain that led to the
 * stream is well inside this.
 */
const CANDIDATES_TRIED = 30

/** The file names inside a download's folder. */
export const PLAN_FILE = 'plan.json'
export const PLAYLIST_FILE = 'index.m3u8'

export function segmentName(index: number, format: DownloadPlan['format']): string {
  return `s${String(index).padStart(5, '0')}.${format === 'fmp4' ? 'm4s' : 'ts'}`
}

export function mapName(index: number): string {
  return `init${index}.mp4`
}

/**
 * The variant the cap allows: the best at or under it, the better bit rate
 * between equals. When every variant is above the cap, the lowest of them
 * (the cap is a wish about size, not a reason to have nothing). Sizes a
 * master does not state are judged by bit rate alone.
 *
 * Judged by quality class (`qualityClass`), the names the cap's menu and the
 * Downloads tab use: by height alone, a letterboxed 1440p (2560×1068) passed
 * as "up to 1080p" and was then labelled 1440p.
 */
export function pickForCap(variants: readonly Variant[], cap: QualityCap): Variant | null {
  if (variants.length === 0) return null
  const limit = cap === 'best' ? Number.POSITIVE_INFINITY : cap
  const known = variants.flatMap((v) => (v.height === null ? [] : [{ v, quality: qualityClass({ width: v.width, height: v.height }) }]))
  if (known.length === 0) return variants.reduce((a, b) => (a.bandwidth >= b.bandwidth ? a : b))
  // Class first, then the taller picture, then the higher bit rate.
  const order = (a: (typeof known)[number], b: (typeof known)[number]): number =>
    a.quality - b.quality || a.v.height! - b.v.height! || a.v.bandwidth - b.v.bandwidth
  const fitting = known.filter((k) => k.quality <= limit)
  if (fitting.length > 0) return fitting.reduce((a, b) => (order(a, b) >= 0 ? a : b)).v
  return known.reduce((a, b) => (order(a, b) <= 0 ? a : b)).v
}

/** Whether a master keeps the sound in a rendition of its own, which a video download would leave out. */
export function hasSeparateAudio(master: string): boolean {
  return /^#EXT-X-MEDIA:(?=[^\n]*TYPE=AUDIO)(?=[^\n]*URI=)/m.test(master)
}

function minutes(seconds: number): string {
  return `${Math.max(1, Math.round(seconds / 60))} min`
}

/** Why a playlist cannot be downloaded, in the words the Downloads page shows. */
export function unfitReason(reason: UnfitReason | 'separate-audio' | 'nothing', source: string): string {
  switch (reason) {
    case 'drm':
      return `${source}'s stream is DRM-protected`
    case 'byte-ranges':
      return `${source} cuts its stream in byte ranges, which downloads do not handle`
    case 'live':
      return `${source} streams it live, not as a whole film`
    case 'separate-audio':
      return `${source} keeps the sound in a separate stream, which downloads do not handle yet`
    default:
      return `${source} streamed nothing the app can download`
  }
}

function lengthFits(seconds: number, options: PlanOptions): boolean {
  return lengthVerdict(seconds, options.expectedMinutes) !== 'implausible'
}

function wrongLengthReason(seconds: number, options: PlanOptions): string {
  const expected = options.expectedMinutes === null ? '' : ` for a ${options.expectedMinutes} min ${options.kind}`
  return `${options.sourceName} plays something else here (a ${minutes(seconds)} video${expected})`
}

/** The key line's IV attribute, or null. */
function ivOf(line: string): string | null {
  return /IV=(0[xX][0-9a-fA-F]+)/.exec(line)?.[1] ?? null
}

/** A parsed media playlist as a plan. Null when its segments mix MPEG-TS and fMP4, which no player would join. */
export function planFrom(
  playlist: MediaPlaylist,
  playlistUrl: string,
  headers: Record<string, string>,
  variant: { width: number | null; height: number | null; bandwidth: number | null },
): DownloadPlan | null {
  const maps: string[] = []
  const withMap = playlist.segments.filter((s) => s.map !== null).length
  if (withMap !== 0 && withMap !== playlist.segments.length) return null
  const segments = playlist.segments.map((s): PlannedSegment => {
    let map: number | null = null
    if (s.map) {
      map = maps.indexOf(s.map.url)
      if (map < 0) map = maps.push(s.map.url) - 1
    }
    return {
      url: s.url,
      seconds: s.seconds,
      sequence: s.sequence,
      keyUrl: s.key?.url ?? null,
      iv: s.key ? ivOf(s.key.line) : null,
      map,
      discontinuity: s.discontinuity,
    }
  })
  return {
    playlistUrl,
    headers,
    format: maps.length > 0 ? 'fmp4' : 'ts',
    maps,
    segments,
    totalSeconds: playlist.totalSeconds,
    height: variant.height,
    width: variant.width,
    bandwidth: variant.bandwidth,
  }
}

/**
 * The film's stream in a capture, as a plan; or why this source cannot be
 * downloaded, in words.
 */
export async function planDownload(requests: readonly CapturedRequest[], io: StreamFetch, options: PlanOptions): Promise<PlanOutcome> {
  const masters: Array<{ body: string; url: string; headers: Record<string, string> }> = []
  const media: Array<{ playlist: MediaPlaylist; url: string; headers: Record<string, string> }> = []
  /** Why the most telling candidate was refused, for when nothing qualifies. */
  let refused: string | null = null
  const tried = new Set<string>()

  for (const request of requests) {
    if (tried.size >= CANDIDATES_TRIED) break
    if (tried.has(request.url)) continue
    tried.add(request.url)
    const head = await io.fetchText(request.url, request.headers, SNIFF_BYTES)
    if (head === null || (head.status !== 200 && head.status !== 206)) continue
    if (!head.body.trimStart().startsWith('#EXTM3U')) continue
    const text = head.body.length < SNIFF_BYTES ? head : await io.fetchText(request.url, request.headers)
    if (text === null || text.status !== 200) continue
    const parsed = parseMediaPlaylist(text.body, request.url)
    if (parsed.ok) media.push({ playlist: parsed.playlist, url: request.url, headers: request.headers })
    else if (parsed.reason === 'master') masters.push({ body: text.body, url: request.url, headers: request.headers })
    else if (parsed.reason !== 'not-a-playlist') refused ??= unfitReason(parsed.reason, options.sourceName)
  }

  // A master first: it is what the quality cap chooses from.
  for (const master of masters) {
    if (hasSeparateAudio(master.body)) {
      refused ??= unfitReason('separate-audio', options.sourceName)
      continue
    }
    const variant = pickForCap(masterVariants(master.body, master.url), options.cap)
    if (variant === null) continue
    const text = await io.fetchText(variant.url, master.headers)
    if (text === null || text.status !== 200) continue
    const parsed = parseMediaPlaylist(text.body, variant.url)
    if (!parsed.ok) {
      refused ??= unfitReason(parsed.reason, options.sourceName)
      continue
    }
    if (!lengthFits(parsed.playlist.totalSeconds, options)) {
      refused = wrongLengthReason(parsed.playlist.totalSeconds, options)
      continue
    }
    const plan = planFrom(parsed.playlist, variant.url, master.headers, {
      width: variant.width,
      height: variant.height,
      bandwidth: variant.bandwidth || null,
    })
    if (plan) return { ok: true, plan }
  }

  // Only renditions: the newest one that is the film.
  for (const found of media) {
    if (!lengthFits(found.playlist.totalSeconds, options)) {
      refused = wrongLengthReason(found.playlist.totalSeconds, options)
      continue
    }
    const plan = planFrom(found.playlist, found.url, found.headers, { width: null, height: null, bandwidth: null })
    if (plan) return { ok: true, plan }
  }
  return { ok: false, reason: refused ?? unfitReason('nothing', options.sourceName) }
}

/**
 * Whether a fresh plan (after the signed URLs expired and the source was
 * captured again) is the same stream as the one on disk, so the segments
 * already kept stay and the download resumes at the next missing one.
 * Renditions of one ladder often share their segment times, so the picture's
 * height and bit rate must agree too when both plans know them: mixing
 * renditions would switch picture size mid-film, and an fMP4 init segment
 * fits one rendition only.
 */
export function samePlan(kept: DownloadPlan, fresh: DownloadPlan): boolean {
  if (kept.format !== fresh.format || kept.maps.length !== fresh.maps.length) return false
  if (kept.segments.length !== fresh.segments.length) return false
  if (kept.height !== null && fresh.height !== null && kept.height !== fresh.height) return false
  if (kept.bandwidth !== null && fresh.bandwidth !== null && kept.bandwidth !== fresh.bandwidth) return false
  return kept.segments.every((s, i) => Math.abs(s.seconds - fresh.segments[i]!.seconds) < 0.05)
}

/** A plan read back from `plan.json`; null when it is missing or not one. */
export function readPlan(text: string | null): DownloadPlan | null {
  if (text === null) return null
  try {
    const raw = JSON.parse(text) as Partial<DownloadPlan>
    if (typeof raw.playlistUrl !== 'string' || !Array.isArray(raw.segments) || !Array.isArray(raw.maps)) return null
    if (raw.format !== 'ts' && raw.format !== 'fmp4') return null
    return raw as DownloadPlan
  } catch {
    return null
  }
}

/**
 * What the whole download will take: the master's bit rate over the length,
 * or failing that the first segment's size scaled to the rest.
 */
export function estimateBytes(plan: DownloadPlan, sample: { bytes: number; seconds: number } | null): number | null {
  if (plan.bandwidth !== null && plan.bandwidth > 0) return Math.round((plan.bandwidth / 8) * plan.totalSeconds)
  if (sample !== null && sample.seconds > 0) return Math.round((sample.bytes / sample.seconds) * plan.totalSeconds)
  return null
}

/**
 * The playlist that plays the folder: every segment by its file name, the
 * initialisation segments likewise, and no key line, because the segments
 * were decrypted as they were saved. `gaps` are segments the source itself
 * could not give (see `MAX_GAP_SHARE` in `transfer.ts`): left out, with a
 * discontinuity where they were, as the source's own player skips them.
 */
export function localPlaylist(plan: DownloadPlan, gaps: ReadonlySet<number> = new Set()): string {
  const target = Math.max(1, Math.ceil(Math.max(...plan.segments.map((s) => s.seconds))))
  const lines = ['#EXTM3U', `#EXT-X-VERSION:${plan.format === 'fmp4' ? 7 : 3}`, `#EXT-X-TARGETDURATION:${target}`]
  lines.push('#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD')
  let map: number | null = null
  let afterGap = false
  plan.segments.forEach((s, i) => {
    if (gaps.has(i)) {
      afterGap = true
      return
    }
    if (s.map !== null && s.map !== map) {
      lines.push(`#EXT-X-MAP:URI="${mapName(s.map)}"`)
      map = s.map
    }
    if (s.discontinuity || afterGap) lines.push('#EXT-X-DISCONTINUITY')
    afterGap = false
    lines.push(`#EXTINF:${s.seconds.toFixed(6)},`, segmentName(i, plan.format))
  })
  lines.push('#EXT-X-ENDLIST', '')
  return lines.join('\n')
}
