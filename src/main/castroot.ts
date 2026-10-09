/**
 * Which of a source's captured requests is the stream to cast: its root.
 *
 * One choice, for both platforms' casts (`castservice.ts`, `bridge/cast.ts`)
 * and for the cast check during a test (`castcheck.ts`), so what a test
 * checks is what a cast would send. Pure over an injected fetch, like
 * `hlsrewrite.ts`, so it is tested without a network and runs on the phone.
 *
 * ## Why the choice is not "the newest playlist" any more (2026-10-09)
 *
 * Until 2.0.19 the cast took the newest capture that answered as a playlist,
 * and failing that a whole file, with nothing checked past the first bytes.
 * The newest playlist a page fetched is often not the stream to hand over:
 *
 * - **a rendition of a master**: the audio of `#EXT-X-MEDIA TYPE=AUDIO` is
 *   fetched after the master and its variant, so it is newer than both, and
 *   a receiver handed it plays sound over a black screen, if anything;
 *   subtitles likewise;
 * - **one variant**, when the master that lists them all was right there;
 * - **an advert**: adverts are served as HLS too, and a pre-roll's playlist
 *   is fetched first and played first.
 *
 * And a whole file was taken with no check at all: VidLux's 297 MB "episode"
 * of Silo was a decoy clip. The desktop's sniff read the whole response, so a
 * real film timed out and only a file small enough to arrive in seconds (an
 * advert's) could be chosen.
 *
 * ## The rule
 *
 * Every candidate is asked for again with its own headers, its opening read
 * (`PEEK_BYTES`), a playlist in full. Then, in this order:
 *
 * 1. **A whole MP4/WebM file**: one that is not a piece of a stream
 *    (`isWholeVideoFile`), at least `MIN_WHOLE_FILE_BYTES` where its size is
 *    known, and whose length (its `mvhd`, read from its head) fits the
 *    title. The order is the one casts always had: a file is the shorter
 *    path, and which gives the better picture is not measured.
 * 2. **A master playlist**, whose first variant (where an HLS player starts)
 *    answers and runs as long as the title.
 * 3. **A media playlist** that is not a rendition a master lists as audio or
 *    subtitles, does not list audio or subtitle files for segments, and runs
 *    as long as the title.
 *
 * Within each, the newest capture first. "As long as the title" is
 * `lengthVerdict`: within the band around TMDB's runtime when it is known,
 * and at least ten minutes when it is not.
 */

import { lengthVerdict, type RuntimeVerdict } from '@shared/runtimecheck'
import { readInitSegmentCodecs, readMovieDuration } from '@shared/initsegment'
import { masterVariantDetails, readMediaPlaylist, type MediaPlaylist, type VariantDetails } from '@shared/streamquality'
import { streamHeaderOf } from '@shared/streamheader'
import { readTransportStreamCodecs } from '@shared/transportstream'
import { streamSignature, type StreamSignature } from '@shared/streamsignature'
import { isCastableFileType } from '@shared/castability'
import { isMasterPlaylist, isPlaylist, isWholeVideoFile } from './hlsrewrite'
import { MIN_WHOLE_FILE_BYTES } from './mediarequest'

/** A request the source's page made, with the headers to replay for it. */
export interface RootCandidate {
  url: string
  headers: Record<string, string>
}

/** What a fetch for the root choice answered. */
export interface FetchedText {
  status: number
  contentType: string
  /** The whole body's size, from `Content-Range` or a 200's `Content-Length`; null when the server did not say. */
  totalBytes: number | null
  body: string
}

/** The network, as each platform reaches it with a source's headers. */
export interface RootFetch {
  /** The first `limitBytes` of a URL as text; null when it could not be reached. */
  text(url: string, headers: Record<string, string>, limitBytes: number): Promise<FetchedText | null>
  /** The first `limitBytes` of a URL as bytes (the caller sets any `Range`); null when unreachable. */
  bytes(url: string, headers: Record<string, string>, limitBytes: number): Promise<{ status: number; bytes: Uint8Array } | null>
}

/**
 * How much of a candidate is read to tell what it is. A playlist announces
 * itself in its first line, and a piece of fMP4 its `moof` in its first boxes.
 * A playlist cut off here is read again whole (`PLAYLIST_BYTES`).
 */
