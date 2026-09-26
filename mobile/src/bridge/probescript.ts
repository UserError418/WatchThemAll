/**
 * The script a probe session runs inside every frame of the provider's page.
 *
 * `ProbeSession.java` installs it with `addDocumentStartJavaScript`, which is
 * the one way on Android to run code inside a cross-origin iframe: the
 * WebView injects it into each new document of every origin, before the
 * page's own scripts, as if it were the first line of the page. It is written
 * here rather than in Java because it is JavaScript, and because the scan
 * that decides when play should be pressed lives on this side.
 *
 * It has two jobs.
 *
 * ## Silence, unconditionally
 *
 * A probe the user can hear is a probe they notice, and the whole point of a
 * hidden session is that they do not. The native side also mutes the WebView
 * outright where the WebView supports it (`WebViewCompat.setAudioMuted`); this
 * is the defence that works everywhere else:
 *
 * - `HTMLMediaElement.prototype.play` sets `muted` before it plays, which
 *   catches every scripted start, including elements in a shadow root and
 *   `new Audio()` objects that are never in the document.
 * - `play` and `volumechange` listeners in the capture phase re-mute anything
 *   that starts by `autoplay` or unmutes itself later. Media events do not
 *   bubble, but the capture phase sees them regardless.
 *
 * ## Pressing play, like the desktop does
 *
 * The desktop probe presses play by running `PRESS_PLAY_SCRIPT`
 * (`src/main/pressplay.ts`) in every frame, which Electron allows because the
 * embedder may script any frame. This is the same routine, reached a
 * different way. The selectors are copied from there rather than imported:
 * that module imports Electron's types and is desktop code this bridge must
 * not reach into. **If one changes, change the other**; they drifted once
 * before (over the ad rules) and a probe measuring a different pipeline from
 * the player went on passing.
 *
 * Differences from the desktop, each deliberate:
 *
 * - It runs on the frame's own clock — the first press 1.5 s after that
 *   frame's document started — because nothing outside can tell a
 *   cross-origin frame when to act. Four presses, because a player nested two
 *   iframes deep may not have built its controls until several seconds in.
 * - It stops pressing in a frame once media there is playing. A later click
 *   on a play control that has become a pause control stops the stream the
 *   probe is trying to observe.
 * - Media is muted before `play()`, for the reason above.
 *
 * Diagnostics go to the console, tagged `[wta-probe]`, which `ProbeSession`
 * forwards to logcat and nothing else — `adb logcat -s ProbeView` shows which
 * frames the script reached, what it pressed, when something played and where
 * it was five seconds later. That last line is the proof that a covered view
 * really decodes: a position that advanced is a picture that was produced.
 * The console and the timer are captured before the page runs, because
 * providers that vendor anti-devtools code replace both.
 */

/** Milliseconds after a frame's document starts at which play is pressed. */
export const PRESS_AT_MS = [1_500, 4_000, 7_000, 11_000]

/**
 * The play controls to look for, in the order the desktop looks.
 * Kept identical to `PRESS_PLAY_SCRIPT`'s first `querySelector`.
 */
const PLAY_SELECTORS =
  '[aria-label*="play" i], [title*="play" i], .play-button, .vjs-big-play-button, .plyr__control--overlaid, #player button'

export interface ProbeScriptOptions {
  /**
   * Press play in every frame. On by default; off only to measure whether a
   * provider starts by itself. Silence is not optional and has no switch.
   */
  pressPlay?: boolean
}

/** The page script, as source text for the native side to install. */
export function probePageScript(options: ProbeScriptOptions = {}): string {
  const pressPlay = options.pressPlay ?? true
  return `(() => {
  const log = console.info.bind(console)
  const later = setTimeout.bind(window)
  const TAG = '[wta-probe]'

  const media = HTMLMediaElement.prototype
  const play = media.play
  media.play = function () {
    this.muted = true
    return play.apply(this, arguments)
  }
  const mute = (event) => {
    const element = event.target
    if (element instanceof HTMLMediaElement && !element.muted) element.muted = true
  }
  document.addEventListener('play', mute, true)
  document.addEventListener('volumechange', mute, true)

  let playing = false
  document.addEventListener('playing', (event) => {
    if (playing) return
    playing = true
    const element = event.target
    log(TAG, 'playing', location.host, element.currentTime.toFixed(1))
    later(() => log(TAG, 'position', location.host, element.currentTime.toFixed(1), element.paused ? 'paused' : 'advancing'), 5000)
  }, true)
  log(TAG, 'installed', location.host)

  if (!${JSON.stringify(pressPlay)}) return

  const pick = () =>
    document.querySelector(${JSON.stringify(PLAY_SELECTORS)}) || document.querySelector('button')

  const press = () => {
    if (playing) return
    try {
      const control = pick()
      if (control) control.click()
      const video = document.querySelector('video')
      if (video && video.paused) video.play().catch(() => {})
      if (control || video) log(TAG, 'pressed', location.host, control ? control.tagName : '-', video ? 'video' : '-')
    } catch (error) {}
  }
  for (const at of ${JSON.stringify(PRESS_AT_MS)}) later(press, at)
})()`
}
