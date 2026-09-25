/**
 * Does this provider actually produce a *stream*?
 *
 * Everything cheaper than this lies. Measured against the shipped catalogue,
 * all fourteen providers answer a playback URL with HTTP 200 — including ones
 * that return a 655-byte stub. A `fetch` of the document tells you the domain
 * resolves and nothing else, because these are single-page apps: the document
 * is a shell, and the stream is resolved afterwards by the page's own
 * JavaScript. That is the failure the user sees as a black window with a play
 * button that never does anything.
 *
 * So the only honest test is to be a browser. Load the page for real, watch
 * every request it makes, and look for the one thing that cannot be faked: a
 * **media manifest or segment**. If the player asks for an `.m3u8`, the stream
 * exists. If it never does, it does not — whatever the document status said.
 *
 * This is deliberately NOT a unit test. It is slow (seconds per provider),
 * needs the network, and depends on third parties who are under no obligation
 * to be up. It runs from `npm run probe:providers`, and its output is evidence
 * for changing the catalogue, not a gate that blocks a commit.
 *
 * @see scripts/probe-providers.mjs for the runner.
 */

import { BrowserWindow, session, type WebContents } from 'electron'
import type { Provider } from '@shared/types'
import { applyBrowserIdentity, applyProviderReferer } from './identity'
import { decide } from './adblock'
import { clickCentre, clickPlayInFrames } from './pressplay'
import { renderTemplate } from './providers'
import { isSameOrigin } from './sameorigin'
import { isMediaRequest } from './mediarequest'

/** What the probe concluded, worst last so a sort puts good providers first. */
export type StreamVerdict =
  /** A media manifest or segment was requested — the stream is real. */
  | 'stream'
  /** The player's own backend answered, but no media followed. Usually a catalogue gap. */
  | 'no-media'
  /** The page loaded but made no meaningful requests at all. A shell with nothing behind it. */
  | 'empty'
  /** The provider's own API returned an error status. */
  | 'api-error'
  /** A bot check, a 403, or a challenge page. */
  | 'blocked'
  /** The document itself failed: DNS, TLS, connection refused, 5xx. */
  | 'unreachable'
  /** The template could not produce a URL for this request at all. */
  | 'no-template'

export interface StreamProbeResult {
  providerId: string
  providerName: string
  /** The URL that was actually loaded, or null when no template applied. */
  url: string | null
  verdict: StreamVerdict
  /** Status of the document response, or null if it never completed. */
  documentStatus: number | null
  /** Where the document ended up, when the provider redirected. Null if it did not. */
  redirectedTo: string | null
  /** Milliseconds from navigation start to the first media request. */
  timeToMediaMs: number | null
  /** Total requests the page made, as a sanity check on `empty`. */
  requestCount: number
  /** The media URLs seen, truncated — the evidence behind a `stream` verdict. */
  mediaSamples: string[]
  /** Failing requests to the provider's own origin, which is what `api-error` means. */
  apiErrors: { url: string; status: number }[]
  /** Populated for `unreachable`; the Chromium error description. */
  error: string | null
}

/**
 * Recognising a stream now lives in `mediarequest.ts`, which has no imports.
 *
 * It was defined here and could not be shared, because this file imports
 * Electron — so the phone and the Python probe each grew their own copy and
 * the copies drifted. Re-exported rather than merely imported, so the existing
 * callers that reach for it here keep working.
 */
export { isMediaRequest } from './mediarequest'

/** Words a challenge or block page puts in its title. */
const BLOCK_PATTERN = /just a moment|attention required|access denied|verify you are human|cf-browser/i

