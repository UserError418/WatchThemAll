/**
 * Is this request the stream?
 *
 * One definition, because there are now four places that ask and every copy so
 * far has drifted. `streamprobe.ts` owned it and could not share it — that file
 * imports Electron, so neither the phone nor a plain Node script can reach it —
 * and the copies that grew up around that are a matter of record:
 *
 *   - `streamextract.ts` had its own weaker version, which tested the URL and
 *     Chromium's `resourceType` but never the response's `Content-Type`. The
 *     result was two measurements of the same thing disagreeing: `streamprobe`
 *     reported Videasy streaming ten times out of ten while the extractor
 *     reported no media at all.
 *   - `scripts/android-provider-probe.py` carries a transcription of these two
 *     regexes with a comment asking whoever edits one to remember the other.
 *
 * So this file has no imports at all, which is the point: the desktop probe,
 * the phone's scan and anything else that has to recognise a stream can all
 * take the same answer from here.
 *
 * ## The three signals, and why none of them is enough alone
 *
 * `resourceType === 'media'` is whatever Chromium itself recognises as a video
 * or audio load. Broadest and cheapest, and it misses the most important case:
 * an HLS manifest fetched by hls.js over XHR is typed `xhr`, not `media`.
 *
 * The URL pattern catches those — until a provider serves its manifest from an
 * extensionless proxy path, which several do (`…/pl/H4sIAAAA…`,
 * `…/v1/proxy?data=…`). Then the URL says nothing.
 *
 * The MIME type is the one that settles those cases, and it is only available
 * on the *response*. A caller that has only the request must expect misses.
 */

/**
 * HLS and DASH cover essentially every embed provider in this space; the
 * MP4/WebM/MKV cases are the few that serve progressive files. `/segment` and
 * `/manifest` catch the extensionless proxy paths that name themselves.
 *
 * Those two must be a whole path segment. Unanchored, they matched VidZee's
 * intro-skip API (`…/introdb/segments?imdb_id=…`), which it calls on every
 * title within a second of loading — so "Test all sources" reported VidZee
 * streaming on four of five canaries where its only playlist had failed, and
 * timed it at 0.8 s. The same looseness matched any page's web-app manifest
 * (`/manifest.json`). A false green is the cheaper mistake, but not free: it
 * puts a dead source at the top of the list.
 *
 * MKV is here because ScreenScape serves whole films as `.mkv`
 * (`…/movies/1999/fightclub.mkv`). The desktop never needed the extension —
 * the response's `video/…` type caught it — but the phone's capture buffer
 * holds only URLs, so without it the phone's scan watched ScreenScape play and
 * reported that nothing had streamed.
 */
export const MEDIA_PATTERN = /\.(m3u8|mpd|ts|m4s|mp4|webm|mkv)(\?|$)|\/(segment|manifest)(\/|\?|$)/i

export const MEDIA_MIME = /^(application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)|video\/|audio\/)/i

/**
 * Is this request the media, by any of the three signals available?
 *
 * `mime` is empty at request time, and `resourceType` is unavailable anywhere
 * but Electron — both are optional so a caller holding only a URL, which is all
 * the Android capture buffer records, can still ask.
 */
export function isMediaRequest(url: string, resourceType = '', mime = ''): boolean {
  // Subtitles first: a `<track>` loads its file as resource type `media`, so
  // without this MoviesAPI's `…/subs/…/en.vtt` counted as its stream — and
  // timed it — on three titles out of three.
  if (SUBTITLE_URL.test(url) || SUBTITLE_MIME.test(mime)) return false
  return resourceType === 'media' || MEDIA_PATTERN.test(url) || MEDIA_MIME.test(mime)
}

const SUBTITLE_URL = /\.(vtt|srt|ass|ssa)(\?|$)/i
const SUBTITLE_MIME = /^text\/vtt|^application\/x-subrip/i

/** A whole video file by its name, as opposed to a playlist or a segment. */
export const WHOLE_FILE_URL = /\.(mp4|mkv|webm)(\?|$)/i

/**
 * Below this, a whole file is an ad or a placeholder, not a programme.
 *
 * The smallest real one in the catalogue is an anime episode of twenty-odd
 * minutes, which runs to tens of megabytes even at low quality; a pre-roll ad
 * is a few hundred kilobytes to a few megabytes.
 */
export const MIN_WHOLE_FILE_BYTES = 8 * 1024 * 1024

