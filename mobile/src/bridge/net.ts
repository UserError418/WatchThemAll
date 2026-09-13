/**
 * Two ways out of the phone, tried in that order.
 *
 * `CapacitorHttp` is enabled for this app, which replaces `window.fetch` with a
 * native request made by Java. That is what makes the cross-origin calls to
 * TMDB and IMDB possible at all, and it is the right default — but it means
 * every request leaves through Android's own resolver and socket stack, and
 * when that stack has a bad moment the app has nowhere else to go. A user on
 * mobile data got this under the Connect button:
 *
 *     Unable to resolve host "oauth2.googleapis.com":
 *     No address associated with hostname
 *
 * which is `java.net.UnknownHostException`, verbatim, from the native side.
 *
 * The WebView is a second, genuinely independent path: Chromium does its own
 * DNS and keeps its own connections, so it routinely resolves a name the Java
 * stack has just failed on. Capacitor stores the untouched browser `fetch` as
 * `window.CapacitorWebFetch` before installing its patch, so reaching it costs
 * nothing.
 *
 * The catch is that the browser path is subject to CORS, which is the reason
 * the native one exists. So this is not a general-purpose replacement — it is
 * for hosts measured to send the right headers. Google's do, from this app's
 * `https://localhost` origin:
 *
 *     OPTIONS https://oauth2.googleapis.com/device/code
 *     -> access-control-allow-origin: https://localhost
 *
 * and the same for `/token` and for `www.googleapis.com/drive/v3`. Verified on
 * an Android 16 emulator against the real endpoints, not inferred from
 * documentation. Do not point this at a provider or at IMDB; neither would
 * answer a preflight.
 */

/** Capacitor keeps the pre-patch browser `fetch` here. */
type MaybePatchedWindow = typeof globalThis & { CapacitorWebFetch?: typeof fetch }

function browserFetch(): typeof fetch | null {
  const candidate = (globalThis as MaybePatchedWindow).CapacitorWebFetch
  return typeof candidate === 'function' ? candidate : null
}

/**
 * `fetch`, falling back to the WebView's own stack when the native one cannot
 * make the connection at all.
 *
 * Only a *rejection* triggers the fallback. Any response — including a 401 or a
 * 500 — means the request arrived and was answered, and asking a second stack
 * to produce a different answer to the same question would only hide the first.
 */
export const dualStackFetch: typeof fetch = async (input, init) => {
  try {
    return await fetch(input, init)
  } catch (nativeFailure) {
    const fallback = browserFetch()
    if (fallback === null) throw nativeFailure
    try {
      return await fallback(input, init)
    } catch {
      // The native error is the more informative of the two — it names the host
      // and the resolver failure, where the browser says only "Failed to fetch".
      throw nativeFailure
    }
  }
}
