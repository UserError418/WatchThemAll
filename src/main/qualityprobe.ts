/**
 * The quality probe: for one provider and one title, what is the best picture
 * it offers — and can the app tell?
 *
 * The measurement behind `docs/internal/quality-plan.md`. It decides whether a
 * quality label in the source pickers is worth building: if most sources name
 * their best quality somewhere the app can read it, a label is useful; if most
 * do not, the column would be mostly blank and look broken.
 *
 * ## Through the scan's own path
 *
 * The page is loaded by `probeStream`, the same function "Test all sources"
 * uses, with the same shell, ad rules and presses — a label would come from the
 * scan, so the scan's path is the one whose answer counts. Three of its hooks
 * are used, all off by default so the scan itself is unchanged:
 *
 * - `onResponse`, to see every playlist the player asks for. The first media
 *   request is not enough: players fetch the master and then a variant, and
 *   some fetch a variant directly and never the master at all.
 * - `lingerMs`, to keep watching after that first request, because the
 *   renditions and the decoded picture arrive after it.
 * - `inspect`, to read the `<video>` elements before the window goes.
 *
 * ## Two independent readings
 *
 * The manifest says what is *offered*; the `<video>` says what is *decoding*.
 * Each playlist is asked for again with the headers the page sent — the phone's
 * `capture.peek` has exactly this keyhole, so what works here works there —
 * and read by `streamquality.ts`. The picture is a floor on the best quality,
 * never a ceiling (see `judgeQuality`), and it is the whole answer only for a
 * source that serves one file.
 */

import type { WebContents } from 'electron'
import type { Provider } from '@shared/types'
import { probeStream, type ProbeResponse, type ProbeSubject, type StreamVerdict } from './streamprobe'
import { replayableHeaders } from './streamextract'
import { isFalseWholeFile, WHOLE_FILE_URL } from './mediarequest'
import { checkRuntime } from './runtimecheck'
import { judgeQuality, readLadder, type LadderKind, type QualityJudgement, type Rendition } from '@shared/streamquality'

/**
 * How long the measurement keeps watching after the first media request.
 *
 * Long enough for a player to fetch its master, pick a variant, append a
 * segment and report the picture's size; measured players do that within a
 * few seconds of the first request. Only the measurement pays it — see
 * `QualityMode` for why the scan must not.
 */
const MEASURE_LINGER_MS = 12_000

/**
 * How long the scan waits for a single file's picture to report its size.
 *
 * Polled, not slept: a file's size is known as soon as its header is in, and
 * the wait ends there. The ceiling only matters for a page that never says.
 */
const SCAN_VIDEO_WAIT_MS = 4_000

/**
 * Two ways to take a reading.
 *
 * - `measure` — for the CLI. Lingers after the first media request and always
 *   reads the picture, so every reading is available to compare.
 * - `scan` — for "Test all sources". Stops where the scan always stopped, at
 *   the first media request: the master is normally that request, so it is
 *   already captured. It reads the picture only for a source that fetched a
 *   whole file and no playlist, the one case where the picture is the answer.
 *
 * The scan must not linger. Six probes run at once, and a player left running
 * keeps downloading segments while the others are still trying to start —
 * enough to push a slow provider past its budget and paint it red, the one
 * mistake the scan cannot afford.
 */
export type QualityMode = 'measure' | 'scan'

/**
 * The most playlists asked for again per probe.
 *
 * A player on a long film fetches a handful — a master, a variant or two, an
 * audio playlist. Anything past a dozen is a page polling something, and asking
 * for all of it again would be measuring the provider's rate limiter.
 */
const MAX_PLAYLISTS = 12

/**
 * The most bytes read of any one answer.
 *
 * A master is a few kilobytes; a media playlist for a three-hour film is a few
 * hundred. The cap is for the candidate that turns out to be a whole video file
 * behind an opaque URL, which would otherwise be downloaded in full.
 */