export const PEEK_BYTES = 16 * 1024

/** The most of a playlist read: a feature-length VOD playlist runs to a few hundred kilobytes. */
export const PLAYLIST_BYTES = 2 * 1024 * 1024

/** How much of a whole file's head is read for its `moov`: its length and its codecs. */
export const FILE_HEAD_BYTES = 64 * 1024

/**
 * How many candidates are asked about, newest first. The capture keeps forty,
 * most of them a page's API calls and adverts; the chain that leads to the
 * stream is among the newest.
 */
const MAX_CANDIDATES = 24

/** Candidates asked about at once: a beam should not take a request's round trip per candidate. */
const AT_ONCE = 4

/**
 * Extensions that are never a root: segments (the capture drops them on both
 * platforms, but a test's log keeps them), and the page's own files.
 */
const NEVER_ROOT = /\.(ts|m4s|aac|mp3|vtt|srt|webvtt|js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|html?)(\?|$)/i

/** A media playlist whose segments are these is audio or subtitles alone. */
const AUDIO_SEGMENT = /\.(aac|mp3|ac3|ec3|eac3|m4a)(\?|$)/i
const SUBTITLE_SEGMENT = /\.(vtt|webvtt|srt)(\?|$)/i

/** The stream chosen, with what was read on the way to it. */
export type CastRoot =
  | {
      kind: 'hls'
      url: string
      headers: Record<string, string>
      /** The master's variant the receiver starts on, when the root is a master. */
      variant: VariantDetails | null
      /** The media playlist the receiver plays: the root itself, or that variant. */
      mediaUrl: string
      media: MediaPlaylist
      seconds: number
      length: RuntimeVerdict
    }
  | {
      kind: 'progressive'
      url: string
      headers: Record<string, string>
      totalBytes: number | null
      /** The file's head, for its codecs; null when it could not be read. */
      head: Uint8Array | null
      seconds: number | null
      length: RuntimeVerdict
    }

/** Why a candidate was passed over: what the cast and the cast check say when nothing is left. */
export type PassedOver =
  | { why: 'status'; status: number }
  | { why: 'length'; seconds: number }
  | { why: 'small'; bytes: number }
  | { why: 'rendition' }
  | { why: 'dash' }

export interface RootChoice {
  root: CastRoot | null
  passedOver: PassedOver[]
  /** Every playlist body read, by URL, for the bundle to reuse rather than fetch again. */
  bodies: Map<string, string>
}

/** Whether a captured URL could be a root at all, by its name. */
export function couldBeRoot(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return !NEVER_ROOT.test(parsed.pathname)
  } catch {
    return false
  }
}

interface Sniffed {
  candidate: RootCandidate
  answer: FetchedText | null
}

/**
 * Choose the stream to cast from a page's captured requests, newest first;
 * see the header.
 *
 * `deadline` (a time, by `now`) stops asking about further candidates once
 * it has passed, and chooses from those already asked: the cast check's
 * budget (`castcheck.ts`). A cast has none: a beam waits for its answer.
 */
