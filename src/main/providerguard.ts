/**
 * What every surface that shows a source's page does to keep it in its box.
 *
 * Two surfaces show one: the player (`playerview.ts`, a native view) and the
 * detail view's stream preview (`previewview.ts`, a `<webview>` guest in the
 * app's page). Each has its own `webContents` and its own session partition,
 * so the protections are the same code applied to either, and a rule changed
 * for one cannot be forgotten for the other.
 *
 * The scan probe (`streamprobe.ts`) keeps its own copies on purpose: it runs
 * in a hidden window with rules of its own (it wants the stream requests the
 * blocker would otherwise let through unseen).
 */

import { webFrameMain, type Session, type WebContents } from 'electron'
import { decide } from './adblock'
import { isForeignNavigation } from './navguard'

/**
 * No popups, and never a download from a source's page.
 *
 * Electron answers an unhandled download with a save dialog, so a source
 * could put the system's file picker in front of the user (reported by the
 * owner, 2026-09-27). The session is the surface's own partition, so this
 * reaches nothing else.
 */
export function refusePopupsAndDownloads(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.session.on('will-download', (event, item) => {
    console.log(`[download] refused ${new URL(item.getURL()).origin} (${item.getFilename()})`)
    event.preventDefault()
  })
}

/**
 * Cancel the advertising, on this partition only.
 *
 * `onBeforeRequest` allows one handler per session, which is exactly why each
 * surface has its own partition: registering this on the app's session would
 * replace whatever else wanted it, and would also apply the rules to the
 * app's own TMDB traffic.
 *
 * The page origin is asked for on every request rather than captured:
 * switching provider mid-episode replaces the candidate, and rules that still
 * trusted the previous provider's domain would either block the new stream or
 * wave through the new page's ads.
 *
 * Set `WTA_ADBLOCK_LOG=1` to see every decision. That is the switch to reach
 * for when a provider stops playing after a rule changes: each line names the
 * rule, so "which rule killed the video" is a grep rather than a bisect.
 * `WTA_ADBLOCK=0` turns it off, because the first question when a provider
 * stops playing is "is it the blocker?", and the only honest way to answer it
 * is to run the same thing twice.
 */
export function blockAdverts(session: Session, pageOrigin: () => string | null): void {
  const logBlocking = process.env.WTA_ADBLOCK_LOG === '1'
  const blockingEnabled = process.env.WTA_ADBLOCK !== '0'
  session.webRequest.onBeforeRequest((details, callback) => {
    if (!blockingEnabled) {
      callback({ cancel: false })
      return
    }
    const decision = decide({
      url: details.url,
      resourceType: details.resourceType,
      pageOrigin: pageOrigin(),
    })
    if (logBlocking) {
      console.log(
        `[adblock] ${decision.blocked ? 'BLOCK' : 'allow'} ${decision.rule} ` +
          `${details.resourceType} ${details.url.slice(0, 160)}`,
      )
    }
    callback({ cancel: decision.blocked })
  })
}

/**
 * Keep the provider's page where we put it: `isForeignNavigation`.
 *
 * The provider's document is the shell's direct child. The shell's own
 * navigations are ours (every source change is a `loadURL` of the shell), and
 * the provider's inner frames may go where they like, because what the user
 * sees is decided by the document that holds them.
 */
export function keepProviderInPlace(contents: WebContents, providerUrl: () => string | null): void {
  contents.on('will-frame-navigate', (details) => {
    const frame = details.frame
    if (details.isMainFrame || frame === null || frame.parent !== contents.mainFrame) return
    if (!isForeignNavigation(frame.url, details.url, providerUrl())) return
    console.log(`[navguard] kept ${frame.origin} from navigating to ${new URL(details.url).origin}`)
    details.preventDefault()
  })
}

/**
 * Put the film relay (`@shared/filmrelay`) into every provider frame.
 *
 * Idempotent in the frame, so it is installed on every event that might be
 * the first: when a new frame's DOM is ready, and again when any frame
 * finishes loading, since a cross-origin navigation gives a frame a new
 * document without a new `frame-created`. The shell itself (the main frame)
 * never gets one: it is the relay's parent, not a provider.
 */
export function installFilmRelay(contents: WebContents, relayScript: string): void {
  const install = (frame: Electron.WebFrameMain | null | undefined): void => {
    if (!frame || frame === contents.mainFrame) return
    try {
      void frame.executeJavaScript(relayScript).catch(() => {})
    } catch {
      // Disposed between the event and this call; its successor gets one.
    }
  }
  contents.on('frame-created', (_event, { frame }) => {
    frame?.on('dom-ready', () => install(frame))
  })
  contents.on('did-frame-finish-load', (_event, isMainFrame, processId, routingId) => {
    if (!isMainFrame) install(webFrameMain.fromId(processId, routingId))
  })
}
