/**
 * Keeping a window of a stream: from what the player fetched to files the
 * preview can play (the preview cache, see `segmentwindow.ts`).
 *
 * Given the requests the source's page made (`castcapture.ts` on the desktop,
 * `MediaCapture.java` on the phone, newest first) and where the viewer
 * stopped, find the media playlist the player was using, check that it is
 * this film, and download the segments covering the next `WINDOW_SECONDS`
 * into a directory with a playlist naming them. Both platforms run this; they
 * differ only in how a URL is fetched with the source's headers and where the
 * bytes go, which is `SaveIo`.
 *
 * The segments are fetched again rather than taken from the player: neither
 * platform can read a response body the page received (the desktop's
 * `webRequest` sees headers only, and the phone's `shouldInterceptRequest` can
 * only replace a response, which would put this code in the path of every
 * byte the player gets). A window is 3-16 MB; fetching it once more, as the
 * player is closed, is the price.
 */

import { lengthVerdict } from './runtimecheck'
import {
  WINDOW_SECONDS,
  masterVariants,
  parseMediaPlaylist,
  pickVariant,
  segmentExtension,
  selectWindow,
  windowPlaylist,
  type MediaPlaylist,
  type StreamWindow,
} from './segmentwindow'

/** A request the source's page made, with the headers it was made with. */
export interface CapturedRequest {
  url: string
  headers: Record<string, string>
}

/** Fetching with a source's headers, which the page's own origin could not send. */
export interface StreamFetch {
  /**
   * A URL's text, fetched with these headers; null when it could not be
   * reached. `limitBytes`: only the start of it. Candidates are sniffed that
   * way, since most are segments of several megabytes.
   */
  fetchText(url: string, headers: Record<string, string>, limitBytes?: number): Promise<{ status: number; body: string } | null>
}

export interface SaveIo extends StreamFetch {
  /**
   * A URL's bytes, fetched with these headers, written as `name` in the
   * window's directory. Returns the status, the size and the first bytes
   * (enough to tell a segment from an error page); null when unreachable.
   */
  download(url: string, headers: Record<string, string>, name: string): Promise<{ status: number; bytes: number; head: Uint8Array } | null>
  /** Write `text` as `name` in the window's directory. */
  writeText(name: string, text: string): Promise<void>
}

export type SaveOutcome =
  | { ok: true; startSeconds: number; endSeconds: number; bytes: number }
  | { ok: false; reason: string }

/** Segments downloaded at once: enough to overlap the round trips, few enough not to crowd a phone's connection. */
const DOWNLOADS_AT_ONCE = 3

/** `work` over `items`, at most `limit` at a time; results in the items' order. */
async function inParallel<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await work(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
}

/** Enough of a response to see `#EXTM3U` and whether it is a master: a playlist's head. */
const SNIFF_BYTES = 16 * 1024

/** How many captured requests to try as the playlist. The chain the player went through is a handful; more are adverts. */
const CANDIDATES_TRIED = 20

/**
 * A window this short is not worth keeping: the source's own preview needs
 * seconds to load behind it. Also what is kept of a window whose later
 * segments failed.
 */
const MIN_KEPT_SECONDS = 10

/**
 * How far the playlist's length may differ from the film the player showed.
 * Measured on 2026-09-29: VidSrc, VidRock and VidZee within 0.1 s of the
 * element's own duration. More than this is another cut, an advert, or a decoy,
 * and its seconds would not be the film's.
 */
function lengthMatches(playlistSeconds: number, filmSeconds: number): boolean {
  if (!Number.isFinite(filmSeconds) || filmSeconds <= 0) return true
  return Math.abs(playlistSeconds - filmSeconds) <= Math.max(5, filmSeconds * 0.01)
}

/**
 * The media playlist the player was using. Playlists that are not this film
 * (adverts are HLS too, and some sources serve a decoy) are passed over, not
 * trusted: `fits` holds each one to the film's length.
 */
async function findPlaylist(
  requests: readonly CapturedRequest[],
  io: StreamFetch,
  fits: (playlistSeconds: number) => boolean,
): Promise<{ playlist: MediaPlaylist; url: string; headers: Record<string, string> } | { reason: string }> {
  let master: { body: string; url: string; headers: Record<string, string> } | null = null
  /** Why the best candidate so far was refused, for the log when nothing is found. */
  let refused: string | null = null
  const tried = new Set<string>()
  for (const request of requests) {
    if (tried.size >= CANDIDATES_TRIED) break
    if (tried.has(request.url)) continue
    tried.add(request.url)
    const head = await io.fetchText(request.url, request.headers, SNIFF_BYTES)
    if (head === null || (head.status !== 200 && head.status !== 206)) continue
    if (!head.body.trimStart().startsWith('#EXTM3U')) continue
    // A playlist: now the whole of it, unless its head already was.
    const text = head.body.length < SNIFF_BYTES ? head : await io.fetchText(request.url, request.headers)
    if (text === null || text.status !== 200) continue
    const parsed = parseMediaPlaylist(text.body, request.url)
    if (parsed.ok) {
      if (fits(parsed.playlist.totalSeconds)) return { playlist: parsed.playlist, url: request.url, headers: request.headers }
      refused ??= 'not-the-film'
    } else if (parsed.reason === 'master') master ??= { body: text.body, url: request.url, headers: request.headers }
    else if (parsed.reason !== 'not-a-playlist') refused ??= parsed.reason
  }
  if (master === null) return { reason: refused ?? 'no-playlist' }

  // Only the master was seen: take the variant the player fetched, if it did.
  const variant = pickVariant(masterVariants(master.body, master.url), new Set(requests.map((r) => r.url)))
  if (variant === null) return { reason: 'no-variant' }
  const text = await io.fetchText(variant.url, master.headers)
  if (text === null || text.status !== 200) return { reason: 'variant-unreachable' }
  const parsed = parseMediaPlaylist(text.body, variant.url)
  if (!parsed.ok) return { reason: parsed.reason }
  return fits(parsed.playlist.totalSeconds)
    ? { playlist: parsed.playlist, url: variant.url, headers: master.headers }
    : { reason: 'not-the-film' }
}

