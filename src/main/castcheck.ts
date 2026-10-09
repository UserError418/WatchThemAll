/**
 * The cast check: a dry run of the cast path, made during a test.
 *
 * ## Why (the owner, 2026-10-09)
 *
 * A source that streams in its own page may still be one a television
 * cannot be given, for reasons a test never looked at:
 *
 * - the stream may not come out of the page: the cast proxy fetches every
 *   playlist, key and segment with one set of headers (the root's), where
 *   the page sent each request its own;
 * - it may be an advert or a decoy rather than the title;
 * - its codecs may be more than the television decodes: the owner's
 *   Chromecast refused Videasy's H.264 at 2160x1080.
 *
 * So after a source's verdict in a test, while the tokens in its captured
 * requests are fresh, the cast path is run without a television: the root a
 * cast would choose (`castroot.ts`), the bundle a cast would build, and the
 * proxy's own path to the receiver's first requests: the root playlist, its
 * first variant, any key and init segment, and one whole segment, timed. What
 * comes back (`CastCheck`) is filed on the test's result. It never changes
 * the verdict; the cast list holds it against the chosen television
 * (`castability.ts`).
 *
 * ## Cost
 *
 * Agreed: about 5–15 s on a full test, so roughly 0.5–3 s a streaming
 * source, capped near 6 s (`CAST_CHECK_BUDGET_MS`). The candidates' openings
 * and the playlists are a few small requests; one segment is a few
 * megabytes. A segment still arriving at the cap is judged by how far it got
 * (`paceOf`).
 *
 * ## The two keyholes
 *
 * Pure, so both platforms run it and the tests run it without a network. The
 * caller hands in the root choice's fetch (`RootFetch`, each candidate with
 * its own headers, as a cast asks) and a way to serve the bundle as the
 * proxy would (`CastPath`): the desktop a loopback `createCastProxy`, the
 * phone its native fetch with the root's headers, the client the phone's
 * proxy fetches with.
 */

import type { CastCheck } from '@shared/types'
import { readInitSegmentCodecs } from '@shared/initsegment'
import { segmentExtension } from '@shared/segmentwindow'
import { streamSignature } from '@shared/streamsignature'
import { disguisedStreamOffset, readTransportStreamCodecs } from '@shared/transportstream'
import { chooseCastRoot, PLAYLIST_BYTES, type CastRoot, type PassedOver, type RootCandidate, type RootFetch } from './castroot'
import { buildCastBundle, isMasterPlaylist, type CastBundle } from './hlsrewrite'

/** The longest a check should take, from its start: see the header. */
export const CAST_CHECK_BUDGET_MS = 6_000

/**
 * The least time a segment is given, however long the choice and the
 * playlists took: a check that never fetched one cannot say the stream came
 * through.
 */
const MIN_SAMPLE_MS = 3_000

/** How much of a whole file is fetched to time it: enough to measure a rate, little enough to be quick. */
export const FILE_SAMPLE_BYTES = 2 * 1024 * 1024

/** The most of a key or an init segment read: a key is 16 bytes, an init segment a few kilobytes. */
const DATA_BYTES = 1024 * 1024

/** One segment, or a whole file's opening, as the proxy served it, timed. */
export interface Sample {
  status: number
  contentType: string
  /** Bytes read before it ended or the deadline came. */
  bytes: number
  /** The whole body's size, when the source said. */
  totalBytes: number | null
  /** From asking to the last byte read. */
  elapsedMs: number
  /** Whether it all arrived before the deadline. */
  complete: boolean
  /** Its opening, up to `SAMPLE_HEAD_BYTES`: what is read for what it is. */
  head: Uint8Array
}

/** The opening of a sample kept for reading: a TS segment's tables and SPS, or a file's `moov`. */
export const SAMPLE_HEAD_BYTES = 64 * 1024

/** The stream as the receiver would reach it: the proxy's path, with its single set of headers. */
export interface CastPath {
  /** A playlist of the bundle, by id, as served to the receiver. */
  playlist(id: string): Promise<{ status: number; body: string } | null>
  /** A key or an init segment, by id, up to `limitBytes`. */
  data(id: string, limitBytes: number): Promise<{ status: number; bytes: Uint8Array } | null>
  /** A segment whole, or a range of a whole file, by id; gives up at `deadline` (a time), saying how far it got. */
  sample(id: string, request: { range?: { offset: number; length: number }; deadline: number }): Promise<Sample | null>
  close(): void
}

export interface CastCheckInput {
  /** What the test's page fetched, newest first, each with its own headers. */
  candidates: readonly RootCandidate[]
  /** TMDB's runtime, for whether the stream is the title; null when not known. */
  runtimeMinutes: number | null
  io: RootFetch
  /** Serve a bundle as the cast proxy would, with the root's headers. */
  open(bundle: CastBundle, headers: Record<string, string>): Promise<CastPath>
  now?: () => number
  budgetMs?: number
}

