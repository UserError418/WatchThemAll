/**
 * Pressing play, the way a user would.
 *
 * Not every embed autoplays. Several show a poster and resolve the stream only
 * on the first gesture, so anything that measures a provider without clicking
 * reports those as having no stream at all — which would condemn a provider
 * that works perfectly.
 *
 * This lives in its own module because two places need it and a second copy is
 * how they drift. That is not a hypothetical worry here: the probe and the
 * player had already drifted once, over the ad rules, and the health check went
 * on passing while measuring a pipeline no user had.
 *
 * ## Two mechanisms, because each covers the other's blind spot
 *
 * `sendInputEvent` is a real mouse event at the browser level: it lands where
 * it would for a person and counts as the user gesture autoplay policies ask
 * for. What it cannot do is *find* a button — it fires at the centre of the
 * viewport and hits whatever is there.
 *
 * So a DOM click follows, in every frame. A cross-origin frame is scriptable
 * from here: `executeJavaScript` runs in any frame regardless of origin, which
 * is a privilege of being the embedder and the same mechanism the player uses
 * to read the video's position. Videasy forced this — its play button sits well
 * off centre, so the mouse event missed it every time.
 */

import type { WebContents } from 'electron'

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

/** A synthetic left click at the centre of the given viewport. */
export function clickCentre(contents: WebContents, width: number, height: number): void {
  if (contents.isDestroyed()) return
  const x = Math.round(width / 2)
  const y = Math.round(height / 2)
  contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
}

/** Run the play script in every frame of the subtree. */
export async function clickPlayInFrames(contents: WebContents): Promise<void> {
  if (contents.isDestroyed()) return
  // A frame can be gone by the time its turn comes. That is ordinary here, and
  // one detached frame must not abandon the rest of the subtree.
  for (const frame of contents.mainFrame.framesInSubtree) {
    try {
      await frame.executeJavaScript(PRESS_PLAY_SCRIPT, true)
    } catch {
      /* frame detached or navigated away */
    }
  }
}

/** Both mechanisms, once. Callers repeat it for players still building their UI. */
export async function pressPlay(
  contents: WebContents,
  width: number,
  height: number,
): Promise<void> {
  clickCentre(contents, width, height)
  await clickPlayInFrames(contents)
}