export async function chooseCastRoot(
  candidates: readonly RootCandidate[],
  io: RootFetch,
  runtimeMinutes: number | null,
  limits: { deadline?: number; now?: () => number } = {},
): Promise<RootChoice> {
  const passedOver: PassedOver[] = []
  const bodies = new Map<string, string>()
  const seen = new Set<string>()
  const asked = candidates.filter((c) => {
    if (!couldBeRoot(c.url) || seen.has(c.url)) return false
    seen.add(c.url)
    return true
  }).slice(0, MAX_CANDIDATES)

  const now = limits.now ?? Date.now
  const inTime = (): boolean => limits.deadline === undefined || now() < limits.deadline
  const sniffed = await inBatches(asked, AT_ONCE, inTime, async (candidate): Promise<Sniffed> => {
    const answer = await io.text(candidate.url, candidate.headers, PEEK_BYTES).catch(() => null)
    // A playlist cut off by the peek is read whole: its length is every segment's.
    if (answer && isOk(answer.status) && isPlaylist(answer.body) && answer.body.length >= PEEK_BYTES) {
      const whole = await io.text(candidate.url, candidate.headers, PLAYLIST_BYTES).catch(() => null)
      if (whole && isOk(whole.status)) return { candidate, answer: whole }
    }
    return { candidate, answer }
  })

  const files: Sniffed[] = []
  const masters: Sniffed[] = []
  const media: Sniffed[] = []
  for (const entry of sniffed) {
    const answer = entry.answer
    if (answer === null) continue
    if (!isOk(answer.status)) {
      passedOver.push({ why: 'status', status: answer.status })
      continue
    }
    if (isPlaylist(answer.body)) {
      bodies.set(entry.candidate.url, answer.body)
      ;(isMasterPlaylist(answer.body) ? masters : media).push(entry)
    } else if (/<MPD[\s>]/.test(answer.body)) {
      passedOver.push({ why: 'dash' })
    } else if (isCastableFileType(answer.contentType) && isWholeVideoFile(answer.body)) {
      files.push(entry)
    }
  }

  for (const entry of files) {
    const root = await wholeFile(entry, io, runtimeMinutes, passedOver)
    if (root) return { root, passedOver, bodies }
  }

  const renditions = renditionUrls(masters)
  for (const entry of masters) {
    const root = await masterRoot(entry, io, runtimeMinutes, bodies, passedOver)
    if (root) return { root, passedOver, bodies }
  }

  for (const entry of media) {
    const url = entry.candidate.url
    const playlist = readMediaPlaylist(entry.answer!.body)
    if (renditions.has(url) || isRenditionOnly(playlist)) {
      passedOver.push({ why: 'rendition' })
      continue
    }
    const length = lengthVerdict(playlist.seconds, runtimeMinutes)
    if (length === 'implausible') {
      passedOver.push({ why: 'length', seconds: playlist.seconds })
      continue
    }
    return {
      root: { kind: 'hls', url, headers: entry.candidate.headers, variant: null, mediaUrl: url, media: playlist, seconds: playlist.seconds, length },
      passedOver,
      bodies,
    }
  }
  return { root: null, passedOver, bodies }
}

/** A whole file as the root, if it passes; see rule 1. */
async function wholeFile(
  entry: Sniffed,
  io: RootFetch,
  runtimeMinutes: number | null,
  passedOver: PassedOver[],
): Promise<CastRoot | null> {
  const totalBytes = entry.answer!.totalBytes
  if (totalBytes !== null && totalBytes < MIN_WHOLE_FILE_BYTES) {
    passedOver.push({ why: 'small', bytes: totalBytes })
    return null
  }
  const { url, headers } = entry.candidate
  const head = await io
    .bytes(url, { ...headers, Range: `bytes=0-${FILE_HEAD_BYTES - 1}` }, FILE_HEAD_BYTES)
    .catch(() => null)
  const bytes = head && isOk(head.status) ? head.bytes : null
  // A file keeping its moov at its end says nothing of its length here: unknown, not wrong.
  const seconds = bytes ? readMovieDuration(bytes) : null
  const length = seconds === null ? 'unknown' : lengthVerdict(seconds, runtimeMinutes)
  if (length === 'implausible') {
    passedOver.push({ why: 'length', seconds: seconds! })
    return null
  }
  return { kind: 'progressive', url, headers, totalBytes, head: bytes, seconds, length }
}

/** A master as the root, if its first variant answers and fits; see rule 2. */
async function masterRoot(
  entry: Sniffed,
  io: RootFetch,
  runtimeMinutes: number | null,
  bodies: Map<string, string>,
  passedOver: PassedOver[],
): Promise<CastRoot | null> {
  const { url, headers } = entry.candidate
  // The first variant listed is where an HLS player starts (RFC 8216 4.3.4.2);
  // the next is tried only when that one does not answer.
  for (const variant of masterVariantDetails(entry.answer!.body, url).slice(0, 2)) {
    const known = bodies.get(variant.url)
    const answer = known !== undefined ? { status: 200, body: known } : await io.text(variant.url, headers, PLAYLIST_BYTES).catch(() => null)
    if (answer === null) continue
    if (!isOk(answer.status)) {
      passedOver.push({ why: 'status', status: answer.status })
      continue
    }
    if (!isPlaylist(answer.body)) continue
    bodies.set(variant.url, answer.body)
    const media = readMediaPlaylist(answer.body)
    const length = lengthVerdict(media.seconds, runtimeMinutes)
    if (length === 'implausible') {
      passedOver.push({ why: 'length', seconds: media.seconds })
      return null
    }
    return { kind: 'hls', url, headers, variant, mediaUrl: variant.url, media, seconds: media.seconds, length }
  }
  return null
}

