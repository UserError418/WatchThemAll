/**
 * Browser identity — making the app's requests look like the browser the
 * providers expect.
 *
 * Embed providers block Electron. Not subtly: the default User-Agent contains
 * the literal string `Electron/42.5.0`, and refusing it is a one-line filter
 * that every one of them can afford. Cycle 1 dropped the original app's
 * spoofing and playback regressed.
 *
 * ## One identity, the engine's own
 *
 * What a page can see has to agree with what its requests say, because the
 * providers that check compare the two. The identity is therefore the browser
 * this really is — Chromium at Electron's own version, on the machine's own
 * platform — with only the two tokens that name the app removed (`Electron/…`
 * and `watchthemall/…`), in the reduced form Chrome itself sends
 * (`Chrome/148.0.0.0`). It is installed as the app-wide fallback
 * (`app.userAgentFallback`), so `navigator.userAgent` in every frame and the
 * header on every request carry the same string.
 *
 * Until 2.0.11 the app claimed a fixed Chrome 138 on Windows instead, with
 * hand-written client hints to match. Headers can be rewritten; JavaScript
 * cannot, and it kept reporting the truth: `navigator.userAgentData` said
 * Chromium 148 on Linux under a header saying Chrome 138 on Windows, and in a
 * source's own frames `navigator.userAgent` still said Electron. VidFast
 * builds its API path in the page from what the page sees and answered 500 on
 * every title (2026-10-01); Videm refused a page whose requests changed voice
 * mid-session (2026-09-30, `presentAsChrome`).
 *
 * The client hints (`Sec-CH-UA*`) are left to Chromium for the same reason:
 * it derives them from the same brand list it shows to JavaScript, so they
 * agree by construction. The brand list says Chromium rather than Google
 * Chrome; that is true, and a Chromium user is an ordinary visitor, where a
 * browser contradicting itself is not.
 *
 * Scope: this makes the browser consistent, not invisible. It does not patch
 * WebGL, canvas or fonts.
 */

import type { Session } from 'electron'
import { isSameOrigin } from './sameorigin'

/** The platform part of Chrome's reduced User-Agent, which is fixed per platform. */
const PLATFORM_TOKEN: Partial<Record<NodeJS.Platform, string>> = {
  linux: 'X11; Linux x86_64',
  win32: 'Windows NT 10.0; Win64; x64',
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
}

/**
 * The User-Agent Chrome would send on this platform at this engine version.
 *
 * Chrome's reduced UA keeps only the major version (`148.0.0.0`) and a frozen
 * platform string, so this is exact rather than an approximation of one.
 */
export function reducedChromeUA(chromeVersion: string, platform: NodeJS.Platform): string {
  const major = chromeVersion.split('.')[0]
  const system = PLATFORM_TOKEN[platform] ?? PLATFORM_TOKEN.linux
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

/**
 * This app's identity. `process.versions.chrome` is Electron's own Chromium.
 *
 * `process` is looked up rather than assumed: this module reaches the phone
 * too, through `tmdb.ts`, `imdb.ts` and `catalog.ts`, and a WebView has no
 * `process` at all — read unguarded, it stopped the phone app at startup
 * with an empty screen. Plain Node (the tests) has a `process` but no
 * Chromium. Either way the fallback stands in; the phone's own requests carry
 * its WebView's identity regardless.
 */
const host = typeof process === 'undefined' ? undefined : process
export const CHROME_UA = reducedChromeUA(host?.versions?.chrome ?? '148.0.0.0', host?.platform ?? 'linux')

/**
 * Fetch metadata describing an **embedded player**, not a typed-in address.
 *
 * ## The block this exists to survive
 *
 * Videasy began answering 403 to every title overnight. The embed URL returned
 * 200 to `curl` with any combination of User-Agent, client hints, Referer and
 * Origin, and 403 from the app — so it was not the network, the IP or the
 * identity. Bisecting the headers Chrome adds and `curl` does not isolated it
 * to exactly one:
 *
 *     Sec-Fetch-Dest: document   -> 403
 *     Sec-Fetch-Dest: iframe     -> 200
 *
 * That is not a bot check. It is a provider requiring its player to be
 * *framed*, which is a reasonable thing for an embed host to insist on — their
 * product is the frame, and a top-level visit is someone using the player
 * without the site that pays for it.
 *
 * The desktop app loads the provider as a top-level navigation in a
 * `WebContentsView`, so Chrome states the truth about the mechanism —
 * `Sec-Fetch-Dest: document`, `Sec-Fetch-Site: none` — and gets refused. The
 * Android app frames the same URL in a sandboxed iframe and was never affected,
 * which is what confirmed the diagnosis from the other side.
 *
 * ## Why rewriting these is honest
 *
 * Fetch metadata describes the *role* a request plays, and the role here really
 * is an embedded player: the app hosts the provider inside its own chrome,
 * exactly as an embedding page would. That the hosting is done with a native
 * view rather than an `<iframe>` element is an implementation detail of this
 * app, not a claim about what the request is for.
 *
 * Applied to every provider rather than to the one that started enforcing it.
 * A rule one host adopts, the rest adopt eventually, and finding out one at a
 * time costs a user their favourite source for however long it takes them to
 * report it.
 *
 * `Sec-Fetch-User` is deleted rather than set: Chrome sends it only on a
 * top-level navigation a user activated, so an iframe carrying one is a
 * contradiction, and contradictions are what fingerprinting looks for.
 */
const EMBEDDED_FETCH_METADATA: Record<string, string> = {
  'Sec-Fetch-Dest': 'iframe',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'cross-site',
}

const TOP_LEVEL_ONLY_HEADERS = ['Sec-Fetch-User']

/** A page or a frame, as opposed to a script, a stylesheet, an image or an XHR. */
function isDocumentRequest(resourceType: string): boolean {
  return resourceType === 'mainFrame' || resourceType === 'subFrame'
}

/**
 * Rewrite a request to look like one an embedding page made.
 *
 * Only for documents and sub-documents: a stylesheet, an image or an XHR the
 * player fires has its own correct `Sec-Fetch-Dest`, and overwriting those with
 * `iframe` would be the inconsistency this is trying to avoid.
 */
function applyEmbeddedFetchMetadata(
  headers: Record<string, string>,
  resourceType: string,
): void {
  if (!isDocumentRequest(resourceType)) return
  for (const [name, value] of Object.entries(EMBEDDED_FETCH_METADATA)) headers[name] = value
  for (const name of TOP_LEVEL_ONLY_HEADERS) delete headers[name]
}

/**
 * Make one outgoing request's headers carry the app's identity, all of them.
 *
 * The User-Agent is set here as well as by `app.userAgentFallback` and
 * `session.setUserAgent`, because a session's header handler sees requests
 * those have not reached — and `applyProviderReferer` replaces
 * `applyBrowserIdentity`'s handler on the sessions that load sources (a
 * session has one). Before 2.0.10 nothing corrected them and one session
 * spoke with two voices; Videm refuses such a page outright.
 *
 * Client hints are not written here: Chromium's own agree with the page's
 * `navigator.userAgentData`, and anything written by hand would not.
 */
export function presentAsChrome(headers: Record<string, string>): void {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'user-agent') delete headers[name]
  }
  headers['User-Agent'] = CHROME_UA
  // Electron sets this on some requests and Chrome never does.
  delete headers['X-DevTools-Emulate-Network-Conditions-Client-Id']
}

