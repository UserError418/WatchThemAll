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
import { decryptSegment, importAesKey, ivFor } from './aes'
import { localPlaylist, mapName, PLAYLIST_FILE, segmentName, estimateBytes, type DownloadPlan } from './plan'

/** A platform's network and files for one download's folder. */
export interface DownloadFiles {
  /** A URL's bytes, fetched with these headers; null when it could not be reached (or was aborted). */
  fetchBytes(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ status: number; bytes: Uint8Array } | null>
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
  | { kind: 'done'; bytes: number; height: number | null }
  /** The signed URLs no longer open: capture the source again and resume. */
  | { kind: 'expired' }
  | { kind: 'failed'; reason: string }
  | { kind: 'aborted' }

/** Segments in flight at once: the owner's "few" (2026-10-04), as the preview cache measured it. */
export const LANES = 3

/** The pauses before each retry of a failed fetch: five tries in about forty seconds. */
export const RETRY_DELAYS_MS = [1_000, 3_000, 9_000, 27_000]

/** What a CDN answers once a signed URL has expired or been revoked. */
const EXPIRED_STATUSES = new Set([401, 403, 410])

type Fetched = { kind: 'ok'; bytes: Uint8Array } | { kind: 'expired' } | { kind: 'failed'; why: string } | { kind: 'aborted' }

/**
 * An MPEG-TS segment, from its first sync byte. Some sources disguise
 * segments as images, a PNG header in front of the transport stream, which
 * their own players skip and a native player does not. Three sync bytes 188
 * apart within the first few kilobytes are the stream's start.
 */
export function transportStreamStart(bytes: Uint8Array): Uint8Array {
  if (bytes[0] === 0x47) return bytes
  const limit = Math.min(bytes.length - 377, 4096)
  for (let i = 1; i < limit; i++) {
    if (bytes[i] === 0x47 && bytes[i + 188] === 0x47 && bytes[i + 376] === 0x47) return bytes.subarray(i)
  }
  return bytes
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

  async function fetchWithRetry(url: string, check: (bytes: Uint8Array) => Promise<Uint8Array | null>): Promise<Fetched> {
    let why: string
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) return { kind: 'aborted' }
      const got = await files.fetchBytes(url, plan.headers, signal)
      if (signal.aborted) return { kind: 'aborted' }
      if (got !== null && EXPIRED_STATUSES.has(got.status)) return { kind: 'expired' }
      if (got !== null && (got.status === 200 || got.status === 206) && got.bytes.length > 0) {
        const checked = await check(got.bytes)
        if (checked !== null) return { kind: 'ok', bytes: checked }
        why = 'not video'
      } else {
        why = describe(got?.status ?? null)
      }
      if (attempt >= RETRY_DELAYS_MS.length) return { kind: 'failed', why }
      await wait(RETRY_DELAYS_MS[attempt]!)
    }
  }

  const present = new Map((await files.list()).map((f) => [f.name, f.bytes]))
  let bytesDone = [...present.values()].reduce((sum, n) => sum + n, 0)
  let height = plan.height
  const total = plan.segments.length
  const expected = plan.format === 'fmp4' ? 'm4s' : 'ts'

  // Initialisation segments first: every fMP4 segment needs one to play.
  for (const [i, url] of plan.maps.entries()) {
    const name = mapName(i)
    if (present.has(name)) continue
    const got = await fetchWithRetry(url, async (bytes) => bytes)
    // Nothing else stops a run before the segments start: this is the viewer's pause.
    if (got.kind === 'aborted') return { kind: 'aborted' }
    if (got.kind === 'expired') return got
    if (got.kind === 'failed') return { kind: 'failed', reason: `The stream's start would not download (${got.why})` }
    await files.write(name, got.bytes)
    present.set(name, got.bytes.length)
    bytesDone += got.bytes.length
    if (i === 0 && height === null) height = readStreamHeader('init', got.bytes)?.height ?? null
  }

  // Keys, fetched once each, when a segment first needs one.
  const keys = new Map<string, Promise<CryptoKey | 'expired' | string>>()
  const keyFor = (url: string): Promise<CryptoKey | 'expired' | string> => {
    let key = keys.get(url)
    if (!key) {
      key = fetchWithRetry(url, async (bytes) => (bytes.length === 16 ? bytes : null)).then(async (got) => {
        if (got.kind === 'expired') return 'expired'
        if (got.kind !== 'ok') return got.kind === 'failed' ? got.why : 'stopped'
        return (await importAesKey(got.bytes)) ?? 'not a key'
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

  const report = (): void => options.onProgress({ segmentsDone, segmentsTotal: total, bytesDone, estimatedBytes: estimate })
  report()

  if (estimate !== null) {
    roomAsked = true
    const refusal = await options.roomFor(Math.max(0, estimate - bytesDone))
    if (refusal !== null) return { kind: 'failed', reason: refusal }
  }

  async function fetchSegment(index: number): Promise<void> {
    const segment = plan.segments[index]!
    let key: CryptoKey | null = null
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
    const got = await fetchWithRetry(segment.url, async (bytes) => {
      let clear = bytes
      if (key !== null) {
        const decrypted = await decryptSegment(bytes, key, ivFor(segment))
        if (decrypted === null) return null
        clear = decrypted
      }
      if (expected === 'ts') clear = transportStreamStart(clear)
      return segmentExtension(clear.subarray(0, 400)) === expected ? clear : null
    })
    if (got.kind === 'aborted') return
    if (got.kind === 'expired') {
      expired = true
      return halt.abort()
    }
    if (got.kind === 'failed') {
      failure ??= `Segment ${index + 1} of ${total} would not download (${got.why})`
      return halt.abort()
    }
    if (signal.aborted) return
    await files.write(segmentName(index, plan.format), got.bytes)
    if (index === 0 && height === null && plan.format === 'ts') height = readStreamHeader('segment', got.bytes)?.height ?? null
    segmentsDone += 1
    bytesDone += got.bytes.length
    sample = { bytes: sample.bytes + got.bytes.length, seconds: sample.seconds + segment.seconds }
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

  await files.writeText(PLAYLIST_FILE, localPlaylist(plan))
  const bytes = (await files.list()).reduce((sum, f) => sum + f.bytes, 0)
  return { kind: 'done', bytes, height }
}
