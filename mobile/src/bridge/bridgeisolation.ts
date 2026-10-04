/**
 * Whether provider pages are kept away from the app's native bridge.
 *
 * Capacitor offers its bridge to the page through the WebView's message
 * listener, limited to the app's own origin and to its main frame. A WebView
 * too old for that (Android System WebView before 84) makes Capacitor fall
 * back to `addJavascriptInterface`, which puts the bridge in every frame of
 * every origin. A provider's page, or an advert inside it, could then call any
 * plugin: read the library, or the Drive sign-in out of Preferences. There the
 * app loads no provider at all, for playing or for the detail view's preview,
 * and says why. Source tests are unaffected: their probes are WebViews of
 * their own, with no bridge in them.
 */

export const OUTDATED_WEBVIEW =
  'This phone’s Android System WebView is too old to play sources safely. Update “Android System WebView” from the Play Store, then try again.'

export interface IsolationNative {
  bridgeIsolated(): Promise<{ isolated: boolean }>
}

/**
 * The native answer. A plugin that cannot answer counts as isolated: the only
 * place that happens is the Chromium preview harness, which has no native
 * bridge to expose.
 */
export async function checkBridgeIsolation(native: IsolationNative): Promise<boolean> {
  try {
    return (await native.bridgeIsolated()).isolated
  } catch {
    return true
  }
}
