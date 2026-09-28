/**
 * The desktop's end of the detail view's stream preview: a `<webview>` in the
 * app's page, holding the player shell in its preview mode.
 *
 * Why a webview and not the player's native view: a native view always paints
 * above the page, so the hero's fade, title and buttons could not be drawn
 * over it. That is why the idea was dropped on 2026-09-26. A webview is laid
 * out and painted with the page, like the YouTube trailer's iframe, yet it is
 * still its own webContents in its own session. So it gets exactly the
 * player's protections (`providerguard.ts`), which an iframe of the source in
 * the app's own session could not have. Measured in a spike on 2026-09-27
 * (branch `spike/detail-webview`): the page drew over the stream, and it
 * scrolled with the page.
 *
 * `will-attach-webview` is the gate. The page may attach a webview only for
 * this app's own shell in preview mode. Its preferences are set here, never
 * taken from the page, and `nodeIntegration` stays off.
 */

import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { join } from 'node:path'
import { EV } from '@shared/ipc'
import { filmRelayScript } from '@shared/filmrelay'
import { applyProviderReferer } from './identity'
import { PLAYER_SHELL_PATH } from './localserver'
import { clickPlayInFrames } from './pressplay'
import { blockAdverts, installFilmRelay, keepProviderInPlace, refusePopupsAndDownloads } from './providerguard'

/** The shell URL's preview target, if `url` is this app's shell in preview mode. */
export function previewTarget(url: string | undefined, shellBase: string): string | null {
  if (url === undefined) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.origin !== new URL(shellBase).origin || parsed.pathname !== PLAYER_SHELL_PATH) return null
  if (parsed.searchParams.get('preview') !== '1') return null
  const src = parsed.searchParams.get('src')
  try {
    const target = new URL(src ?? '')
    return target.protocol === 'https:' || target.protocol === 'http:' ? target.toString() : null
  } catch {
    return null
  }
}

let partitions = 0

export function allowStreamPreviews(win: BrowserWindow, dirname: string, shellBase: string): void {
  win.webContents.on('will-attach-webview', (event, prefs, params) => {
    const target = previewTarget(params.src, shellBase)
    if (target === null) {
      console.log(`[preview] refused a webview for ${(params.src ?? '').slice(0, 80)}`)
      event.preventDefault()
      return
    }
    // Everything the page might have asked for is replaced, not merged.
    delete (prefs as { preloadURL?: string }).preloadURL
    prefs.preload = join(dirname, '../preload/player.mjs')
    prefs.contextIsolation = true
    prefs.nodeIntegration = false
    prefs.nodeIntegrationInSubFrames = false
    prefs.sandbox = false
    // As the player's: a source's page fetches its stream cross-origin.
    prefs.webSecurity = false
    prefs.autoplayPolicy = 'no-user-gesture-required'
    // Its own partition, for the reasons the player has one (`playerview.ts`).
    partitions += 1
    prefs.partition = `preview-${Date.now()}-${partitions}`
    params.partition = prefs.partition
  })

  win.webContents.on('did-attach-webview', (_event, guest) => protect(guest, shellBase))
}

function protect(guest: WebContents, shellBase: string): void {
  /*
   * The source this guest shows. Its URL is still empty at attach time
   * (measured in the spike), so it is learned from the shell's navigations,
   * which were all vetted by the gate above: the page can only point a
   * webview at the shell, and the shell names its source in the URL.
   */
  let target: string | null = previewTarget(guest.getURL(), shellBase)
  const rootUrl = (): string | null => (target === null ? null : `${new URL(target).origin}/`)
  guest.on('did-start-navigation', (details) => {
    if (!details.isMainFrame) return
    const next = previewTarget(details.url, shellBase)
    if (next === null) return
    target = next
    applyProviderReferer(guest.session, rootUrl()!)
  })

  // Silent until the page says otherwise, at the webContents as well as in
  // the film: an advert with its own sound must not get past the film relay's
  // mute. The page lifts this with the element's own `setAudioMuted`.
  guest.setAudioMuted(true)
  guest.setBackgroundThrottling(false)
  refusePopupsAndDownloads(guest)
  if (target !== null) applyProviderReferer(guest.session, rootUrl()!)
  blockAdverts(guest.session, rootUrl)
  keepProviderInPlace(guest, () => target)
  installFilmRelay(guest, filmRelayScript(new URL(shellBase).origin))

  const onPressPlay = (event: Electron.IpcMainEvent): void => {
    if (event.sender === guest) void clickPlayInFrames(guest).catch(() => {})
  }
  ipcMain.on(EV.playerPressPlay, onPressPlay)
  guest.once('destroyed', () => ipcMain.removeListener(EV.playerPressPlay, onPressPlay))
}
