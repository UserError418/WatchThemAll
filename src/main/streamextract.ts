/**
 * Can we get the stream itself, rather than the page that plays it?
 *
 * ## The question this answers
 *
 * Every provider in the catalogue is an embed *page*: the app builds a URL and
 * loads their document, and their JavaScript resolves the actual media. That
 * model is why three features are missing everywhere and permanently — resume
 * to an exact position, stall detection, and the auto-switch countdown all need
 * to read a `<video>` that lives in a cross-origin document. On desktop
 * Electron can reach in (`WebFrameMain.executeJavaScript` runs in any frame);
 * nothing on Android can.
 *
 * If instead the app held the manifest URL, it would own the `<video>` element,
 * and all three would come back on both platforms. This module measures whether
 * that is possible, which is a question about third parties and therefore not
 * answerable by reading code.
 *
 * ## Why it has to be a real browser
 *
 * The same reason `streamprobe.ts` is: the document is a shell and the manifest
 * is resolved afterwards by the page's own script, usually through two or three
 * chained API calls. Fetching the document tells you nothing. So this loads the
 * page for real, watches every request, and captures the first media URL *with
 * the headers Chromium actually sent for it* — because the interesting question
 * is not "does a manifest exist" (`streamprobe` already answers that) but "is
 * that URL usable by anything other than the page that produced it".
 *
 * ## What a verdict means
 *
 * - `open` — the URL fetches with no headers at all. A player can use it.
 * - `header-gated` — needs the Referer/Origin the page sent. Still usable: our
 *   own request can set them. This is the expected common case.
 * - `sealed` — fails even with the captured headers. IP-bound, cookie-bound, or
 *   single-use. Not usable outside the page, so this provider stays an embed.
 * - `none` — no media request appeared at all. See `streamprobe` for why.
 */

import type { Provider } from '@shared/types'
import { probeStream } from './streamprobe'
import type { ProbeSubject } from './streamprobe'

/** HLS covers essentially this whole space; the rest are for the few outliers. */
const PROGRESSIVE_PATTERN = /\.(mp4|webm)(\?|$)/i

export type StreamKind = 'hls' | 'dash' | 'progressive'

export type ExtractVerdict = 'open' | 'header-gated' | 'sealed' | 'none'

/** One media URL, and everything needed to ask for it again. */
export interface CapturedStream {
  url: string
  kind: StreamKind
  /**
   * The headers Chromium sent, minus the hop-by-hop ones.
   *
   * Captured from `onSendHeaders` rather than `onBeforeSendHeaders` so that
   * `Cookie` is present — the network stack adds it after the earlier event,
   * and a provider that gates on a session cookie would otherwise look `open`
   * in this measurement and fail in production.
   */
  headers: Record<string, string>
  /** Milliseconds from navigation start, for a sense of how deep the chain is. */
  foundAtMs: number
}

export interface ExtractResult {
  providerId: string
  providerName: string
  pageUrl: string | null
  verdict: ExtractVerdict
  stream: CapturedStream | null
  /** Status of a bare fetch — no headers. Null when nothing was captured. */
  bareStatus: number | null
  /** Status of a fetch replaying the captured headers. */
  replayStatus: number | null
  /**
   * For HLS: did a variant playlist and then a segment also fetch?
   *
   * A master playlist that fetches while its segments do not is worthless, and
   * that split is realistic — providers commonly sign segment URLs separately.
   */
  segmentOk: boolean | null
  error: string | null
}

/**
 * How long to wait when asking for a URL ourselves, rather than watching the
 * page ask for it.
 *
 * Deliberately generous: several providers sign a manifest and its segments
 * separately and answer the second request slowly. It is a ceiling against a
 * provider that never answers at all, not a latency budget.
 */
const VERIFY_TIMEOUT_MS = 20_000

/** Headers a re-request must not replay verbatim. */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'content-length',
  'accept-encoding',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
])

/**
 * The headers a page sent, minus the ones a second request must not copy.
 *
 * Shared with the quality probe, which asks for playlists again the same way:
 * two copies of this list would drift, and a header wrongly replayed there
 * reads as a sealed provider.
 */
export function replayableHeaders(headers: Record<string, string>): Record<string, string> {
  const replayable: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    replayable[name] = value
  }
  return replayable
}

/**
 * Is this request the media?
 *
 * Extension matching alone is not enough, and that cost a run: VidLux reported
 * `none` for twenty seconds because its manifest does not end in `.m3u8`.
 * Several providers proxy the stream through an extensionless API path, which
 * is why `streamprobe` looks at Chromium's own `resourceType` as well — the
 * broadest signal available, and one that does not depend on the URL's shape.
 */
