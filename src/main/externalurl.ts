/**
 * What the app is allowed to hand to the operating system.
 *
 * There is exactly one caller today — the sync panel's "open the sign-in page"
 * button — and the guard is here rather than inline in it because the channel
 * it goes through is generic. A channel called `shell:open-external` will
 * acquire callers, and the next one will pass a URL that came from somewhere
 * less trustworthy than Google's device-flow response.
 *
 * The danger is not the web. It is that both platform calls beneath this —
 * Electron's `shell.openExternal` and Android's `ACTION_VIEW` intent — hand the
 * string to the *operating system*, which resolves schemes the browser would
 * never touch: `file:` opens a document, and on Android a custom scheme starts
 * whatever app claims it. So this is an allowlist of two schemes rather than a
 * blocklist of the ones known to be bad.
 */
export function isOpenableExternally(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // Relative or malformed. Nothing to open.
    return false
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:'
}