/**
 * The playlists the masters list as renditions: `#EXT-X-MEDIA` lines of type
 * AUDIO, SUBTITLES or CLOSED-CAPTIONS with a URI, made absolute.
 */
function renditionUrls(masters: readonly Sniffed[]): Set<string> {
  const urls = new Set<string>()
  for (const { candidate, answer } of masters) {
    for (const line of answer!.body.split(/\r?\n/)) {
      if (!line.startsWith('#EXT-X-MEDIA:')) continue
      if (!/(?:^|[:,])TYPE=(AUDIO|SUBTITLES|CLOSED-CAPTIONS)(?:,|$)/.test(line)) continue
      const uri = /(?:^|[:,])URI="([^"]+)"/.exec(line)?.[1]
      if (!uri) continue
      try {
        urls.add(new URL(uri, candidate.url).toString())
      } catch {
        // A URI that will not resolve names nothing that was captured.
      }
    }
  }
  return urls
}

/** A media playlist of audio or subtitle files alone, by its first segment's name. */
function isRenditionOnly(playlist: MediaPlaylist): boolean {
  const first = playlist.firstSegment
  if (first === null) return false
  const path = first.split('?')[0] ?? first
  return AUDIO_SEGMENT.test(path) || SUBTITLE_SEGMENT.test(path)
}

/**
 * The root's signature as far as its master and one header can tell: the
 * variant's `CODECS`, and its init segment or its first segment's opening;
 * for a whole file, its head. What a cast files with the television's answer
 * (`castanswer.ts`), so a refusal is filed under the class of what was
 * refused; the cast check reads a whole segment instead (`castcheck.ts`).
 */
export async function rootSignature(root: CastRoot, io: RootFetch): Promise<StreamSignature> {
  if (root.kind === 'progressive') {
    return streamSignature({ file: root.head ? readInitSegmentCodecs(root.head) : null })
  }
  const evidence = { variant: root.variant, keyMethod: root.media.keyMethod, initSegment: root.media.init !== null }
  const header = streamHeaderOf(root.media, root.mediaUrl)
  if (header === null) return streamSignature(evidence)
  const { offset, length } = header.range
  const answer = await io
    .bytes(header.url, { ...root.headers, Range: `bytes=${offset}-${offset + length - 1}` }, length)
    .catch(() => null)
  if (!answer || !isOk(answer.status)) return streamSignature(evidence)
  // An encrypted TS segment is noise until decrypted; its master and key method still say what they say.
  if (header.source === 'init') return streamSignature({ ...evidence, init: readInitSegmentCodecs(answer.bytes) })
  if (root.media.keyMethod !== null) return streamSignature(evidence)
  return streamSignature({ ...evidence, segment: readTransportStreamCodecs(answer.bytes) })
}

/** Why nothing could be cast, in words, from what was passed over; null when nothing explains it. */
export function rootRefusal(passedOver: readonly PassedOver[], providerName: string, runtimeMinutes: number | null): string | null {
  const wrongLength = passedOver.find((p): p is Extract<PassedOver, { why: 'length' }> => p.why === 'length')
  if (wrongLength) {
    const minutes = Math.max(1, Math.round(wrongLength.seconds / 60))
    const expected = runtimeMinutes === null ? '' : ` where the title runs ${runtimeMinutes} min`
    return `${providerName} serves a ${minutes} min video here${expected}, not the title. Try another source.`
  }
  if (passedOver.some((p) => p.why === 'rendition')) {
    return `${providerName} hands out only a separate sound or subtitle stream. Try another source.`
  }
  return null
}

function isOk(status: number): boolean {
  return status === 200 || status === 206
}

/** `work` over the items, `size` at a time, the results in the items' order; no new batch once `goOn` says not. */
async function inBatches<T, R>(items: readonly T[], size: number, goOn: () => boolean, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  for (let i = 0; i < items.length && goOn(); i += size) {
    results.push(...(await Promise.all(items.slice(i, i + size).map(work))))
  }
  return results
}