const MAX_BODY_BYTES = 512 * 1024

/** How long one re-request may take. A ceiling against a host that never answers. */
const REFETCH_TIMEOUT_MS = 10_000

/** Per frame, when asking for its `<video>` elements. The script returns at once. */
const FRAME_ANSWER_MS = 2_000

/** One playlist, asked for again, and what came back. */
export interface PlaylistReading {
  url: string
  /** Status of the re-request with the page's headers; 0 when it failed or timed out. */
  status: number
  kind: LadderKind
  renditions: Rendition[]
}

/** One `<video>` element, as the page reported it. */
export interface VideoReading {
  width: number
  height: number
  /** Seconds; Infinity for a live stream, NaN before metadata. */
  duration: number
}

export interface QualityProbeResult {
  providerId: string
  providerName: string
  subject: string
  verdict: StreamVerdict
  timeToMediaMs: number | null
  /** What the scan counted as the stream — the evidence behind `verdict`. */
  mediaSamples: string[]
  playlists: PlaylistReading[]
  /** Whole-file media URLs the page fetched, truncated. */
  wholeFiles: string[]
  /** The `<video>` judged to be the title — the longest one with a picture. */
  video: VideoReading | null
  /** Measure mode only: what each frame's player said about quality, raw. */
  sniffed: FrameSniff[]
  judgement: QualityJudgement
}

/** A playlist by what it says it is, before anyone has read it. */
const PLAYLIST_MIME = /mpegurl|dash\+xml/i
const PLAYLIST_URL = /\.(m3u8|mpd)(\?|$)/i
/** Types an opaque proxy serves a playlist under, where only reading it will tell. */
const OPAQUE_MIME = /^(text\/plain|application\/octet-stream)?\s*(;|$)/i
/** Things that are certainly not a playlist, whatever type they were served under. */
const NOT_A_PLAYLIST = /\.(ts|m4s|aac|jpe?g|png|gif|webp|svg|js|css|woff2?|json|vtt|srt)(\?|$)/i

type Candidate = 'playlist' | 'maybe-playlist' | 'whole-file'

/** What, if anything, a response could tell us about quality. */
function candidateOf(response: ProbeResponse): Candidate | null {
  if (response.statusCode >= 400) return null
  if (PLAYLIST_MIME.test(response.mime) || PLAYLIST_URL.test(response.url)) return 'playlist'
  if (NOT_A_PLAYLIST.test(response.url)) return null
  if (isFalseWholeFile(response.url, response.resourceType, response.mime, response.totalBytes)) return null
  // `.mp4` also names fMP4 segments; `judgeQuality` lets a playlist outrank them.
  if (WHOLE_FILE_URL.test(response.url) || response.resourceType === 'media') return 'whole-file'
  // Several providers proxy their playlists through extensionless paths served
  // as plain text or octet-stream. Only asking for one again can tell.
  const fetched = response.resourceType === 'xhr' || response.resourceType === 'other'
  if (fetched && OPAQUE_MIME.test(response.mime.trim())) return 'maybe-playlist'
  return null
}

/**
 * The script that reads every `<video>` in a frame, open shadow roots included.
 *
 * Several players build their controls as web components and put the video
 * inside one, where `document.querySelectorAll` does not reach.
 */
const READ_VIDEOS_SCRIPT = `(() => {
  const found = []
  const walk = (root) => {
    for (const element of root.querySelectorAll('*')) {
      if (element.tagName === 'VIDEO') found.push(element)
      if (element.shadowRoot) walk(element.shadowRoot)
    }
  }
  try { walk(document) } catch {}
  return found.map((v) => ({ width: v.videoWidth, height: v.videoHeight, duration: v.duration }))
})()`

