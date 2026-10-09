/**
 * The desktop's network for choosing what to cast (`castroot.ts`): a
 * source's URL, asked for with the headers its page sent, read only as far
 * as asked.
 *
 * Only as far as asked, because a candidate may be a whole film. Until
 * 2.0.19 the cast read every candidate's whole body before looking at its
 * first bytes, under a 15-second timeout, so a real film timed out and was
 * skipped while an advert small enough to arrive in time was chosen.
 */

import type { FetchedText, RootFetch } from './castroot'
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
