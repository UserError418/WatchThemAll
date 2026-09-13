/**
 * The phone's video surface.
 *
 * ## Why this exists at all
 *
 * Stage one handed playback to a Chrome Custom Tab, which is a real browser
 * tab: the app controls nothing inside it. Every embed provider in the
 * catalogue monetises with popunders, and the desktop app's entire defence
 * against those is one line — `setWindowOpenHandler(() => ({ action: 'deny' }))`
 * on the player's `WebContentsView`. A Custom Tab has no equivalent, so the
 * phone showed the ads the desktop never does. That was the report.
 *
 * ## Why an iframe rather than a native WebView plugin
 *
 * The obvious answer was a Kotlin plugin wrapping `WebView`, blocking popups in
 * `WebViewClient`. It is not needed. Every provider URL in the catalogue is an
 * *embed* endpoint — being framed is what they are for — and the response
 * headers say so: measured across the eight core providers, none sends a
 * restrictive `X-Frame-Options` or `frame-ancestors`, and CinemaOS and Vidzee
 * send `ALLOWALL` / `frame-ancestors *` explicitly.
 *
 * So the video can be an ordinary iframe in the app's own WebView, and the
 * popup blocking comes from the `sandbox` attribute, enforced by the browser
 * rather than by code we maintain. That keeps the APK a pure web bundle.
 *
 * ## Why there is no `sandbox` attribute any more
 *
 * There was one, and it is why several providers would not play at all.
 *
 * It existed to block popunders by omitting `allow-popups`, which makes
 * `window.open` return null. Providers test for it and refuse to serve:
 * VidFast replaces its whole page with "Please Disable Sandbox". Measured both
 * ways — the refusal with the attribute, its real player without it, same URL
 * and same WebView seconds apart.
 *
 * The popup blocking did not go away, it moved somewhere a page cannot see it:
 * `setJavaScriptCanOpenWindowsAutomatically(false)` in `MainActivity`, which
 * has the same effect on `window.open` in every frame and exposes no attribute
 * to detect. That file records what it does and does not claim to stop.
 *
 * ## How the position is read without reading the frame
 *
 * It is not read. Several providers *post it out*, and the frame is asked for
 * nothing — see `@main/playermessage`, which holds the measured payloads and
 * the parser. This file's only job in that exchange is the part a parser cannot
 * do: proving the message came from the video and not from somewhere else in
 * the page. `event.source === frame.contentWindow` is that proof, and it is
 * available cross-origin precisely because it compares window identities rather
 * than reading anything through one.
 *
 * Origin is deliberately *not* checked on top of it. A provider redirects
 * through its own CDNs and switches host between titles, so a fixed origin
 * list would reject working players, and `event.source` already answers the
 * only question that matters: is this the frame we put there.
 *
 * ## What is still missing
 *
 * Stall detection and the auto-switch countdown. Both need to know that a video
 * *stopped* advancing, and a provider that reports nothing is indistinguishable
 * from one that has stalled — three of the eight core providers report nothing
 * at all. Seeking to a stored position is missing for the same reason in
 * reverse: the position can be read, but nothing here can write one back.
 */

import { ScreenOrientation } from '@capacitor/screen-orientation'
import { StatusBar } from '@capacitor/status-bar'

import { parsePlayerMessage, type PlayerReading } from '@main/playermessage'
import type { PlayCandidate } from '@main/providers'

/** Where the renderer's player chrome wants the video, in CSS pixels. */
export interface SurfaceBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Just under `PlayerFrame`'s own z-index of 300.
 *
 * The chrome is a flex column — header, source menu, prompt, then an empty
 * `.slot` that takes the rest — and on desktop a native layer paints over that
 * slot. Nothing in the DOM can paint over `.player`'s stacking context from
 * outside it, so the phone inverts the arrangement: the surface sits *behind*
 * the chrome, and `mobile.css` makes `.player` and its slot transparent and
 * click-through so the slot becomes a hole exactly the shape of the video.
 */
const SURFACE_Z = 299

/** Autoplay is the point; the rest are what embed players ask for. */
const ALLOW = 'autoplay; fullscreen; encrypted-media; picture-in-picture'

/**
 * Keep the screen on for as long as something is playing.
 *
 * A WebView does not hold a wake lock on the app's behalf, and an embed player
 * is a page with a `<video>` in it, not a media session Android knows about —
 * so without this the screen dims and locks mid-episode. The Screen Wake Lock
 * API needs no plugin and no permission.
 *
 * The lock is dropped by the platform whenever the page is hidden, so it has to
 * be re-taken on `visibilitychange` rather than acquired once.
 */
function createWakeLock(): { acquire(): void; release(): void } {
  let sentinel: WakeLockSentinel | null = null
  let wanted = false

  const take = (): void => {
    if (!wanted || sentinel) return
    navigator.wakeLock
      ?.request('screen')
      .then((granted) => {
        sentinel = granted
        granted.addEventListener('release', () => (sentinel = null))
      })
      .catch(() => {
        // Denied, or the API is absent in this WebView. Playback is unaffected.
      })
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') take()
  })

  return {
    acquire() {
      wanted = true
      take()
    },
    release() {
      wanted = false
      void sentinel?.release().catch(() => {})
      sentinel = null
    },
  }
}

