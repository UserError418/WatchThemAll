/**
 * What a hidden probe session on the phone saw, turned into a verdict and a
 * reason.
 *
 * Pure, so `scanjudge.test.ts` can pin the cases without a device. The loop
 * that gathers the observations is `scan.ts`.
 *
 * The *stream* rule is the phone's own and unchanged by the move to hidden
 * sessions: a playlist, a segment or a confirmed whole file in the session's
 * log — or the page's own report that a video started — is a stream. The
 * desktop now asks for video itself (`streamverdict.ts`); agreed with the owner
 * 2026-09-26 that this stays a desktop rule. What the phone gains is the
 * desktop's *reasons* for everything else, and with them the desktop's reds:
 * "timeout (20 s)" sorts with the reds, as the owner asked, instead of the amber
 * "may work" the phone used to give any page that made a request.
 */

import type { ProbeVerdict, ScanReason } from '@shared/ipc'
import { verdictForReason } from '@shared/scanreason'
import type { ProbeDocumentError, ProbeRequest } from './probeview'

/**
 * A request finished this recently before the deadline means the page was
 * still working on it: a timeout rather than a page that found nothing.
 * The desktop's figure (`STILL_LOADING_WINDOW_MS` in `streamverdict.ts`),
 * copied rather than imported because that module's neighbours are Electron's.
 */
export const STILL_LOADING_WINDOW_MS = 3_000

/**
 * Requests that are never a stream and never lead to one, by extension.
 *
 * `MediaCapture.IGNORED_EXTENSIONS`, less the segment types: that buffer drops
 * segments to keep a cast's playlist from being pushed out, while here a
 * segment is evidence. A session's log holds everything the page asked for,
 * so without this the few fetches a probe may spend on opaque requests would
 * go on scripts and fonts.
 */
const NEVER_MEDIA = /\.(js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|html?|vtt|srt)(\?|$)/i

/**
 * Whether a request is worth fetching to see if it is a stream.
 *
 * The same test `MediaCapture.record` applies before keeping a request for a
 * cast: a GET over http(s), from the provider rather than the shell the probe
 * frames it in, and not something an extension already rules out.
 */
export function isScanCandidate(request: Pick<ProbeRequest, 'url' | 'method' | 'mainFrame'>): boolean {
  if (request.mainFrame) return false
  if (request.method.toUpperCase() !== 'GET') return false
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return !NEVER_MEDIA.test(url.pathname)
}

/** What one probe saw, when it did not find a stream. */
export interface MissedStream {
  /** The provider's own document failed, if it did. */
  documentError: ProbeDocumentError | null
  /** When the page last made a request, or null if it made none. */
  lastRequestAtMs: number | null
  /** When the probe stopped looking. */
  endedAtMs: number
  /** The budget it had, for the timeout's wording. */
  budgetMs: number
}

/**
 * Why a probe found no stream, in the desktop's vocabulary (`ScanReason`).
 *
 * In the desktop's order of precedence (`classify` in `streamverdict.ts`):
 * the document itself failing first, then a page still busy at the deadline,
 * then a page that went quiet with nothing to show.
 */
export function missedStreamReason(missed: MissedStream): ScanReason {
  const error = missed.documentError
  if (error) {
    if (error.status === 0) return { kind: 'unreachable' }
    if (error.status === 403) return { kind: 'blocked' }
    if (error.status >= 500) return { kind: 'error', status: error.status }
  }
  const stillLoading =
    missed.lastRequestAtMs !== null && missed.endedAtMs - missed.lastRequestAtMs < STILL_LOADING_WINDOW_MS
  if (stillLoading) return { kind: 'timeout', seconds: Math.round(missed.budgetMs / 1000) }
  return { kind: 'no-stream' }
}

/** The verdict and reason for a probe that found no stream. */
export function judgeMissedStream(missed: MissedStream): { verdict: ProbeVerdict; reason: ScanReason } {
  const reason = missedStreamReason(missed)
  return { verdict: verdictForReason(reason), reason }
}
