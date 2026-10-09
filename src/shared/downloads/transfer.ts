/**
 * Fetching a planned stream into a download's folder: plain HTTP with the
 * source's captured headers, nothing decoding, and nothing that depends on
 * the source's page still being open.
 *
 * ## Polite
 *
 * `LANES` segments at a time, which overlaps the round trips without
 * crowding the connection a film may be playing over; each failure retried
 * after a growing pause. One download runs at a time (`manager.ts`).
 *
 * ## Resumable
 *
 * The folder is the truth about what is done: a segment is written whole or
 * not at all (`DownloadFiles.write`), so after a pause, a crash or a restart
 * the missing files are exactly what is left to fetch. Signed segment URLs
 * expire within hours; a 401/403/410 ends the run as `expired`, and the
 * manager captures the source again and resumes at the next missing segment.
 */

import { segmentExtension } from '../segmentwindow'
import { readStreamHeader } from '../streamheader'
import { ivFor } from './aes'
import { localPlaylist, mapName, PLAYLIST_FILE, segmentName, estimateBytes, type DownloadPlan } from './plan'

/** How a segment is decrypted: HLS's AES-128, CBC with PKCS#7 padding. */
export interface SegmentCrypt {
  key: Uint8Array
  iv: Uint8Array
}

/** A segment fetched into the folder and not yet under its name, as `stageSegment` reports it. */
export interface StagedSegment {
  status: number
  /** Its size in the clear; 0 when it did not decrypt or the status was not a success. */
  bytes: number
  /** Its first bytes in the clear (`HEAD_BYTES` in `staging.ts`), which is what the core judges it by. */
  head: Uint8Array
}

/** A platform's network and files for one download's folder. */
export interface DownloadFiles {
  /** A URL's bytes, fetched with these headers; null when it could not be reached (or was aborted). For keys and init segments, which are small. */
  fetchBytes(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ status: number; bytes: Uint8Array } | null>
  /**
   * Fetch a segment with these headers into the folder, decrypted when
   * `crypt` is given, and hold it aside until `commitSegment` or
   * `discardSegment`. Only the head comes back: on the phone the core runs
   * in the WebView, and a segment's megabytes stay on the native side.
   * Null when it could not be reached (or was aborted).
   */
  stageSegment(
    url: string,
    headers: Record<string, string>,
    name: string,
    crypt: SegmentCrypt | null,
    signal: AbortSignal,
  ): Promise<StagedSegment | null>
  /** Put the staged segment under `name`, whole, without its first `skip` bytes; its size. */
  commitSegment(name: string, skip: number): Promise<number>
  /** Drop the staged segment, if any. */
  discardSegment(name: string): Promise<void>
  /** The complete files in the folder, with their sizes. Files still being written are not listed. */
  list(): Promise<Array<{ name: string; bytes: number }>>
  /** Write `bytes` as `name`, whole or not at all: a crash must never leave half a file under the name. */
  write(name: string, bytes: Uint8Array): Promise<void>
  readText(name: string): Promise<string | null>
  writeText(name: string, text: string): Promise<void>
  remove(name: string): Promise<void>
}

export interface TransferProgress {
  segmentsDone: number
  segmentsTotal: number
  bytesDone: number
  /** What the whole will take, as far as can be told yet. */
  estimatedBytes: number | null
}

export interface TransferOptions {
  signal: AbortSignal
  onProgress: (progress: TransferProgress) => void
  /** A pause between retries; injected so tests do not wait. */
  sleep: (ms: number) => Promise<void>
  /**
   * Asked once, as soon as the whole download's size can be estimated: a
   * reason to refuse (no room on the disk), or null to carry on. Before the
   * first segment when the master stated a bit rate, after it otherwise.
   */
  roomFor: (estimatedBytes: number) => Promise<string | null>
}

export type TransferOutcome =
  /** `width` and `height`: the picture's, from the plan or else the stream's own header; null when neither said. */
  | { kind: 'done'; bytes: number; width: number | null; height: number | null }
  /** The signed URLs no longer open: capture the source again and resume. */
  | { kind: 'expired' }
  | { kind: 'failed'; reason: string }
  | { kind: 'aborted' }

/** Segments in flight at once: the owner's "few" (2026-10-04), as the preview cache measured it. */
export const LANES = 3

/** The pauses before each retry of a failed fetch: five tries in about forty seconds. */
export const RETRY_DELAYS_MS = [1_000, 3_000, 9_000, 27_000]

/**
 * The share of a stream's segments that may be gaps: answered with success
 * every time and never with video. Measured (Chernobyl S1E1 on VidSrc, 722
 * segments): two playlist entries named one URL that answers 200 with an
 * empty body, and the source's own player plays straight past them. Failing
 * the whole film at 720 of 722 over that helps nobody; more than a few such
 * holes is a broken stream, and the download fails as before.
 */
export const MAX_GAP_SHARE = 0.01
const MIN_GAPS_ALLOWED = 2

/** What a CDN answers once a signed URL has expired or been revoked. */
const EXPIRED_STATUSES = new Set([401, 403, 410])