/**
 * Everything a frame's player says about quality, raw.
 *
 * Run in the page's own JavaScript world, because that is where the players
 * keep what they know: hls.js holds its levels on the instance, JW Player
 * answers `getQualityLevels()`, video.js has `qualityLevels()`, and a player
 * that draws a quality menu has usually drawn it already, hidden until the
 * gear is clicked. Three kinds of evidence, each a short string:
 *
 * - `api` — a player object's own list of renditions
 * - `menu` — an element whose own text is a quality ("1080p", "4K"), with
 *   where it sits, hidden or not
 * - `attr` — an attribute naming a quality or resolution
 *
 * Deliberately raw: this is a survey, and the rules that turn it into a number
 * are written against what real players turned out to expose.
 */
const SNIFF_SCRIPT = `(() => {
  const out = { api: [], menu: [], attr: [] }
  const add = (list, text) => { if (list.length < 30) list.push(String(text).slice(0, 160)) }
  const heights = (levels) => {
    try { return JSON.stringify(Array.from(levels, (l) => l && (l.height ?? l.label ?? l.name ?? l.bitrate ?? null))) } catch { return '?' }
  }
  const tryLevels = (label, value) => {
    try {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value.levels) && value.levels.length) add(out.api, label + '.levels ' + heights(value.levels))
      if (value.hls && Array.isArray(value.hls.levels)) add(out.api, label + '.hls.levels ' + heights(value.hls.levels))
      if (typeof value.getQualityLevels === 'function') add(out.api, label + '.getQualityLevels ' + heights(value.getQualityLevels() || []))
      if (typeof value.qualityLevels === 'function') { const q = value.qualityLevels(); if (q && q.length) add(out.api, label + '.qualityLevels ' + heights(Array.from({ length: q.length }, (_, i) => q[i]))) }
      if (value.qualities && value.qualities.length) add(out.api, label + '.qualities ' + heights(Array.from(value.qualities)))
      if (Array.isArray(value.quality) && value.quality.length) add(out.api, label + '.quality ' + heights(value.quality))
      if (typeof value.getVariantTracks === 'function') add(out.api, label + '.getVariantTracks ' + heights(value.getVariantTracks()))
    } catch {}
  }
  try { if (typeof window.jwplayer === 'function') tryLevels('jwplayer()', window.jwplayer()) } catch {}
  try { if (window.videojs && window.videojs.getPlayers) for (const [id, p] of Object.entries(window.videojs.getPlayers())) tryLevels('videojs:' + id, p) } catch {}
  try { if (window.Artplayer && window.Artplayer.instances) window.Artplayer.instances.forEach((a, i) => tryLevels('Artplayer#' + i, a)) } catch {}
  try { for (const key of Object.keys(window)) { if (key.length < 40) tryLevels('window.' + key, window[key]) } } catch {}

  const QUALITY = /^\\s*(?:(2160|1440|1080|720|576|540|480|360|240)\\s?p(?:60|50)?|4K|UHD|FHD|Full HD|HD|SD|Auto(?:\\s*\\(\\d+p\\))?)\\s*$/i
  const where = (el) => {
    const parts = []
    for (let node = el; node && parts.length < 4; node = node.parentElement || (node.getRootNode && node.getRootNode().host)) {
      const cls = typeof node.className === 'string' ? node.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''
      parts.push(node.tagName.toLowerCase() + (cls ? '.' + cls : ''))
    }
    return parts.join('<')
  }
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'VIDEO') tryLevels('video', el), Object.keys(el).forEach((k) => tryLevels('video.' + k, el[k]))
      if (el.tagName === 'MEDIA-PLAYER' || el.tagName === 'MEDIA-CONTROLLER') tryLevels(el.tagName.toLowerCase(), el)
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim()
      if (own && own.length <= 16 && QUALITY.test(own)) add(out.menu, own + ' @ ' + where(el) + (el.offsetParent === null ? ' (hidden)' : ''))
      for (const attr of el.attributes) {
        if (/quality|resolution|level|height|label/i.test(attr.name) && /\\d{3,4}|4k|hd/i.test(attr.value)) add(out.attr, attr.name + '=' + attr.value + ' @ ' + where(el))
      }
      if (el.shadowRoot) walk(el.shadowRoot)
    }
  }
  try { walk(document) } catch {}
  return out
})()`

