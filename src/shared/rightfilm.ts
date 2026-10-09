/**
 * Whether what a source plays is the film, judged by its length.
 *
 * A test said green for any source that delivered video. Measured 2026-10-04:
 * VidRock served Fight Club as a 167 s and then a 272 s clip, and its test
 * said green both times; a play then filed the clip's place over the film's
 * (`isAdvertLength` in `resume.ts`). Downloads already refuse such a source
 * in words (`planDownload`). This is the same check for a test, sharing its
 * words, so the two say the same thing about the same stream.
 *
 * ## What a length is worth here
 *
 * Only a length the test is sure of counts: a media playlist's segments added
 * up, the length of what a streaming engine has loaded, or a `<video>`'s
 * duration. Zero, NaN and Infinity are not lengths. The rule is
 * `lengthVerdict`'s (`runtimecheck.ts`), with TMDB's runtime where the test
 * was given one, and so it inherits that rule's generosity: the band is wide,
 * and a different episode of similar length is never caught.
 *
 * ## Any fitting length wins
 *
 * A page shows several videos at once (an advert's frame beside the
 * player's) and asks for several playlists (audio, subtitles, an advert's).
 * One length that fits the title means the film is there, and the source is
 * judged as before. Only when every length the test is sure of is clearly
 * not the title does it say so. With none at all, it says nothing: no
 * evidence is not evidence of a wrong video.
 */

import { lengthVerdict } from './runtimecheck'
import { readMediaPlaylist } from './streamquality'
import type { ScanReason } from './types'

export type FilmLength =
  /** No length the test was sure of. Changes nothing. */
  | { kind: 'unknown' }
  /** At least one length fits the title. */
  | { kind: 'film' }
  /** Every length is clearly not the title; `seconds` is the longest of them. */
  | { kind: 'other'; seconds: number }

/** Whether a reported length is one at all: positive and finite. */
function isLength(seconds: number): boolean {
  return Number.isFinite(seconds) && seconds > 0
}

/**
 * Judge everything a test measured the length of against TMDB's runtime
 * (null when TMDB has none, and then `lengthVerdict`'s ten-minute floor).
 */
export function judgeFilmLength(lengths: readonly number[], expectedMinutes: number | null): FilmLength {
  const known = lengths.filter(isLength)
  if (known.length === 0) return { kind: 'unknown' }
  if (known.some((seconds) => lengthVerdict(seconds, expectedMinutes) !== 'implausible')) return { kind: 'film' }
  return { kind: 'other', seconds: Math.max(...known) }
}

/**
 * A media playlist's length, as the check may use it: its segments added up,
 * only when it was read to its `#EXT-X-ENDLIST`. A playlist cut short (read
 * up to a byte cap, as a test reads them) or a live one adds up to a fraction
 * of the stream, and a film's three-hour playlist read halfway would read as
 * something else. Null when it is not a whole playlist.
 */
export function playlistLength(body: string): number | null {
  if (!/^#EXT-X-ENDLIST/m.test(body)) return null
  const seconds = readMediaPlaylist(body).seconds
  return seconds > 0 ? seconds : null
}

/** "3 min", never "0 min": a video was measured, and a zero reads like a missing value. */
export function minutesText(seconds: number): string {
  return `${Math.max(1, Math.round(seconds / 60))} min`
}

/**
 * The words for a source playing something else, after its name: "plays
 * something else here (a 3 min video for a 139 min film)". Shared by the
 * Downloads tab's refusal and the test's reason, so the two never disagree.
 */
export function somethingElse(seconds: number, expectedMinutes: number | null, title: 'film' | 'episode'): string {
  const expected = expectedMinutes === null ? '' : ` for a ${expectedMinutes} min ${title}`
  return `plays something else here (a ${minutesText(seconds)} video${expected})`
}

/** A test's reason for a source whose video is not the title. See `ScanReason`. */
export function wrongVideoReason(
  found: Extract<FilmLength, { kind: 'other' }>,
  expectedMinutes: number | null,
  title: 'film' | 'episode',
): ScanReason {
  return { kind: 'wrong-video', seconds: Math.round(found.seconds), expectedMinutes, title }
}