/**
 * Follow the video into fullscreen.
 *
 * Landscape is not forced when playback *starts* — plenty of watching happens
 * upright, and an app that rotates the screen out from under you is the kind
 * that gets uninstalled. It is forced when the user asks for fullscreen using
 * the provider's own control, which is an unambiguous "make this as big as
 * possible" and is what every video app on the platform does with it.
 *
 * The signal arrives because the surface iframe carries `allowfullscreen`, so
 * the provider's button raises the Fullscreen API on *our* document with the
 * iframe as `fullscreenElement`.
 */
function followFullscreen(): () => void {
  const onChange = (): void => {
    const entering = document.fullscreenElement !== null
    if (entering) {
      void ScreenOrientation.lock({ orientation: 'landscape' }).catch(() => {})
      void StatusBar.hide().catch(() => {})
    } else {
      void ScreenOrientation.unlock().catch(() => {})
      void StatusBar.show().catch(() => {})
    }
  }

  document.addEventListener('fullscreenchange', onChange)
  return () => {
    document.removeEventListener('fullscreenchange', onChange)
    void ScreenOrientation.unlock().catch(() => {})
    void StatusBar.show().catch(() => {})
  }
}

/**
 * Listen for position reports from one frame, and only that frame.
 *
 * `window` receives messages from every frame in the document and from anything
 * that can reach `window.parent` or `window.opener`, so the filter is the whole
 * security of this path. Comparing `event.source` against the iframe's own
 * `contentWindow` cannot be spoofed: a page can claim any origin string it
 * likes in a payload, but it cannot make the browser hand us a different window
 * object as the sender.
 *
 * The listener is installed with the frame and removed with it, so a torn-down
 * player cannot keep writing resume points for whatever loads next.
 */
function listenForReadings(
  frame: HTMLIFrameElement,
  onReading: (reading: PlayerReading) => void,
): () => void {
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow) return
    const reading = parsePlayerMessage(event.data)
    // Null is the ordinary case — providers post analytics, ad beacons and
    // their own internal chatter through the same channel.
    if (reading !== null) onReading(reading)
  }

  window.addEventListener('message', onMessage)
  return () => window.removeEventListener('message', onMessage)
}

export interface PlayerSurfaceOptions {
  /**
   * Called for every position report the current frame volunteers.
   *
   * Most providers never call it, and a session that ends without a single
   * reading is normal rather than broken — `resumeAction` treats "no reading"
   * as "we learned nothing", not as "start again from the beginning".
   */
  onReading?(reading: PlayerReading): void
}

export interface PlayerSurface {
  /** Show `candidate` in the surface, creating it on first use. */
  show(candidate: PlayCandidate): void
  /** Reload the current URL without changing provider. */
  reload(): void
  setBounds(bounds: SurfaceBounds): void
  /** Tear it down. Safe to call when nothing is showing. */
  close(): void
  /** The URL currently loaded, or null. */
  url(): string | null
}

export function createPlayerSurface(options: PlayerSurfaceOptions = {}): PlayerSurface {
  let host: HTMLDivElement | null = null
  let frame: HTMLIFrameElement | null = null
  let current: string | null = null
  let stopFollowingFullscreen: (() => void) | null = null
  let stopListening: (() => void) | null = null

  const wakeLock = createWakeLock()

  const ensure = (): HTMLIFrameElement => {
    if (frame) return frame

    host = document.createElement('div')
    host.id = 'wta-player-surface'
    host.style.cssText = [
      'position: fixed',
      // Full-bleed until the chrome reports where the slot is, which happens on
      // its first frame. Sized to nothing instead, the app behind would flash
      // through the transparent chrome for that frame.
      'inset: 0',
      `z-index: ${SURFACE_Z}`,
      'background: #000',
      'overflow: hidden',
    ].join(';')

    frame = document.createElement('iframe')
    frame.setAttribute('allow', ALLOW)
    frame.setAttribute('allowfullscreen', 'true')
    frame.setAttribute('referrerpolicy', 'origin')
    frame.style.cssText = 'width: 100%; height: 100%; border: 0; display: block; background: #000'

    host.appendChild(frame)
    document.body.appendChild(host)

    wakeLock.acquire()
    stopFollowingFullscreen = followFullscreen()
    if (options.onReading) stopListening = listenForReadings(frame, options.onReading)
    return frame
  }

  return {
    show(candidate) {
      const el = ensure()
      current = candidate.url
      // `src` rather than `location.replace`: the frame is cross-origin, so its
      // `contentWindow` is off limits from here.
      el.src = candidate.url
    },

    reload() {
      if (!frame || !current) return
      // Re-assigning the same `src` is a no-op in Chromium, so blank it first.
      frame.src = 'about:blank'
      frame.src = current
    },

    setBounds({ x, y, width, height }) {
      if (!host) return
      host.style.inset = 'auto'
      host.style.left = `${x}px`
      host.style.top = `${y}px`
      host.style.width = `${width}px`
      host.style.height = `${height}px`
    },

    close() {
      host?.remove()
      host = null
      frame = null
      current = null
      wakeLock.release()
      stopFollowingFullscreen?.()
      stopFollowingFullscreen = null
      stopListening?.()
      stopListening = null
    },

    url: () => current,
  }
}