/** One frame's raw sniff, for the survey. */
export interface FrameSniff {
  frame: string
  api: string[]
  menu: string[]
  attr: string[]
}

/** The sniff script in every frame, keeping only frames that said something. */
async function sniffFrames(contents: WebContents): Promise<FrameSniff[]> {
  const found: FrameSniff[] = []
  for (const frame of contents.mainFrame.framesInSubtree) {
    const answer = (await Promise.race([
      frame.executeJavaScript(SNIFF_SCRIPT, true).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), FRAME_ANSWER_MS)),
    ])) as Omit<FrameSniff, 'frame'> | null
    if (!answer) continue
    if (answer.api.length + answer.menu.length + answer.attr.length === 0) continue
    found.push({ frame: frame.url.slice(0, 100), ...answer })
  }
  return found
}

/** Every `<video>` in every frame that answers in time. */
async function readVideos(contents: WebContents): Promise<VideoReading[]> {
  const readings: VideoReading[] = []
  for (const frame of contents.mainFrame.framesInSubtree) {
    const answer = await Promise.race([
      frame.executeJavaScript(READ_VIDEOS_SCRIPT, true).catch(() => []),
      new Promise<unknown>((resolve) => setTimeout(() => resolve([]), FRAME_ANSWER_MS)),
    ])
    if (Array.isArray(answer)) readings.push(...(answer as VideoReading[]))
  }
  return readings.filter((v) => v.height > 0)
}

/**
 * Which video is the title.
 *
 * The longest, not the largest: a pre-roll ad can be 1080p, and it is the
 * film's size the user cares about. With no finite length anywhere (a live
 * stream, or metadata not in), the largest picture is the best guess left.
 */
function titleVideo(videos: VideoReading[]): VideoReading | null {
  const finite = videos.filter((v) => Number.isFinite(v.duration) && v.duration > 0)
  const pool = finite.length > 0 ? finite : videos
  if (pool.length === 0) return null
  return pool.reduce((best, v) =>
    finite.length > 0 ? (v.duration > best.duration ? v : best) : v.height > best.height ? v : best,
  )
}

/** Read the page's videos until one reports a picture, or the wait runs out. */
async function waitForPicture(contents: WebContents, waitMs: number): Promise<VideoReading[]> {
  const deadline = Date.now() + waitMs
  for (;;) {
    if (contents.isDestroyed()) return []
    const videos = await readVideos(contents)
    if (videos.length > 0 || Date.now() >= deadline) return videos
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/** Ask for a URL again with the page's headers, reading at most `MAX_BODY_BYTES`. */
async function refetch(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  try {
    const response = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(REFETCH_TIMEOUT_MS),
    })
    if (!response.body) return { status: response.status, body: '' }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (size < MAX_BODY_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
    // Stop the transfer rather than drain it: this may be a whole film.
    await reader.cancel().catch(() => {})
    const body = new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES))
    return { status: response.status, body }
  } catch {
    return { status: 0, body: '' }
  }
}

