/**
 * Pause and resume the provider's video from the app, on Android.
 *
 * The mini player (2026-09-27) has a play/pause button, and the video it
 * controls is the provider's `<video>`, one or two cross-origin iframes deep
 * inside the player surface. The desktop reaches it with
 * `WebFrameMain.executeJavaScript`. A WebView has no equivalent:
 * `evaluateJavascript` runs in the main frame only, and the app's document
 * cannot touch a cross-origin frame's DOM.
 *
 * What a WebView does have is `addDocumentStartJavaScript`, which installs a
 * script into every document of every origin, before the page's own scripts.
 * The hidden source test already relies on it (`probescript.ts`). This is
 * the same mechanism in the app's own WebView, with a much smaller job: sit
 * in each provider frame and wait to be told.
 *
 * ## The relay
 *
 * The app posts `{ wtaMedia: 1, command: 'pause' | 'play' }` to the surface
 * iframe. Each frame's copy of the script acts on its own videos, then passes
 * the command to its child frames. That is how it reaches a player nested
 * two deep without knowing the nesting. Going the other way, each frame
 * reports its video starting or stopping to its parent, and every frame
 * passes on what its children report. The app hears the state from the
 * surface iframe, and trusts nothing else (`listenForReadings` checks the
 * sender).
 *
 * ## Who may command it
 *
 * Only a frame's own parent, and in the outermost provider frame only a
 * parent at the app's origin. `event.source` is a window object the browser
 * supplies, and a page cannot forge it. The worst a hostile page could do
 * with the channel is pause a video in a frame it already contains, which it
 * could do anyway.
 */

import { registerPlugin } from '@capacitor/core'

/** Marks the relay's messages among everything else providers post. */
const TAG = 'wtaMedia'

/** What the app posts into the surface iframe. */
export function relayCommand(paused: boolean): Record<string, unknown> {
  return { [TAG]: 1, command: paused ? 'pause' : 'play' }
}

/**
 * Read a state report from the surface frame: true for playing, false for
 * paused, null for anything that is not one of the relay's own messages.
 */
export function parseRelayState(data: unknown): boolean | null {
  if (typeof data !== 'object' || data === null) return null
  const message = data as Record<string, unknown>
  if (message[TAG] !== 1) return null
  if (message.state === 'playing') return true
  if (message.state === 'paused') return false
  return null
}

/**
 * The script installed into every frame, as source text for the native side.
 *
 * `appOrigin` is the app document's own origin (`https://localhost` under
 * Capacitor's default scheme), passed in rather than written down so a
 * change of scheme cannot silently disarm the check. Resuming plays the
 * biggest video with a real duration and nothing else, as the desktop's
 * `RESUME_SCRIPT` does, so an advert's clip is not restarted with the film.
 */
export function mediaRelayScript(appOrigin: string): string {
  return `(() => {
  // The app's own document hosts the surface; it has nothing to relay.
  if (window.top === window) return
  if (window.__wtaMediaRelay) return
  window.__wtaMediaRelay = true

  const TAG = ${JSON.stringify(TAG)}
  const APP = ${JSON.stringify(appOrigin)}

  const up = (state) => {
    try { window.parent.postMessage({ [TAG]: 1, state }, '*') } catch (error) {}
  }
  const children = () => Array.from(document.querySelectorAll('iframe'))
  const fromParent = (event) =>
    event.source === window.parent && (window.parent !== window.top || event.origin === APP)
  const film = () => {
    let best = null
    let bestArea = 0
    for (const video of document.querySelectorAll('video')) {
      const duration = Number(video.duration)
      if (!Number.isFinite(duration) || duration <= 0) continue
      const rect = video.getBoundingClientRect()
      const area = rect.width * rect.height
      if (area > bestArea) {
        best = video
        bestArea = area
      }
    }
    return best
  }

  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || typeof data !== 'object' || data[TAG] !== 1) return

    if (data.command === 'pause' || data.command === 'play') {
      if (!fromParent(event)) return
      if (data.command === 'pause') {
        for (const video of document.querySelectorAll('video')) video.pause()
      } else {
        const video = film()
        if (video) video.play().catch(() => {})
      }
      for (const child of children()) {
        try { child.contentWindow.postMessage(data, '*') } catch (error) {}
      }
      return
    }

    if (data.state === 'playing' || data.state === 'paused') {
      if (children().some((child) => child.contentWindow === event.source)) up(data.state)
    }
  })

  // Media events do not bubble; the capture phase still sees them.
  document.addEventListener('playing', (event) => {
    if (event.target instanceof HTMLVideoElement) up('playing')
  }, true)
  document.addEventListener('pause', (event) => {
    if (event.target instanceof HTMLVideoElement) up('paused')
  }, true)
})()`
}

interface PlayerRelayNative {
  install(options: { script: string }): Promise<{ installed: boolean }>
}

const PlayerRelay = registerPlugin<PlayerRelayNative>('PlayerRelay')

/**
 * Install the relay into the app's WebView. Call once, before any player
 * opens: the native side can only reach documents created after it.
 *
 * False where the WebView lacks document-start scripts (it predates them),
 * in which case the mini player's button does nothing and the provider's own
 * controls remain the way to pause.
 */
export async function installMediaRelay(appOrigin: string): Promise<boolean> {
  try {
    const { installed } = await PlayerRelay.install({ script: mediaRelayScript(appOrigin) })
    return installed
  } catch {
    // The web build and the Chromium preview have no native side.
    return false
  }
}