function classify(url: string, resourceType: string, mime: string): StreamKind | null {
  // MIME first: it is the only signal that is right when the URL is an
  // extensionless proxy path, which is the common case for a manifest.
  if (/mpegurl/i.test(mime)) return 'hls'
  if (/dash\+xml/i.test(mime)) return 'dash'
  if (/\.m3u8(\?|$)|\/manifest|playlist/i.test(url)) return 'hls'
  if (/\.mpd(\?|$)/i.test(url)) return 'dash'
  if (PROGRESSIVE_PATTERN.test(url)) return 'progressive'
  // Chromium classified it as a media load but the URL says nothing. Treat it
  // as progressive: it is a single fetchable resource either way, and the
  // verification below is what actually decides whether it is usable.
  if (resourceType === 'media') return 'progressive'
  return null
}

/**
 * Load one provider's embed page and capture the first media URL it asks for.
 *
 * Its own session partition, as in `streamprobe`: a cookie or challenge token
 * carried over from the previous provider would decide this one's verdict.
 */
async function capture(
  provider: Provider,
  subject: ProbeSubject,
  timeoutMs: number,
  verbose = false,
): Promise<{ pageUrl: string | null; stream: CapturedStream | null; error: string | null }> {
  const started = Date.now()
  let stream: CapturedStream | null = null

  /**
   * The page loading, the clicking and the watching are `streamprobe`'s, not
   * ours.
   *
   * This file used to do all three itself, from the same recipe, and the copy
   * rotted: against Videasy the probe saw a manifest in under three seconds
   * while this saw three requests and a dead page. The two configurations
   * looked identical line by line and the difference was never found — which is
   * the whole argument for not having two. What is genuinely this module's own
   * question is everything below: whether the URL survives being asked for by
   * something that is not that page.
   */
  const result = await probeStream(provider, subject, {
    timeoutMs,
    verbose,
    onMedia: ({ url, headers, mime }) => {
      if (stream) return
      const kind = classify(url, 'media', mime)
      if (!kind) return
      stream = { url, kind, headers: replayableHeaders(headers), foundAtMs: Date.now() - started }
    },
  })

  return {
    pageUrl: result.url,
    stream,
    // A probe that failed to reach the page at all is worth reporting as such
    // rather than as "this provider has no usable stream".
    error: result.verdict === 'unreachable' || result.verdict === 'blocked' ? result.verdict : null,
  }
}

/** Fetch, returning the status alone; a thrown or timed-out request is 0. */
async function status(url: string, headers?: Record<string, string>): Promise<number> {
  try {
    const response = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    })
    // Drain, or the connection stays open and the run leaks sockets.
    await response.arrayBuffer().catch(() => new ArrayBuffer(0))
    return response.status
  } catch {
    return 0
  }
}

/**
 * Follow an HLS master playlist one level down and fetch a segment.
 *
 * Providers commonly sign the manifest and the segments separately, so a master
 * that fetches proves less than it looks like it does.
 */
async function segmentReachable(
  manifestUrl: string,
  headers: Record<string, string>,
): Promise<boolean> {
  try {
    const response = await fetch(manifestUrl, {
      headers,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    })
    if (!response.ok) return false
    const body = await response.text()
    const lines = body.split('\n').map((line) => line.trim())

    const firstUri = lines.find((line) => line.length > 0 && !line.startsWith('#'))
    if (!firstUri) return false

    const next = new URL(firstUri, manifestUrl).toString()
    // A master playlist points at another playlist; a media playlist points at
    // a segment. Either way the next hop is the thing that must be reachable.
    return (await status(next, headers)) === 200
  } catch {
    return false
  }
}

export async function extractStream(
  provider: Provider,
  subject: ProbeSubject,
  timeoutMs = 20_000,
  verbose = false,
): Promise<ExtractResult> {
  const { pageUrl, stream, error } = await capture(provider, subject, timeoutMs, verbose)

  const base: ExtractResult = {
    providerId: provider.id,
    providerName: provider.name,
    pageUrl,
    verdict: 'none',
    stream,
    bareStatus: null,
    replayStatus: null,
    segmentOk: null,
    error,
  }
  if (!stream) return base

  const bareStatus = await status(stream.url)
  const replayStatus = bareStatus === 200 ? bareStatus : await status(stream.url, stream.headers)

  const verdict: ExtractVerdict =
    bareStatus === 200 ? 'open' : replayStatus === 200 ? 'header-gated' : 'sealed'

  const segmentOk =
    verdict === 'sealed' || stream.kind !== 'hls'
      ? null
      : await segmentReachable(stream.url, verdict === 'open' ? {} : stream.headers)

  return { ...base, verdict, bareStatus, replayStatus, segmentOk }
}