/**
 * Headers for `fetch()` calls made from the main process.
 *
 * Node's fetch does not go through an Electron `Session`, so it is untouched by
 * `applyBrowserIdentity` and needs these passed explicitly. TMDB does not care;
 * IMDB's undocumented suggestion endpoint is exactly the kind of service that
 * starts caring without notice.
 */
export const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent': CHROME_UA,
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
}

/**
 * Apply the Chrome identity to every request a session makes.
 *
 * Call once per session, after `app.whenReady()` — the session API is not
 * available before that.
 */
export function applyBrowserIdentity(session: Session): void {
  session.setUserAgent(CHROME_UA)

  session.webRequest.onBeforeSendHeaders(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      const headers = { ...details.requestHeaders }
      presentAsChrome(headers)
      callback({ requestHeaders: headers })
    },
  )
}

/**
 * Make a player window's requests look like they came from the provider's own
 * site rather than from nowhere.
 *
 * Embed hosts commonly reject requests with no `Referer` as hotlinking — the
 * page is meant to be framed by the site that owns it, and a bare navigation
 * has no referrer at all. Sending the provider's own origin is the request a
 * legitimately-framed player would make.
 *
 * Scoped to the provider's origin so it cannot leak a referrer to anyone else:
 * this handler replaces any previously registered one on the session, so player
 * windows must use their own session partition rather than the default.
 */
export function applyProviderReferer(session: Session, rootUrl: string): void {
  let origin: string
  try {
    origin = new URL(rootUrl).origin
  } catch {
    // A malformed custom provider must not take down playback entirely.
    return
  }
  session.setUserAgent(CHROME_UA)

  session.webRequest.onBeforeSendHeaders(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      const headers = { ...details.requestHeaders }
      presentAsChrome(headers)

      // Only for the provider's own origin. Attaching its referrer to a request
      // for some third-party CDN would tell that CDN where the user came from —
      // and a prefix comparison here would have done exactly that for any host
      // registered *under* the provider's name. See `sameorigin.ts`.
      if (isSameOrigin(details.url, origin)) {
        headers.Referer ??= `${origin}/`

        /**
         * `Origin` on navigations only.
         *
         * A browser sends `Origin` for CORS requests and for non-GET
         * navigations, and never for a same-origin `GET` of a script or a
         * stylesheet. Setting it there turns an ordinary subresource fetch into
         * a CORS request, and a server that answers without
         * `Access-Control-Allow-Origin` — which is every server, for its own
         * assets — makes Chromium abort it.
         *
         * Measured: with `Origin` on everything, Videasy's document returned 200
         * and every one of its `_next/static` chunks came back
         * `net::ERR_ABORTED`, so the page loaded as a shell that could never
         * resolve a stream. The verdict read `no-media`, which is
         * indistinguishable from a provider that simply does not have the title.
         */
        if (isDocumentRequest(details.resourceType)) headers.Origin ??= origin
      }

      // Every document this session loads is a provider embed, whichever host
      // it ends up on — players redirect between their own domains and pull
      // their stream page from a second one, and a 403 on that second hop looks
      // identical to a dead provider.
      applyEmbeddedFetchMetadata(headers, details.resourceType)

      callback({ requestHeaders: headers })
    },
  )
}