/** Run the cast path without a television; see the header. */
export async function checkCast(input: CastCheckInput): Promise<CastCheck> {
  const now = input.now ?? Date.now
  const started = now()
  const choice = await chooseCastRoot(input.candidates, input.io, input.runtimeMinutes)
  const root = choice.root
  if (root === null) return unrooted(choice.passedOver)

  const found: CastCheck = { reach: 'ok', identity: root.length === 'plausible' ? 'film' : 'unknown' }
  if (root.seconds !== null) found.seconds = root.seconds

  // The bundle a cast would build: every playlist with the root's headers alone.
  let refusal: number | null = null
  let bundle: CastBundle
  try {
    bundle = await buildCastBundle(root.url, root.kind, async (url) => {
      const known = choice.bodies.get(url)
      if (known !== undefined) return known
      const answer = await input.io.text(url, root.headers, PLAYLIST_BYTES)
      refusal = answer === null ? 0 : isOk(answer.status) ? null : answer.status
      if (refusal !== null) throw new Error('the source refused a playlist')
      return answer!.body
    })
  } catch {
    return { ...found, reach: 'blocked', status: refusal ?? 0 }
  }

  const path = await input.open(bundle, root.headers)
  try {
    const deadline = Math.max(started + (input.budgetMs ?? CAST_CHECK_BUDGET_MS), now() + MIN_SAMPLE_MS)
    return root.kind === 'progressive' ? await checkFile(path, bundle, root, found, deadline) : await checkHls(path, bundle, root, found, deadline)
  } finally {
    path.close()
  }
}

/** What a check says when no stream could be chosen at all. */
function unrooted(passedOver: readonly PassedOver[]): CastCheck {
  const wrongLength = passedOver.find((p): p is Extract<PassedOver, { why: 'length' }> => p.why === 'length')
  if (wrongLength) return { reach: 'not-media', identity: 'wrong-length', seconds: wrongLength.seconds }
  const refused = passedOver.find((p): p is Extract<PassedOver, { why: 'status' }> => p.why === 'status')
  if (refused) return { reach: 'blocked', identity: 'unknown', status: refused.status }
  return { reach: 'not-media', identity: 'unknown' }
}

/**
 * An HLS root, as the receiver walks it: the root playlist, its first
 * variant when it is a master, the media playlist's key and init segment,
 * and its first segment.
 */
async function checkHls(path: CastPath, bundle: CastBundle, root: Extract<CastRoot, { kind: 'hls' }>, found: CastCheck, deadline: number): Promise<CastCheck> {
  const ids = new Set([...bundle.playlists.map((p) => p.id), ...bundle.targets.map((t) => t.id)])
  const idOf = (reference: string | null): string | null => {
    if (reference === null) return null
    const id = (reference.split('?')[0] ?? reference).replace(/\.m3u8$/, '')
    return ids.has(id) ? id : null
  }
  const blocked = (status: number | null): CastCheck => ({ ...found, reach: 'blocked', status: status ?? 0 })

  let playlist = await path.playlist(bundle.rootId)
  if (playlist === null || !isOk(playlist.status)) return blocked(playlist?.status ?? null)
  if (isMasterPlaylist(playlist.body)) {
    const variant = idOf(firstVariant(playlist.body))
    if (variant === null) return { ...found, reach: 'not-media' }
    playlist = await path.playlist(variant)
    if (playlist === null || !isOk(playlist.status)) return blocked(playlist?.status ?? null)
  }

  const media = openingOf(playlist.body)
  const segment = idOf(media.segment)
  if (segment === null) return { ...found, reach: 'not-media' }
  const key = media.keyMethod === 'AES-128' ? idOf(media.keyUri) : null
  if (key !== null) {
    const answer = await path.data(key, DATA_BYTES)
    if (answer === null || !isOk(answer.status)) return blocked(answer?.status ?? null)
  }
  let init = null
  const initId = idOf(media.initUri)
  if (initId !== null) {
    const answer = await path.data(initId, DATA_BYTES)
    if (answer === null || !isOk(answer.status)) return blocked(answer?.status ?? null)
    init = readInitSegmentCodecs(answer.bytes)
  }

  const sample = await path.sample(segment, { deadline })
  if (sample === null || !isOk(sample.status)) return blocked(sample?.status ?? null)
  // A segment in the clear must be media: TS (behind any disguise) or a piece of fMP4.
  // An encrypted one is noise until decrypted, and is judged by its answer alone.
  const encrypted = media.keyMethod !== null
  const clear = sample.head.subarray(disguisedStreamOffset(sample.head))
  if (sample.complete && sample.bytes === 0) return { ...found, reach: 'not-media' }
  if (!encrypted && clear.length > 0 && segmentExtension(clear) === null) return { ...found, reach: 'not-media' }

  const signature = streamSignature({
    variant: root.variant,
    keyMethod: media.keyMethod,
    initSegment: media.initUri !== null,
    init,
    segment: init === null && !encrypted ? readTransportStreamCodecs(clear) : null,
  })
  return judged({ ...found, signature }, paceOf(sample, media.seconds))
}

