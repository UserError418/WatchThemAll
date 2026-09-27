/**
 * Pressing a source's own play control from inside its frame.
 *
 * Shared by the desktop, where main runs it in every frame with
 * `executeJavaScript` (`main/pressplay.ts`), and the film relay, which runs
 * it on the `press` command on both platforms. The phone has no way to run
 * a script in a frame after the fact, so the relay carries it.
 */

/**
 * Start playback in one frame, whatever the control is called there.
 *
 * Deliberately broad and deliberately harmless: at most one element per frame,
 * and every selector describes something that starts playback. The bare
 * `video.play()` is included because several players attach no visible control
 * until the stream is already resolving.
 */
export const PRESS_PLAY_SCRIPT = `(() => {
  const pick = () =>
    document.querySelector('[aria-label*="play" i], [title*="play" i], .play-button, .vjs-big-play-button, .plyr__control--overlaid, #player button') ??
    document.querySelector('button')
  try {
    pick()?.click()
    const video = document.querySelector('video')
    if (video?.paused) void video.play().catch(() => {})
  } catch {}
  return true
})()`
