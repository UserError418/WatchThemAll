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
 * at all. (Seeking to a stored position used to be missing too. Since 1.9.9
 * the media relay does it; see `seek` and `ResumeSeek`.)
 */

import { ScreenOrientation } from '@capacitor/screen-orientation'
import { StatusBar } from '@capacitor/status-bar'

import { parsePlayerMessage, type PlayerContext, type PlayerReading } from '@main/playermessage'
import { parseRelayState, parseRelayTime, relayCommand, relaySeek, type RelayTime } from './mediarelay'
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
  expects: () => PlayerContext | null,
  onMediaState: (playing: boolean) => void,
  onFilmTime: (time: RelayTime) => void,
): () => void {
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow) return
    // The film relay's navigation guard refused a redirect (`filmrelay.ts`).
    const refused = (event.data as { wtaMedia?: unknown; refused?: unknown } | null)?.refused
    if ((event.data as { wtaMedia?: unknown } | null)?.wtaMedia === 1 && typeof refused === 'string') {
      console.info(`[navguard] refused a redirect to ${refused}`)
    }
    // The mini player's relay reporting the video starting or stopping. See
    // `mediarelay.ts`; it shares this listener for the sender check.
    const playing = parseRelayState(event.data)
    if (playing !== null) {
      onMediaState(playing)
      return
    }
    // The relay's reading of the film's own element: every provider, whether
    // or not it posts a position of its own. It names no title or episode;
    // the caller files it under what is playing.
    const time = parseRelayTime(event.data)
    if (time !== null) {
      onFilmTime(time)
      onReading({
        tmdbId: null,
        seconds: time.seconds,
        duration: time.duration,
        season: null,
        episode: null,
        ended: time.ended,
        playing: time.playing,
      })
      return
    }
    // What is playing goes *in*, not just out. A provider that posts its whole
    // progress library — both of the two that report anything do — leaves the
    // parser choosing between titles, and the only thing on this side of the
    // frame that knows which one is on screen is the caller.
    const reading = parsePlayerMessage(event.data, expects())
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
  /**
   * What the app believes is playing, read at message time.
   *
   * An accessor rather than a value: the surface is created once and outlives
   * every episode shown in it, so anything captured here would be the first
   * one for the life of the app.
   */
  expects?(): PlayerContext | null
  /** The video started (true) or stopped (false), as the relay reports it. */
  onMediaState?(playing: boolean): void
  /**
   * The film's own element, as the relay read it. Also passed to `onReading`
   * as a reading. This hook exists for the resume seek, which must act only on
   * the element the relay can reach: a provider's own position messages can
   * describe another title altogether.
   */
  onFilmTime?(time: RelayTime): void
  /**
   * A new document is loading into the frame (the frame), or the surface was
   * blanked or closed (null). v2's overlay is mounted afresh on each load,
   * as the desktop's shell is (`overlayhub.ts`).
   */
  onFrameLoad?(frame: HTMLIFrameElement | null): void
}

export interface PlayerSurface {
  /** Show `candidate` in the surface, creating it on first use. */
  show(candidate: PlayCandidate): void
  /**
   * Pause or resume the provider's video, through the relay installed by
   * `installMediaRelay`. The outcome comes back as `onMediaState`.
   */
  setPaused(paused: boolean): void
  /** Move the film to `seconds`, through the relay; see `relaySeek`. */
  seek(seconds: number, duration: number): void
  /** Press the source's own play control in every frame, through the film relay (`press`). */
  press(): void
  /**
   * Load the current source again. `url` replaces the current one: the same
   * source with a newer start position in it.
   */
  reload(url?: string): void
  /**
   * Stop playing here, without forgetting what was playing.
   *
   * Used when a cast starts. Otherwise the phone keeps streaming the same film
   * it is simultaneously serving to the television — twice the data, and audio
   * from two rooms. `restore` brings the same URL back.
   */
  blank(): void
  /** Bring back what `blank` took away, at `url` if given; see `reload`. */
  restore(url?: string): void
  setBounds(bounds: SurfaceBounds): void
  /**
   * Out of sight while still playing: the detail view's preview stands in
   * (Resume carried over, `shared/carryover.ts`). Opacity rather than
   * visibility, which the frame's own `visibility: visible` would override;
   * and still laid out, so the source does not stop the film as off screen.
   */
  setConcealed(concealed: boolean): void
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
  let concealed = false
  const applyConcealed = (): void => {
    if (!host) return
    host.style.opacity = concealed ? '0' : ''
    host.style.pointerEvents = concealed ? 'none' : ''
  }
  let stopListening: (() => void) | null = null

