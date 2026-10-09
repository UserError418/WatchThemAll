/**
 * The desktop's network for casting without a television: choosing what to
 * cast (`castroot.ts`), and the cast check's path through a proxy
 * (`castcheck.ts`).
 *
 * A source's URL is asked for with the headers its page sent and read only
 * as far as asked, because a candidate may be a whole film. Until 2.0.19 the
 * cast read every candidate's whole body before looking at its first bytes,
 * under a 15-second timeout, so a real film timed out and was skipped while
 * an advert small enough to arrive in time was chosen.
 */

import type { CastPath, Sample } from './castcheck'
import { SAMPLE_HEAD_BYTES } from './castcheck'
import { createCastProxy } from './castproxy'
import { PLAYLIST_BYTES, type FetchedText, type RootFetch } from './castroot'
import type { CastBundle } from './hlsrewrite'
import { totalBytesOf } from './mediarequest'

/** How long a source may take to answer one of these. */
const FETCH_TIMEOUT_MS = 15_000

/** The first `limitBytes` of a URL, with its status, type and the whole body's size where the server said. */
export async function fetchHead(
  url: string,
  headers: Record<string, string>,
  limitBytes: number,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<{ status: number; contentType: string; totalBytes: number | null; bytes: Uint8Array } | null> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    const chunks: Uint8Array[] = []
    let read = 0
    const reader = response.body?.getReader()
    while (reader && read < limitBytes) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      read += value.byteLength
    }
    await reader?.cancel().catch(() => {})
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      totalBytes: totalBytesOf(response.status, response.headers.get('content-range') ?? '', response.headers.get('content-length') ?? ''),
      bytes: Buffer.concat(chunks).subarray(0, limitBytes),
    }
  } catch {
    return null
  }
}

/** `RootFetch` over Node's fetch. */
export const desktopRootFetch: RootFetch = {
  async text(url, headers, limitBytes): Promise<FetchedText | null> {
    const head = await fetchHead(url, headers, limitBytes)
    return head && { status: head.status, contentType: head.contentType, totalBytes: head.totalBytes, body: new TextDecoder().decode(head.bytes) }
  },
  async bytes(url, headers, limitBytes) {
    const head = await fetchHead(url, headers, limitBytes)
    return head && { status: head.status, bytes: head.bytes }
  },
}

/**
 * The cast check's path (`CastPath`): the bundle served by a cast proxy of
 * its own, on loopback, so the check meets exactly what a receiver would:
 * the rewritten playlists, the one set of headers replayed upstream, the
 * disguise stripped, the body streamed. Its own instance, so a check never
 * touches a cast in progress, and several checks run side by side.
 */
export async function desktopCastPath(bundle: CastBundle, headers: Record<string, string>): Promise<CastPath> {
  const proxy = createCastProxy({ loopback: true })
  const base = await proxy.start({
    playlists: Object.fromEntries(bundle.playlists.map((p) => [p.id, p.body])),
    targets: Object.fromEntries(bundle.targets.map((t) => [t.id, t.url])),
    headers,
  })
  return {
    async playlist(id) {
      const answer = await fetchHead(`${base}${id}.m3u8`, {}, PLAYLIST_BYTES)
      return answer && { status: answer.status, body: new TextDecoder().decode(answer.bytes) }
    },
    async data(id, limitBytes) {
      const answer = await fetchHead(`${base}${id}`, {}, limitBytes)
      return answer && { status: answer.status, bytes: answer.bytes }
    },
    sample: (id, request) => timedSample(`${base}${id}`, request),
    close: () => proxy.stop(),
  }
}

/** One body fetched whole and timed, its opening kept; cut off at `deadline`, saying how far it got. */
async function timedSample(url: string, request: { range?: { offset: number; length: number }; deadline: number }): Promise<Sample | null> {
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(), Math.max(0, request.deadline - Date.now()))
  const startedAt = Date.now()
  const range = request.range ? { Range: `bytes=${request.range.offset}-${request.range.offset + request.range.length - 1}` } : undefined
  try {
    const response = await fetch(url, { headers: range, signal: stop.signal })
    const head: Uint8Array[] = []
    let headBytes = 0
    let bytes = 0
    let complete = false
    const reader = response.body?.getReader()
    try {
      for (;;) {
        if (!reader) {
          complete = true
          break
        }
        const { done, value } = await reader.read()
        if (done) {
          complete = true
          break
        }
        bytes += value.byteLength
        if (headBytes < SAMPLE_HEAD_BYTES) {
          head.push(value)
          headBytes += value.byteLength
        }
      }
    } catch {
      // The deadline: what arrived is what there is to judge.
    }
    await reader?.cancel().catch(() => {})
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      bytes,
      totalBytes: totalBytesOf(response.status, response.headers.get('content-range') ?? '', response.headers.get('content-length') ?? ''),
      elapsedMs: Date.now() - startedAt,
      complete,
      head: Buffer.concat(head).subarray(0, SAMPLE_HEAD_BYTES),
    }
  } catch {
    // No answer before the deadline, or none at all.
    return null
  } finally {
    clearTimeout(timer)
  }
}