export async function probeQuality(
  provider: Provider,
  subject: ProbeSubject,
  options: {
    mode: QualityMode
    timeoutMs: number
    frameUrl?: (providerUrl: string) => string
    verbose?: boolean
  },
): Promise<QualityProbeResult> {
  const candidates = new Map<string, { kind: Candidate; headers: Record<string, string> }>()
  let playlists: PlaylistReading[] | null = null
  let videos: VideoReading[] = []
  let sniffed: FrameSniff[] = []

  const result = await probeStream(provider, subject, {
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
    frameUrl: options.frameUrl,
    lingerMs: options.mode === 'measure' ? MEASURE_LINGER_MS : 0,
    onResponse: (response) => {
      const kind = candidateOf(response)
      if (!kind || candidates.has(response.url)) return
      candidates.set(response.url, { kind, headers: replayableHeaders(response.headers) })
    },
    /**
     * Read the playlists while the page is still alive — their tokens are at
     * their freshest — and then decide whether the picture is worth waiting for.
     */
    inspect: async (contents) => {
      playlists = await readPlaylists(candidates)
      if (options.mode === 'measure') {
        videos = await readVideos(contents)
        sniffed = await sniffFrames(contents)
        return
      }
      // A ladder settles it. Without one, the picture is the answer for a single
      // file or a single rendition, so wait for it — but only where something
      // streamed: a dead source has no picture, and waiting on one would add
      // the full wait to every dead source in the scan.
      const ladder = playlists.some((p) => p.renditions.length > 0)
      const streamed = playlists.length > 0 || [...candidates.values()].some((c) => c.kind === 'whole-file')
      if (!ladder && streamed) videos = await waitForPicture(contents, SCAN_VIDEO_WAIT_MS)
    },
  })

  // The page may have gone before `inspect` ran: the watchdog, or a crash.
  const read = playlists ?? (await readPlaylists(candidates))

  const wholeFiles = [...candidates.entries()]
    .filter(([, c]) => c.kind === 'whole-file')
    .map(([url]) => url.slice(0, 160))

  const video = titleVideo(videos)
  const judgement = judgeQuality({
    streamed: result.verdict === 'stream',
    playlists: read.map((p) => ({ status: p.status, ladder: { kind: p.kind, renditions: p.renditions } })),
    wholeFiles: wholeFiles.length,
    video: video ? { rendition: { width: video.width, height: video.height }, runtime: trustInPicture(video, subject) } : null,
  })

  return {
    providerId: provider.id,
    providerName: provider.name,
    subject: subject.label,
    verdict: result.verdict,
    timeToMediaMs: result.timeToMediaMs,
    mediaSamples: result.mediaSamples,
    playlists: read,
    wholeFiles,
    video,
    sniffed,
    judgement,
  }
}

/**
 * Ask for every captured playlist again and read what comes back.
 *
 * Certain playlists before possible ones, so a page's early API calls cannot
 * use up the cap ahead of the manifests. An opaque candidate that turns out not
 * to be a manifest was never a playlist, and is dropped rather than counted as
 * a sealed one.
 */
async function readPlaylists(
  candidates: Map<string, { kind: Candidate; headers: Record<string, string> }>,
): Promise<PlaylistReading[]> {
  const entries = [...candidates.entries()]
  const toRead = [
    ...entries.filter(([, c]) => c.kind === 'playlist'),
    ...entries.filter(([, c]) => c.kind === 'maybe-playlist'),
  ].slice(0, MAX_PLAYLISTS)
  const answers = await Promise.all(toRead.map(([url, c]) => refetch(url, c.headers)))

  const playlists: PlaylistReading[] = []
  for (const [index, [url, candidate]] of toRead.entries()) {
    const answer = answers[index]
    if (!answer) continue
    const ladder = readLadder(answer.body)
    if (candidate.kind === 'maybe-playlist' && ladder.kind === 'unknown') continue
    playlists.push({ url, status: answer.status, kind: ladder.kind, renditions: ladder.renditions })
  }
  return playlists
}

/**
 * Whether the picture is the title, and so whether its size may be believed.
 *
 * By its length against TMDB's runtime; and when TMDB gives none, by being at
 * least ten minutes long, which no ad or placeholder is and every episode is.
 */
function trustInPicture(video: VideoReading, subject: ProbeSubject): 'plausible' | 'implausible' | 'unknown' {
  const verdict = checkRuntime({
    deliveredSeconds: video.duration,
    expectedMinutes: subject.runtimeMinutes ?? null,
  }).verdict
  if (verdict !== 'unknown') return verdict
  return Number.isFinite(video.duration) && video.duration < 600 ? 'implausible' : 'unknown'
}