  const wakeLock = createWakeLock()

  /** The host the frames go in, made on first use. */
  const ensure = (): void => {
    if (host) return

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

    document.body.appendChild(host)
    applyConcealed()

    wakeLock.acquire()
    stopFollowingFullscreen = followFullscreen()
  }

  /**
   * A new iframe for every page loaded, listened to afresh.
   *
   * The sender check (`listenForReadings`) compares windows, and an iframe
   * keeps its window when its `src` changes. Until 2.0.9 it was kept, so what
   * the page being left still posted — its last position, a relay report in
   * flight — passed as the new page's: a film-length reading arriving 0.3 s
   * after a switch credited the new source with streaming that fast, however
   * it went on (the owner, 2026-09-30: sources "load in under 1 s"). A new
   * element has a new window, and the old page goes with the old element.
   */
  const freshFrame = (): HTMLIFrameElement => {
    const next = document.createElement('iframe')
    next.setAttribute('allow', ALLOW)
    next.setAttribute('allowfullscreen', 'true')
    next.setAttribute('referrerpolicy', 'origin')
    next.style.cssText = 'width: 100%; height: 100%; border: 0; display: block; background: #000'
    if (frame) frame.replaceWith(next)
    else host!.appendChild(next)
    frame = next

    stopListening?.()
    stopListening = null
    if (options.onReading || options.onMediaState || options.onFilmTime) {
      const onReading = options.onReading?.bind(options) ?? (() => {})
      const expects = options.expects?.bind(options) ?? (() => null)
      const onMediaState = options.onMediaState?.bind(options) ?? (() => {})
      const onFilmTime = options.onFilmTime?.bind(options) ?? (() => {})
      stopListening = listenForReadings(next, onReading, expects, onMediaState, onFilmTime)
    }
    return next
  }

  return {
    show(candidate) {
      ensure()
      const el = freshFrame()
      // Anything shown is meant to be seen, including the first episode loaded
      // after a blank — stepping to another episode while casting comes back
      // through here, not through `restore`.
      el.style.visibility = 'visible'
      current = candidate.url
      options.onFrameLoad?.(el)
      // `src` rather than `location.replace`: the frame is cross-origin, so its
      // `contentWindow` is off limits from here.
      el.src = candidate.url
    },

    setPaused(paused) {
      // '*' because the provider's origin is whatever it is today. The
      // message carries nothing but the word pause or play.
      frame?.contentWindow?.postMessage(relayCommand(paused), '*')
    },

    seek(seconds, duration) {
      frame?.contentWindow?.postMessage(relaySeek(seconds, duration), '*')
    },

    press() {
      frame?.contentWindow?.postMessage({ wtaMedia: 1, command: 'press' }, '*')
    },

    reload(url) {
      if (!frame || !current) return
      current = url ?? current
      const el = freshFrame()
      options.onFrameLoad?.(el)
      el.src = current
    },

    blank() {
      if (!frame) return
      /**
       * Hidden as well as emptied, because `about:blank` is white.
       *
       * The host behind it is black and always was, so this looked like a
       * styling detail and is not: the iframe paints its own white page over
       * the host, and while casting that white rectangle *is* the whole
       * screen. It is what "the player becomes white" was.
       */
      const el = freshFrame()
      el.style.visibility = 'hidden'
      el.src = 'about:blank'
      options.onFrameLoad?.(null)
    },

    restore(url) {
      if (!frame || !current) return
      current = url ?? current
      const el = freshFrame()
      el.style.visibility = 'visible'
      options.onFrameLoad?.(el)
      el.src = current
    },

    setConcealed(next) {
      concealed = next
      applyConcealed()
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
      if (frame) options.onFrameLoad?.(null)
      host?.remove()
      host = null
      frame = null
      concealed = false
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