export interface ProbeOptions {
  /**
   * How long to watch after the document finishes loading.
   *
   * Providers chain several requests before reaching a manifest — resolve the
   * title, pick a server, fetch the source — and on a slow one that chain has
   * been measured at over eight seconds. Cutting it short reports a working
   * provider as broken, which is the more expensive mistake here: it would
   * delete a good entry from the catalogue.
   */
  timeoutMs?: number
  /** Log every request as it happens. Useful when a provider's verdict is surprising. */
  verbose?: boolean
  /**
   * Wrap the provider URL the way the player does before loading it.
   *
   * Without this the probe measures a path the app no longer takes. Providers
   * that insist on being framed answer 403 to a top-level navigation, so the
   * probe would report a working source as dead — and, once one of them
   * relaxes the rule, the reverse.
   */
  frameUrl?: (providerUrl: string) => string
  /**
   * Called once, with the first media response and the headers that fetched it.
   *
   * Exists so `streamextract` can ask its question — "is that URL usable by
   * anything other than the page that produced it" — without owning a second
   * copy of "load a provider page and watch its requests". It had one, and the
   * two drifted badly: this file reported Videasy streaming ten times out of
   * ten while the extractor's copy saw three requests and gave up. Several
   * hours went into finding the difference and it was never found, which is
   * the argument for there being one implementation rather than a better
   * diff.
   */
  onMedia?: (media: { url: string; headers: Record<string, string>; mime: string }) => void
  /**
   * Called for every completed response, with the headers that fetched it.
   *
   * For the quality probe, which needs every playlist a player asks for rather
   * than the first media request: a player fetches the master first and a
   * variant after it, and some fetch a variant directly and never the master.
   */
  onResponse?: (response: ProbeResponse) => void
  /**
   * Keep watching this long after the first media request, instead of stopping
   * at it. Zero, the default, is what the scan wants: the first manifest
   * settles the verdict. The quality probe lingers, because the renditions and
   * the decoded picture arrive after it.
   */
  lingerMs?: number
  /**
   * Look inside the page once watching is over, before the window is torn
   * down. Must bound its own time: the page is hostile and still running.
   */
  inspect?: (contents: WebContents) => Promise<void>
}

/** One completed response, as `onResponse` sees it. */
export interface ProbeResponse {
  url: string
  statusCode: number
  resourceType: string
  mime: string
  /** What Chromium sent for it, `Cookie` included. Empty if the send was not seen. */
  headers: Record<string, string>
}

/**
 * The request under test: a title that definitely exists, so a `no-media`
 * verdict means the provider is broken rather than the title being obscure.
 */
export interface ProbeSubject {
  imdbId: string
  tmdbId: number
  type: 'tv' | 'movie'
  season?: number
  episode?: number
  /** For the report, so a failure names something a human recognises. */
  label: string
  /**
   * What TMDB says this runs for, in minutes, or null when unsure.
   *
   * Only used to notice a provider serving something *else* — see
   * `runtimecheck.ts`. Null is the honest entry for a title whose runtime was
   * not looked up: an invented number would condemn providers over a guess.
   */
  runtimeMinutes?: number | null
}

/**
 * Load one provider in a real browser and report whether a stream appeared.
 *
 * Each probe gets its own session partition. Sharing one would let a cookie or
 * a cached challenge token from a previous provider decide the next one's
 * verdict, and the whole point is to measure each independently.
 */
export async function probeStream(
  provider: Provider,
  subject: ProbeSubject,
  options: ProbeOptions = {},
): Promise<StreamProbeResult> {
  const { timeoutMs = 12_000, verbose = false, frameUrl, onMedia, onResponse, lingerMs = 0, inspect } = options

  /**
   * A watchdog the page cannot outlive.
   *
   * Everything inside `runProbe` is meant to finish on a deadline, but it talks
   * to Electron APIs that talk to a hostile third-party page, and several of
   * those can block indefinitely — `clearStorageData` on a partition with live
   * connections did exactly that, and creating a second window after a page
   * with a stuck subframe did it again. Each of those was findable and fixable,
   * but the class of bug is not: a probe of untrusted pages must be structurally
   * incapable of hanging, or one bad provider silently costs the entire run.
   *
   * The partial result is still worth reporting — it carries the requests seen
   * so far, which is usually enough to classify.
   */
  const partial: { current: StreamProbeResult | null } = { current: null }
  const watchdogMs = (timeoutMs + lingerMs) * 2 + 8_000

  return Promise.race([
    runProbe(
      provider,
      subject,
      { timeoutMs, verbose, lingerMs, frameUrl, onMedia, onResponse, inspect },
      partial,
    ),
    new Promise<StreamProbeResult>((resolve) =>
      setTimeout(() => {
        const result = partial.current
        if (!result) {
          resolve({
            providerId: provider.id,
            providerName: provider.name,
            url: null,
            verdict: 'unreachable',
            documentStatus: null,
            redirectedTo: null,
            timeToMediaMs: null,
            requestCount: 0,
            mediaSamples: [],
            apiErrors: [],
            error: `probe exceeded ${watchdogMs}ms watchdog`,
          })
          return
        }
        result.error ??= `probe exceeded ${watchdogMs}ms watchdog`
        result.verdict = result.mediaSamples.length > 0 ? 'stream' : result.verdict
        resolve(result)
      }, watchdogMs),
    ),
  ])
}

