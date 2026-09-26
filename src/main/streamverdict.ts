/**
 * What a probe's observations add up to: the verdict, and why.
 *
 * Out of `streamprobe.ts` because that file imports Electron and so cannot be
 * tested, while these two functions decide every dot the user sees. Both are
 * pure over a `StreamProbeResult`.
 */

import type { ScanReason } from '@shared/types'
import type { StreamProbeResult, StreamVerdict } from './streamprobe'

/** Words a challenge or block page puts in its title. */
const BLOCK_PATTERN = /just a moment|attention required|access denied|verify you are human|cf-browser/i

/**
 * How recently the page must have finished a request, when the budget runs
 * out, to count as still loading rather than finished with nothing.
 *
 * The distinction is between "slow" and "gave up", which the user acts on
 * differently: CinemaOS makes 120–176 requests and streams after 35–60 s,
 * while VidFast answers one 500 and falls silent. Three seconds is several
 * polls of a player's own retry loop, and far longer than the gap between the
 * requests of a page that is actually working.
 */
export const STILL_LOADING_WINDOW_MS = 3_000

/**
 * Turn the observations into a verdict.
 *
 * Ordered most-conclusive first. Video that arrived outranks every other
 * signal — a provider that served it while also 403-ing an analytics call is
 * working, and reporting it as blocked would delete a good entry. A refused
 * segment is next: it is the provider saying no to the video itself, which
 * no amount of waiting changes. Only then does "still busy" become a timeout —
 * ahead of a backend error, because a page still loading after one of its
 * lookups failed is usually trying the next source: VidLux fails two of its
 * extractors within a second on every title, then plays.
 */
export function classify(result: StreamProbeResult, documentTitle: string): StreamVerdict {
  if (result.videoArrived) return 'stream'

  if (result.error && result.documentStatus === null) return 'unreachable'
  if (result.documentStatus !== null && result.documentStatus >= 500) return 'unreachable'
  if (result.documentStatus === 403 || BLOCK_PATTERN.test(documentTitle)) return 'blocked'
  if (result.refusedSegments.length > 0) return 'refused'
  if (result.stillLoading) return 'timeout'
  if (result.apiErrors.length > 0) return 'api-error'

  /**
   * The threshold between "a shell with nothing behind it" and "a real page
   * that could not find this title".
   *
   * A working embed page issues dozens of requests — scripts, styles, its own
   * API. Single digits means nothing ran, which is a dead entry rather than a
   * catalogue gap, and the two want different fixes: one gets removed, the
   * other gets retried with a different title.
   */
  if (result.requestCount <= 3) return 'empty'

  return 'no-media'
}

/**
 * Why a probe that did not stream failed, in the terms the user is shown.
 *
 * `timeoutMs` is the budget this probe had, which is what "timeout (20 s)"
 * reports. A document that answered 5xx is an `error` with its status rather
 * than "unreachable", because the host was reached and said no. Null for a
 * stream, which needs no explanation.
 */
export function streamReason(result: StreamProbeResult, timeoutMs: number): ScanReason | null {
  switch (result.verdict) {
    case 'stream':
      return null
    case 'refused': {
      // A 4xx is the provider saying no to the video; a 5xx is its server
      // failing, which is a different sentence. VidSrc PM's segment proxy
      // answers 503 in bursts, for a whole title at a time.
      const status = result.refusedSegments.find((code) => code < 500) ?? result.refusedSegments[0] ?? 403
      return status >= 500 ? { kind: 'error', status } : { kind: 'refused', status }
    }
    case 'timeout':
      return { kind: 'timeout', seconds: Math.round(timeoutMs / 1000) }
    case 'api-error':
      return { kind: 'error', status: worstStatus(result.apiErrors.map((e) => e.status)) }
    case 'unreachable':
      return result.documentStatus !== null && result.documentStatus >= 500
        ? { kind: 'error', status: result.documentStatus }
        : { kind: 'unreachable' }
    case 'blocked':
      return { kind: 'blocked' }
    case 'no-template':
      return { kind: 'unsupported' }
    case 'empty':
    case 'no-media':
      return { kind: 'no-stream' }
  }
}

/** The status to name when a page failed several ways: a server error over a client one. */
function worstStatus(statuses: number[]): number {
  return statuses.find((status) => status >= 500) ?? statuses[0] ?? 500
}