/** One try at a fetch: done, expired, or worth another try for this reason. */
type Attempt<T> = { kind: 'ok'; value: T } | { kind: 'expired' } | { kind: 'retry'; why: string }

type Fetched<T> = { kind: 'ok'; value: T } | { kind: 'expired' } | { kind: 'failed'; why: string } | { kind: 'aborted' }

/**
 * Where an MPEG-TS segment starts: its first sync byte. Some sources disguise
 * segments as images, a PNG header in front of the transport stream, which
 * their own players skip and a native player does not. Three sync bytes 188
 * apart within the first few kilobytes are the stream's start; 0 when there
 * is no disguise, or no stream to find.
 */
export function transportStreamOffset(bytes: Uint8Array): number {
  if (bytes[0] === 0x47) return 0
  const limit = Math.min(bytes.length - 377, 4096)
  for (let i = 1; i < limit; i++) {
    if (bytes[i] === 0x47 && bytes[i + 188] === 0x47 && bytes[i + 376] === 0x47) return i
  }
  return 0
}

/** The segment from its stream's start; see `transportStreamOffset`. */
export function transportStreamStart(bytes: Uint8Array): Uint8Array {
  const offset = transportStreamOffset(bytes)
  return offset === 0 ? bytes : bytes.subarray(offset)
}

function isSuccess(status: number): boolean {
  return status === 200 || status === 206
}

function describe(status: number | null): string {
  return status === null ? 'no connection' : `HTTP ${status}`
}

/** Fetch the plan's missing files into the folder. */
export async function runTransfer(plan: DownloadPlan, files: DownloadFiles, options: TransferOptions): Promise<TransferOutcome> {
  // Ours to stop early (an expired URL, a failure), and the viewer's (pause, delete).
  const halt = new AbortController()
  const onAbort = (): void => halt.abort()
  if (options.signal.aborted) return { kind: 'aborted' }
  options.signal.addEventListener('abort', onAbort)
  try {
    return await transfer(plan, files, options, halt)
  } finally {
    options.signal.removeEventListener('abort', onAbort)
    // Releases any retry still waiting.
    halt.abort()
  }
}