/** The options that are callbacks, and so stay optional past the defaults. */
type Hook = 'frameUrl' | 'onMedia' | 'onResponse' | 'inspect'

async function runProbe(
  provider: Provider,
  subject: ProbeSubject,
  // Defaults are resolved by the caller. The hooks stay optional because
  // absence is a meaningful choice for each — "do not wrap this URL", "nobody
  // is listening" — rather than a value somebody forgot to pass.
  options: Required<Omit<ProbeOptions, Hook>> & Pick<ProbeOptions, Hook>,
  partial: { current: StreamProbeResult | null },
): Promise<StreamProbeResult> {
  const { timeoutMs, verbose, lingerMs, frameUrl, onMedia, onResponse, inspect } = options

  const base: StreamProbeResult = {
    providerId: provider.id,
    providerName: provider.name,
    url: null,
    verdict: 'no-template',
    documentStatus: null,
    redirectedTo: null,
    timeToMediaMs: null,
    requestCount: 0,
    mediaSamples: [],
    apiErrors: [],
    error: null,
  }

  const url = renderTemplate(provider, {
    imdbId: subject.imdbId,
    tmdbId: subject.tmdbId,
    type: subject.type,
    season: subject.season ?? null,
    episode: subject.episode ?? null,
  })
  if (!url) return base
  base.url = url
  partial.current = base

  const partition = `probe-${provider.id}-${Date.now()}`
  const probeSession = session.fromPartition(partition)
  applyBrowserIdentity(probeSession)
  applyProviderReferer(probeSession, provider.rootUrl)

  /**
   * The same ad rules the player runs.
   *
   * Without this the probe measures a pipeline no user ever has: the player
   * cancels requests and the probe did not, so a rule that killed a stream
   * would pass the health check and still break the app. `WTA_ADBLOCK=0`
   * disables both together, which is what makes "is it the blocker?"
   * answerable by running the probe twice.
   */
  if (process.env.WTA_ADBLOCK !== '0') {
    probeSession.webRequest.onBeforeRequest((details, callback) => {
      const decision = decide({
        url: details.url,
        resourceType: details.resourceType,
        pageOrigin: provider.rootUrl,
      })
      if (process.env.WTA_ADBLOCK_LOG === '1' && decision.blocked) {
        console.log(
          `[adblock] BLOCK ${decision.rule} ${details.resourceType} ${details.url.slice(0, 140)}`,
        )
      }
      callback({ cancel: decision.blocked })
    })
  }

  let providerOrigin: string
  try {
    providerOrigin = new URL(provider.rootUrl).origin
  } catch {
    providerOrigin = ''
  }

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      partition,
      // The page must be allowed to behave exactly as it would for a user, or
      // the probe measures our restrictions rather than the provider.
      webSecurity: false,
      autoplayPolicy: 'no-user-gesture-required',
      // A hidden window is throttled by default, and a throttled page defers
      // exactly the timers these players use to chain their requests — which
      // would make every provider look like `empty`.
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  /**
   * Refuse popups.
   *
   * The synthetic click below frequently lands on an ad overlay rather than a
   * play button, and these pages answer that by opening a new window. Left
   * unhandled, a full run accumulates dozens of them, each with its own
   * renderer process — which competes for the bandwidth the probe is measuring
   * and eventually exhausts memory.
   */
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const startedAt = Date.now()
  let firstMediaAt: number | null = null

  const filter = { urls: ['http://*/*', 'https://*/*'] }

  /**
   * Request headers, kept until the matching response arrives.
   *
   * `onSendHeaders` is the last event before the wire and the only one where
   * `Cookie` has been added, so it is the only honest source for "what did the
   * page actually send". The response is where the decision is made, hence the
   * handover.
   */
  const sentHeaders = new Map<string, Record<string, string>>()

  probeSession.webRequest.onSendHeaders(filter, (details) => {
    if (!onMedia && !onResponse) return
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(details.requestHeaders ?? {})) {
      headers[name] = String(value)
    }
    sentHeaders.set(details.url, headers)
    // These pages make hundreds of requests and one of them matters.
    if (sentHeaders.size > 500) {
      const oldest = sentHeaders.keys().next().value
      if (oldest !== undefined) sentHeaders.delete(oldest)
    }
  })

  let mediaReported = false

  probeSession.webRequest.onCompleted(filter, (details) => {
    base.requestCount += 1

    const mime = String(details.responseHeaders?.['content-type'] ?? details.responseHeaders?.['Content-Type'] ?? '')
    const looksLikeMedia = isMediaRequest(details.url, details.resourceType, mime)

    onResponse?.({
      url: details.url,
      statusCode: details.statusCode,
      resourceType: details.resourceType,
      mime,
      headers: sentHeaders.get(details.url) ?? {},
    })

    if (looksLikeMedia && details.statusCode < 400) {
      firstMediaAt ??= Date.now()
      if (base.mediaSamples.length < 4) base.mediaSamples.push(details.url.slice(0, 160))
      if (onMedia && !mediaReported) {
        mediaReported = true
        onMedia({ url: details.url, headers: sentHeaders.get(details.url) ?? {}, mime })
      }
    }

    /**
     * Failures from the provider's own backend are the actionable ones. A
     * third-party ad or analytics call failing says nothing about the stream.
     *
     * 429 is excluded deliberately. It is throttling, not breakage, and it
     * lands on exactly the requests that matter least: Videasy rate-limits its
     * own `/api/stats/hit` beacon after a handful of probe runs from one
     * address, which was enough to report a provider that loads perfectly as
     * `api-error` on all four canaries.
     */
    if (
      details.statusCode >= 400 &&
      details.statusCode !== 429 &&
      isSameOrigin(details.url, providerOrigin)
    ) {
      if (base.apiErrors.length < 6) base.apiErrors.push({ url: details.url.slice(0, 160), status: details.statusCode })
    }

    if (verbose) {
      console.error(`    ${details.statusCode} ${details.resourceType.padEnd(10)} ${details.url.slice(0, 120)}`)
    }
  })

  probeSession.webRequest.onErrorOccurred(filter, (details) => {
    base.requestCount += 1
    if (verbose) console.error(`    ERR ${details.error} ${details.url.slice(0, 120)}`)
  })

  /**
   * The ground truth, and the reason this probe can be trusted.
   *
   * Everything else here infers a stream from network traffic, and that
   * inference has a real hole: a player using Media Source Extensions feeds the
   * decoder from a blob, and one delivering segments over a WebSocket makes no
   * HTTP media request at all. Both would be reported as having no stream while
   * playing video perfectly — and on a catalogue where six entries were about
   * to be deleted, that is not an acceptable margin of error.
   *
   * `media-started-playing` fires when Chromium actually begins decoding, in
   * any frame, however the bytes arrived. It cannot be faked by a page and it
   * cannot be missed by a transport we did not anticipate.
   */
  win.webContents.on('media-started-playing', () => {
    firstMediaAt ??= Date.now()
    if (base.mediaSamples.length < 4) base.mediaSamples.push('[media element began playing]')
  })

  /**
   * Watch the provider's own document, wherever it ended up.
   *
   * With `frameUrl` in play the main frame is our local shell, which always
   * answers 200 — reading its status would report every provider as healthy
   * and every provider as having "moved" to `127.0.0.1`. So the status and the
   * redirect are taken from the first navigation that is *not* the shell,
   * which is the provider document whether it is framed or not.
   */
  const shellOrigin = frameUrl ? new URL(frameUrl(url)).origin : null
  const isShell = (candidate: string): boolean => {
    try {
      return shellOrigin !== null && new URL(candidate).origin === shellOrigin
    } catch {
      return false
    }
  }

  // Only the first non-shell frame: everything after it is the provider's own
  // ad and analytics iframes, and letting one of those overwrite the status
  // would paper a 403 over with somebody else's 200.
  let documentSeen = false
  win.webContents.on('did-frame-navigate', (_e, navigatedUrl, httpResponseCode) => {
    if (documentSeen || isShell(navigatedUrl)) return
    documentSeen = true
    base.documentStatus = httpResponseCode
    if (navigatedUrl !== url) base.redirectedTo = navigatedUrl
  })

  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
    // -3 is ERR_ABORTED, which fires during ordinary redirects.
    if (errorCode === -3) return
    base.error = `${errorCode} ${errorDescription}`
  })

  /**
   * Start the load but do NOT await it.
   *
   * `loadURL` resolves on `did-finish-load`, which waits for every subresource
   * — and these pages keep long-lived connections open for ads and analytics,
   * so on several providers it simply never settles. Awaiting it hangs the
   * probe forever on exactly the providers most worth measuring. The deadline
   * below is the only thing allowed to decide when we are done.
   */
  void win.loadURL(frameUrl ? frameUrl(url) : url).catch((err: unknown) => {
    base.error ??= err instanceof Error ? err.message : String(err)
  })

  /**
   * Click, the way a user would.
   *
   * The mechanics moved to `pressplay.ts` when the UI health check needed the
   * same behaviour, because a second copy is how two measurements of the same
   * thing start disagreeing — which had already happened here once, over the ad
   * rules. The reasoning for *why* both a synthetic mouse event and a per-frame
   * DOM click are needed lives there.
   */
  const press = (): void => {
    // Once something streams, a click on the centre of the player pauses it.
    // Only reachable while lingering; without a linger the watch ends first.
    if (firstMediaAt !== null) return
    clickCentre(win.webContents, 1280, 720)
    void clickPlayInFrames(win.webContents)
  }
  const clicks = [setTimeout(press, 2_500), setTimeout(press, 6_000)]

  // Watch until media appears or the budget runs out. Polling rather than an
  // event because the interesting outcome is the *absence* of a request, and
  // nothing fires for that.
  await new Promise<void>((resolve) => {
    const deadline = startedAt + timeoutMs
    const tick = setInterval(() => {
      const settled = firstMediaAt !== null && Date.now() >= firstMediaAt + lingerMs
      if (settled || Date.now() > deadline || win.isDestroyed()) {
        clearInterval(tick)
        resolve()
      }
    }, 250)
  })

  /**
   * The document title, used only to recognise a challenge page.
   *
   * Raced against a short timer for the same reason the load is not awaited: on
   * a page that is still busy, `executeJavaScript` queues behind whatever the
   * page is doing and can outlive the probe. A missing title costs us one
   * classification hint; a hang costs us the whole run.
   */
  for (const timer of clicks) clearTimeout(timer)

  let title = ''
  if (!win.isDestroyed()) {
    title = await Promise.race([
      win.webContents.executeJavaScript('document.title').catch(() => ''),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 1500)),
    ])
  }

  base.timeToMediaMs = firstMediaAt === null ? null : firstMediaAt - startedAt
  base.verdict = classify(base, title)

  if (inspect && !win.isDestroyed()) await inspect(win.webContents).catch(() => {})

  /**
   * Destroy on the next tick, never inline.
   *
   * `BrowserWindow.destroy()` tears down the renderer process synchronously,
   * and while it does, the main process's event loop does not run. Called
   * inline here that is not merely slow — it starves the *next* probe's
   * `setInterval`, which never fires, so the probe after this one waits on a
   * deadline that can never arrive. The whole run hangs on the second provider
   * and no timeout saves it, because the timeout is a timer too.
   *
   * Measured: with the destroy inline the run stopped dead at provider two;
   * deferred by a single tick, all fourteen complete.
   */
  setTimeout(() => destroyQuietly(win), 0)
  /**
   * No `clearStorageData()` here.
   *
   * It hangs indefinitely when the partition still has in-flight requests, and
   * these pages keep connections open for ads and analytics that never settle —
   * so awaiting it deadlocked the probe after the first subject. It is not
   * needed regardless: the partition name is unique per probe, so nothing
   * written to it is ever read again.
   */

  return base
}

/**
 * Turn the observations into a verdict.
 *
 * Ordered most-conclusive first. A stream that was seen outranks every other
 * signal — a provider that served media while also 403-ing an analytics call is
 * working, and reporting it as blocked would delete a good entry.
 */
function classify(result: StreamProbeResult, documentTitle: string): StreamVerdict {
  if (result.mediaSamples.length > 0) return 'stream'

  if (result.error && result.documentStatus === null) return 'unreachable'
  if (result.documentStatus !== null && result.documentStatus >= 500) return 'unreachable'
  if (result.documentStatus === 403 || BLOCK_PATTERN.test(documentTitle)) return 'blocked'
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
 * Close a probe window without letting its teardown become the next hang.
 *
 * `destroy()` is the forceful form on purpose — `close()` runs the page's own
 * unload handlers, and an embed page is under no obligation to return from one.
 */
function destroyQuietly(win: BrowserWindow): void {
  try {
    if (!win.isDestroyed()) win.destroy()
  } catch {
    // Already gone, or gone mid-call. Either way there is nothing to do.
  }
}