/**
 * Whether a playlist is the film. When the page's own element said how long
 * the film is, that is the test: the window is a copy of what was on screen,
 * and the source's preview will show that same stream anyway. TMDB's runtime
 * is only the guard when the element's length is not known: sources number
 * some episodes differently (VidRock's S04E05 of The Office is 42 minutes,
 * TMDB's far shorter), and held to TMDB a stream the viewer had just watched
 * was refused (measured on the phone, 2026-09-29).
 */
function fitsTheFilm(filmSeconds: number, expectedMinutes: number | null): (seconds: number) => boolean {
  if (Number.isFinite(filmSeconds) && filmSeconds > 0) return (seconds) => lengthMatches(seconds, filmSeconds)
  return (seconds) => lengthVerdict(seconds, expectedMinutes) !== 'implausible'
}

/**
 * The request that is the film's media playlist, found while the film is
 * playing, so it can be tried first when the window is kept later. By then
 * the capture may no longer hold it: a source whose segments carry no file
 * extension (VidRock) floods the capture's forty places within a minute
 * (measured on the phone, 2026-09-29). `filmSeconds` 0 when not yet known.
 */
export async function findStreamPlaylist(
  requests: readonly CapturedRequest[],
  io: StreamFetch,
  filmSeconds: number,
  expectedMinutes: number | null,
): Promise<CapturedRequest | { reason: string }> {
  const found = await findPlaylist(requests, io, fitsTheFilm(filmSeconds, expectedMinutes))
  return 'reason' in found ? found : { url: found.url, headers: found.headers }
}

/**
 * Keep `WINDOW_SECONDS` of the film from `from.seconds`. `from.duration` is
 * the length the player's element reported, and `expectedMinutes` TMDB's
 * runtime, when known.
 */
export async function saveStreamWindow(
  requests: readonly CapturedRequest[],
  from: { seconds: number; duration: number },
  expectedMinutes: number | null,
  io: SaveIo,
): Promise<SaveOutcome> {
  const found = await findPlaylist(requests, io, fitsTheFilm(from.duration, expectedMinutes))
  if ('reason' in found) return { ok: false, reason: found.reason }
  const { playlist, headers } = found

  const window = selectWindow(playlist, from.seconds, WINDOW_SECONDS)
  if (window === null) return { ok: false, reason: 'past-the-end' }

  // fMP4 when the playlist names an initialisation segment, MPEG-TS otherwise:
  // decided from the playlist, so every name is known before a byte arrives.
  const expected = window.segments[0]!.map ? 'm4s' : 'ts'
  const names = new Map<string, string>()
  window.extras.forEach((url, i) => names.set(url, window.segments.some((s) => s.map?.url === url) ? `m${i}.mp4` : `k${i}.key`))
  window.segments.forEach((s, i) => names.set(s.url, `s${i}.${expected}`))
  const nameOf = (url: string): string => names.get(url)!

  let bytes = 0
  for (const url of window.extras) {
    const got = await io.download(url, headers, nameOf(url))
    if (got === null || got.status !== 200) return { ok: false, reason: 'key-or-map-unreachable' }
    bytes += got.bytes
  }

  // A few at a time: the preview's plan waits for this window straight after
  // the player closes, so its download time is time to the first frame.
  // Sequential, the desktop took 2.1 s for VidSrc's six segments.
  const results = await inParallel(window.segments, DOWNLOADS_AT_ONCE, async (segment) => {
    const got = await io.download(segment.url, headers, nameOf(segment.url))
    const good = got !== null && (got.status === 200 || got.status === 206) && got.bytes > 0
    // An error page or a picture served in the segment's place is not video,
    // and neither is a segment of a different kind than its playlist says.
    // Encrypted segments are opaque bytes, so only the clear ones are sniffed.
    return good && (segment.key !== null || segmentExtension(got.head) === expected) ? got.bytes : null
  })
  /** The segments that arrived, in order, up to the first that did not: what is kept. */
  const kept: StreamWindow['segments'] = []
  for (const [i, segment] of window.segments.entries()) {
    if (results[i] === null || results[i] === undefined) break
    kept.push(segment)
  }
  // Every file written counts against the budget, played or not: a segment
  // after a failed one arrived all the same.
  for (const size of results) bytes += size ?? 0
  if (kept.length === 0) return { ok: false, reason: 'segments-unreachable' }
  const last = kept[kept.length - 1]!
  const endSeconds = last.start + last.seconds
  if (endSeconds - window.startSeconds < MIN_KEPT_SECONDS) return { ok: false, reason: 'too-little' }

  await io.writeText('index.m3u8', windowPlaylist({ ...window, segments: kept, endSeconds }, playlist.version, nameOf))
  return { ok: true, startSeconds: window.startSeconds, endSeconds, bytes }
}