async function transfer(plan: DownloadPlan, files: DownloadFiles, options: TransferOptions, halt: AbortController): Promise<TransferOutcome> {
  const signal = halt.signal
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve()
      const done = (): void => resolve()
      signal.addEventListener('abort', done, { once: true })
      void options.sleep(ms).then(() => {
        signal.removeEventListener('abort', done)
        resolve()
      })
    })

  /** Try `attempt` until it succeeds or expires, with the growing pauses, five tries in all. */
  async function withRetry<T>(attempt: () => Promise<Attempt<T>>): Promise<Fetched<T>> {
    for (let tries = 0; ; tries++) {
      if (signal.aborted) return { kind: 'aborted' }
      const got = await attempt()
      if (signal.aborted) return { kind: 'aborted' }
      if (got.kind !== 'retry') return got
      if (tries >= RETRY_DELAYS_MS.length) return { kind: 'failed', why: got.why }
      await wait(RETRY_DELAYS_MS[tries]!)
    }
  }

  /** A small file's bytes, through `fetchBytes`, kept when `accept` says so. */
  const fetchSmall = (url: string, accept: (bytes: Uint8Array) => boolean): Promise<Fetched<Uint8Array>> =>
    withRetry<Uint8Array>(async () => {
      const got = await files.fetchBytes(url, plan.headers, signal)
      if (got !== null && EXPIRED_STATUSES.has(got.status)) return { kind: 'expired' }
      if (got === null || !isSuccess(got.status) || got.bytes.length === 0) return { kind: 'retry', why: describe(got?.status ?? null) }
      return accept(got.bytes) ? { kind: 'ok', value: got.bytes } : { kind: 'retry', why: 'not video' }
    })

  const present = new Map((await files.list()).map((f) => [f.name, f.bytes]))
  let bytesDone = [...present.values()].reduce((sum, n) => sum + n, 0)
  // The picture's size as the master stated it; the stream's own header
  // fills in what it did not, from the first segment's bytes.
  let height = plan.height
  let width = plan.height === null ? null : (plan.width ?? null)
  const noteHeader = (size: { width: number | null; height: number } | null): void => {
    if (size === null) return
    height = size.height
    width = size.width
  }
  const total = plan.segments.length
  const expected = plan.format === 'fmp4' ? 'm4s' : 'ts'

  // Initialisation segments first: every fMP4 segment needs one to play.
  for (const [i, url] of plan.maps.entries()) {
    const name = mapName(i)
    if (present.has(name)) continue
    const got = await fetchSmall(url, () => true)
    // Nothing else stops a run before the segments start: this is the viewer's pause.
    if (got.kind === 'aborted') return { kind: 'aborted' }
    if (got.kind === 'expired') return got
    if (got.kind === 'failed') return { kind: 'failed', reason: `The stream's start would not download (${got.why})` }
    await files.write(name, got.value)
    present.set(name, got.value.length)
    bytesDone += got.value.length
    if (i === 0 && height === null) noteHeader(readStreamHeader('init', got.value))
  }

  // Keys, fetched once each, when a segment first needs one: 16 raw bytes,
  // since the platform decrypts (natively, on the phone).
  const keys = new Map<string, Promise<Uint8Array | 'expired' | string>>()
  const keyFor = (url: string): Promise<Uint8Array | 'expired' | string> => {
    let key = keys.get(url)
    if (!key) {
      key = fetchSmall(url, (bytes) => bytes.length === 16).then((got) => {
        if (got.kind === 'expired') return 'expired'
        if (got.kind === 'ok') return got.value
        return got.kind === 'failed' ? (got.why === 'not video' ? 'not a key' : got.why) : 'stopped'
      })
      keys.set(url, key)
    }
    return key
  }

  const missing = plan.segments.map((_, i) => i).filter((i) => !present.has(segmentName(i, plan.format)))
  let segmentsDone = total - missing.length
  /** Seconds and bytes fetched in this run, for an estimate when the master stated no bit rate. */
  let sample: { bytes: number; seconds: number } = { bytes: 0, seconds: 0 }
  let estimate = estimateBytes(plan, null)
  let roomAsked = false
  let failure: string | null = null
  let expired = false
  /** Segments the source answered but never with video; see `MAX_GAP_SHARE`. */
  const gaps = new Set<number>()
  const gapsAllowed = Math.max(MIN_GAPS_ALLOWED, Math.floor(total * MAX_GAP_SHARE))

  const report = (): void => options.onProgress({ segmentsDone, segmentsTotal: total, bytesDone, estimatedBytes: estimate })
  report()

  if (estimate !== null) {
    roomAsked = true
    const refusal = await options.roomFor(Math.max(0, estimate - bytesDone))
    if (refusal !== null) return { kind: 'failed', reason: refusal }
  }

  async function fetchSegment(index: number): Promise<void> {
    const segment = plan.segments[index]!
    const name = segmentName(index, plan.format)
    let key: Uint8Array | null = null
    if (segment.keyUrl !== null) {
      const found = await keyFor(segment.keyUrl)
      if (found === 'expired') {
        expired = true
        return halt.abort()
      }
      if (typeof found === 'string') {
        failure ??= `The stream's key would not download (${found})`
        return halt.abort()
      }
      key = found
    }
    const crypt = key === null ? null : { key, iv: ivFor(segment) }
    const got = await withRetry<{ skip: number; head: Uint8Array }>(async () => {
      const staged = await files.stageSegment(segment.url, plan.headers, name, crypt, signal)
      if (staged === null) return { kind: 'retry', why: describe(null) }
      if (isSuccess(staged.status) && staged.bytes > 0) {
        const skip = expected === 'ts' ? transportStreamOffset(staged.head) : 0
        const head = staged.head.subarray(skip)
        if (segmentExtension(head.subarray(0, 400)) === expected) return { kind: 'ok', value: { skip, head } }
      }
      await files.discardSegment(name)
      if (EXPIRED_STATUSES.has(staged.status)) return { kind: 'expired' }
      return { kind: 'retry', why: isSuccess(staged.status) ? 'not video' : describe(staged.status) }
    })
    if (got.kind === 'aborted') return void (await files.discardSegment(name))
    if (got.kind === 'expired') {
      expired = true
      return halt.abort()
    }
    if (got.kind === 'failed' && got.why === 'not video' && gaps.size < gapsAllowed) {
      gaps.add(index)
      return
    }
    if (got.kind === 'failed') {
      failure ??= `Segment ${index + 1} of ${total} would not download (${got.why})`
      return halt.abort()
    }
    if (signal.aborted) return void (await files.discardSegment(name))
    const size = await files.commitSegment(name, got.value.skip)
    if (index === 0 && height === null && plan.format === 'ts') noteHeader(readStreamHeader('segment', got.value.head))
    segmentsDone += 1
    bytesDone += size
    sample = { bytes: sample.bytes + size, seconds: sample.seconds + segment.seconds }
    if (plan.bandwidth === null) estimate = Math.max(bytesDone, estimateBytes(plan, sample) ?? 0)
    report()
    if (!roomAsked && estimate !== null) {
      roomAsked = true
      const refusal = await options.roomFor(Math.max(0, estimate - bytesDone))
      if (refusal !== null) {
        failure ??= refusal
        halt.abort()
      }
    }
  }

  let next = 0
  const lane = async (): Promise<void> => {
    while (next < missing.length && !signal.aborted) await fetchSegment(missing[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(LANES, missing.length) }, lane))

  if (options.signal.aborted) return { kind: 'aborted' }
  if (expired) return { kind: 'expired' }
  if (failure !== null) return { kind: 'failed', reason: failure }

  await files.writeText(PLAYLIST_FILE, localPlaylist(plan, gaps))
  const bytes = (await files.list()).reduce((sum, f) => sum + f.bytes, 0)
  return { kind: 'done', bytes, width, height }
}