/**
 * A response that looked like a whole video and is not one.
 *
 * VidRock's player loads `vidrock.net/demo-video.mp4` into a `<video>` before
 * anything else, and Chromium receives 887 bytes of `text/html` for it. The
 * name says `.mp4` and the resource type says `media`, so it counted as a
 * stream: the scan timed VidRock at 0.7 s from it, and on a title where
 * nothing else loaded, painted VidRock green for streaming a web page.
 *
 * Only for a media element loading a whole file by name — `.mp4`, `.mkv`,
 * `.webm` with resource type `media`. Segments arrive by XHR and are small by
 * design, and an HLS playlist is legitimately served as `text/html` by some
 * providers, so neither is judged by this.
 *
 * `totalBytes` is the whole file's size — from `Content-Range` on the 206 a
 * media element's first request gets — or null when the response did not say.
 */
export function isFalseWholeFile(
  url: string,
  resourceType: string,
  mime: string,
  totalBytes: number | null,
): boolean {
  if (resourceType !== 'media' || !WHOLE_FILE_URL.test(url)) return false
  if (/^text\/html/i.test(mime.trim())) return true
  return totalBytes !== null && totalBytes < MIN_WHOLE_FILE_BYTES
}

/** A response's full size from its headers: `Content-Range`'s total, else a 200's `Content-Length`. */
export function totalBytesOf(status: number, contentRange: string, contentLength: string): number | null {
  const total = /\/(\d+)\s*$/.exec(contentRange)
  if (total) return Number(total[1])
  const length = Number(contentLength)
  return status === 200 && contentLength !== '' && Number.isFinite(length) ? length : null
}

/**
 * Is this *response* the media, from its type and its first bytes?
 *
 * For callers that can fetch a request but were never told its type — the
 * phone, whose capture buffer holds URLs and request headers and nothing from
 * the response. Some providers stream through nothing but opaque proxy paths:
 * 111Movies fetches every playlist and segment as `…/api?d=<token>`, so the
 * URL test above can never recognise it, while one fetch of the same URL
 * answers `application/vnd.apple.mpegurl` and `#EXTM3U`.
 *
 * The body check is there for providers that lie about the type. It is a
 * playlist's own opening line, so it is exact; segments are not sniffed by
 * content, because a segment disguised as `text/html` arrives alongside a
 * playlist that is not.
 */
export function isMediaResponse(contentType: string, body: string): boolean {
  return MEDIA_MIME.test(contentType.trim()) || body.trimStart().startsWith('#EXTM3U')
}

/**
 * Which part of a stream a media response is.
 *
 * `isMediaRequest` answers "is this the stream at all"; this answers the
 * question behind a green dot, which is sharper: **did video arrive?** A
 * playlist proves only that the provider found a stream. Videasy showed why
 * that is not enough: on Game of Thrones and Frieren its playlists loaded
 * cleanly, every segment they listed was refused with 403, and nothing ever
 * played — while the test, satisfied by the playlist, said "works". Agreed
 * on 2026-09-26: on the desktop, a source works when video arrives.
 *
 * - `playlist` — an HLS or DASH manifest, by name or by type.
 * - `file` — a whole video fetched by a media element (ScreenScape's `.mkv`).
 * - `segment` — everything else that is media: `.ts`, `.m4s`, fMP4 `.mp4`
 *   pieces fetched by the player's script, or any response typed video or
 *   audio. That last clause is what recognises segments behind opaque proxy
 *   paths, whose names say nothing.
 *
 * Null when the response is not media, or is the placeholder kind that only
 * looks like a whole file (`isFalseWholeFile`).
 */
export type MediaKind = 'playlist' | 'segment' | 'file'

const PLAYLIST_URL = /\.(m3u8|mpd)(\?|$)|\/manifest(\/|\?|$)/i
const PLAYLIST_MIME = /^application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)/i

export function mediaKind(
  url: string,
  resourceType: string,
  mime: string,
  totalBytes: number | null,
): MediaKind | null {
  if (!isMediaRequest(url, resourceType, mime)) return null
  if (isFalseWholeFile(url, resourceType, mime, totalBytes)) return null
  if (PLAYLIST_MIME.test(mime.trim()) || PLAYLIST_URL.test(url)) return 'playlist'
  if (resourceType === 'media') return 'file'
  return 'segment'
}