/** A whole file: its opening through the proxy, timed against how much film that many bytes hold. */
async function checkFile(path: CastPath, bundle: CastBundle, root: Extract<CastRoot, { kind: 'progressive' }>, found: CastCheck, deadline: number): Promise<CastCheck> {
  const length = Math.min(FILE_SAMPLE_BYTES, root.totalBytes ?? FILE_SAMPLE_BYTES)
  const sample = await path.sample(bundle.rootId, { range: { offset: 0, length }, deadline })
  if (sample === null || !isOk(sample.status)) return { ...found, reach: 'blocked', status: sample?.status ?? 0 }
  if (sample.bytes === 0 || !looksLikeVideoFile(sample.head)) return { ...found, reach: 'not-media' }

  const signature = streamSignature({ file: readInitSegmentCodecs(root.head ?? sample.head) })
  // The seconds of film the bytes read hold, at the file's average rate:
  // whether or not the deadline cut the sample, they took the time they took.
  const filmSeconds = root.totalBytes !== null && root.seconds !== null && root.totalBytes > 0 ? sample.bytes / (root.totalBytes / root.seconds) : 0
  return judged({ ...found, signature }, paceOf({ ...sample, complete: true }, filmSeconds))
}

/** The check with its pace, slow past one: a segment that takes longer to arrive than to play cannot keep up. */
function judged(check: CastCheck, pace: number | null): CastCheck {
  if (pace === null) return check
  return { ...check, pace, ...(pace > 1 ? { reach: 'slow' } : {}) }
}

/**
 * Seconds to fetch per second of film, from a sample of `seconds` of film:
 * exact for one that arrived whole; for one the deadline cut off, the time
 * the whole would have taken at the rate so far, where its size is known,
 * or failing that the time spent, once that is already past its length.
 * Null when nothing says.
 */
export function paceOf(sample: Pick<Sample, 'bytes' | 'totalBytes' | 'elapsedMs' | 'complete'>, seconds: number): number | null {
  if (!(seconds > 0)) return null
  const spent = sample.elapsedMs / 1000
  let needed: number | null = null
  if (sample.complete) needed = spent
  else if (sample.totalBytes !== null && sample.bytes > 0) needed = (spent * sample.totalBytes) / sample.bytes
  else if (spent >= seconds) needed = spent
  return needed === null ? null : Math.round((needed / seconds) * 100) / 100
}

/** The first variant's URI in a master, as written: where a receiver starts. */
function firstVariant(master: string): string | null {
  let next = false
  for (const raw of master.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#EXT-X-STREAM-INF:')) next = true
    else if (next && line !== '' && !line.startsWith('#')) return line
  }
  return null
}

/** What the receiver needs first from a media playlist: its key, its init segment, its first segment and that segment's length. */
function openingOf(body: string): { keyMethod: string | null; keyUri: string | null; initUri: string | null; segment: string | null; seconds: number } {
  let keyMethod: string | null = null
  let keyUri: string | null = null
  let initUri: string | null = null
  let seconds = 0
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#EXT-X-KEY:')) {
      const method = /(?:^|[:,])METHOD=([^,]+)/.exec(line)?.[1] ?? null
      keyMethod = method === 'NONE' ? null : method
      keyUri = /(?:^|[:,])URI="([^"]*)"/.exec(line)?.[1] ?? null
    } else if (line.startsWith('#EXT-X-MAP:')) {
      initUri ??= /(?:^|[:,])URI="([^"]*)"/.exec(line)?.[1] ?? null
    } else if (line.startsWith('#EXTINF:')) {
      seconds = Number.parseFloat(line.slice('#EXTINF:'.length)) || 0
    } else if (line !== '' && !line.startsWith('#')) {
      return { keyMethod, keyUri, initUri, segment: line, seconds }
    }
  }
  return { keyMethod, keyUri, initUri, segment: null, seconds: 0 }
}

/** An MP4 (a box type in bytes 4–7) or a WebM (its EBML signature): not a web page answering for one. */
function looksLikeVideoFile(head: Uint8Array): boolean {
  if (head.length >= 8 && ['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(String.fromCharCode(...head.subarray(4, 8)))) return true
  return head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3
}

function isOk(status: number): boolean {
  return status === 200 || status === 206
}
