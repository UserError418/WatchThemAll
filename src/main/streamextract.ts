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

import { BrowserWindow } from 'electron'
import type { Provider } from '@shared/types'
import { applyBrowserIdentity, applyProviderReferer } from './identity'
import { clickCentre, clickPlayInFrames } from './pressplay'
import { renderTemplate } from './providers'
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
 * Is this request the media?
 *
 * Extension matching alone is not enough, and that cost a run: VidLux reported
 * `none` for twenty seconds because its manifest does not end in `.m3u8`.
 * Several providers proxy the stream through an extensionless API path, which
 * is why `streamprobe` looks at Chromium's own `resourceType` as well — the
 * broadest signal available, and one that does not depend on the URL's shape.
 */
function classify(url: string, resourceType: string): StreamKind | null {
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
): Promise<{ pageUrl: string | null; stream: CapturedStream | null; error: string | null }> {
  const pageUrl = renderTemplate(provider, {
    tmdbId: subject.tmdbId,
    imdbId: subject.imdbId,
    type: subject.type,
    season: subject.season ?? null,
    episode: subject.episode ?? null,
  })
  if (!pageUrl) return { pageUrl: null, stream: null, error: 'no template for this subject' }

  const partition = `extract-${provider.id}-${Date.now()}`
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      partition,
      // The same four settings `streamprobe` documents, and for the same
      // reasons: without `autoplayPolicy` the player never starts and no
      // manifest is ever requested, and a hidden window is throttled by
      // default — which defers exactly the timers these pages chain their
      // requests with. Measured: with the defaults, VidLux reported no media
      // in 20 seconds against the 1.4s the probe measures.
      webSecurity: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const started = Date.now()
  let found: CapturedStream | null = null

  try {
    const contents = win.webContents
    applyBrowserIdentity(contents.session)
    applyProviderReferer(contents.session, provider.rootUrl)
    // Popups here are ads, exactly as in the player.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))

    contents.session.webRequest.onSendHeaders((details) => {
      if (found) return
      const kind = classify(details.url, details.resourceType)
      if (!kind) return

      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(details.requestHeaders ?? {})) {
        if (HOP_BY_HOP.has(name.toLowerCase())) continue
        headers[name] = String(value)
      }
      found = { url: details.url, kind, headers, foundAtMs: Date.now() - started }
    })

    /**
     * Started, never awaited.
     *
     * `loadURL` resolves when the document settles, and these pages routinely
     * never settle — a stuck subframe or a pending ad request leaves the
     * promise hanging with no rejection. Awaiting it froze the first run on its
     * second provider until it was killed by hand. `streamprobe` makes the same
     * point about talking to hostile pages: the wait must be a deadline we own,
     * not a promise they control.
     */
    void win.loadURL(pageUrl).catch(() => {})

    /**
     * Press play, the way `streamprobe` does.
     *
     * Without this the measurement is wrong in the pessimistic direction, and
     * it was: four of eight providers reported `none` — no media URL at all —
     * because they resolve the stream only after a click on their own play
     * overlay, and nothing here ever clicked. `autoplayPolicy` removes
     * Chromium's *policy* block on autoplay; it does not touch a `<div>` the
     * provider draws over the video and waits on.
     *
     * Two presses, at the same offsets the probe uses: the first catches a page
     * that is already interactive, the second a slow one whose player had not
     * mounted yet.
     */
    const press = (): void => {
      clickCentre(win.webContents, 1280, 720)
      void clickPlayInFrames(win.webContents)
    }
    const clicks = [setTimeout(press, 2_500), setTimeout(press, 6_000)]

    // Poll rather than race a promise, for the same reason: the manifest
    // arrives from a chain of the page's own requests, with no event of ours to
    // hang a resolution on.
    const deadline = Date.now() + timeoutMs
    while (!found && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    for (const timer of clicks) clearTimeout(timer)

    return { pageUrl, stream: found, error: null }
  } catch (error) {
    return { pageUrl, stream: null, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/**
 * How long any one verification request gets.
 *
 * These hosts are under no obligation to answer, and `fetch` without a signal
 * waits forever. A run of fifteen providers that stalls on the third measures
 * nothing and looks like it is still working, which is the failure mode worth
 * spending three lines to avoid.
 */
const VERIFY_TIMEOUT_MS = 20_000

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
): Promise<ExtractResult> {
  const { pageUrl, stream, error } = await capture(provider, subject, timeoutMs)

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
