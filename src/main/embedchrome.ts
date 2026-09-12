/**
 * Hiding YouTube's own player chrome inside preview embeds.
 *
 * ## Why this is possible here and not in a web page
 *
 * The trailer previews are `youtube-nocookie.com` iframes. That document is
 * cross-origin, so nothing running in the renderer — no stylesheet, no script —
 * can reach into it. Three earlier attempts worked around that from the outside
 * and all three failed in their own way: `controls=0` does not remove the title
 * and share overlay, cropping the frame only moves the overlay rather than
 * removing it, and hiding the iframe until playback began deadlocked, because
 * Chromium will not autoplay a frame it considers invisible.
 *
 * An Electron main process is not a web page. `WebFrameMain.executeJavaScript`
 * runs script in *any* frame of a `WebContents`, cross-origin included — that is
 * a privilege of the embedder, not of the page. So the chrome can simply be
 * styled away at the source, which is what this does.
 *
 * ## What it is careful about
 *
 * Only named chrome classes are hidden, never a wildcard. `[class*="ytp-"]`
 * would be shorter and would also match the player root and the video container
 * itself, hiding the picture along with the buttons.
 *
 * The rule is a stylesheet rather than a sweep of `element.remove()` calls.
 * YouTube's player builds and rebuilds its overlays as playback state changes,
 * so anything removed comes back; a stylesheet keeps applying to whatever is
 * created later, and needs to run only once per frame.
 */

import { webFrameMain } from 'electron'
import type { WebContents } from 'electron'

/** Preview embeds are all loaded from here; see `TrailerEmbed.svelte`. */
const EMBED_HOST = 'youtube-nocookie.com'

const STYLE_ID = 'wta-embed-chrome'

/** See the retry note in `suppressEmbedChrome`; the second attempt is the one that lands. */
const MAX_INJECT_ATTEMPTS = 6
const INJECT_BACKOFF_MS = 300

/**
 * The overlays a preview must not show.
 *
 * Each is a thing YouTube draws *over* the video: the title and share buttons
 * across the top, the gradients that back them, the watermark, the big play
 * button on a cued player, the end-screen cards, and the grid of suggestions it
 * puts up when paused. The transport bar is included even though `controls=0`
 * already suppresses it, because that parameter is advisory and this is not.
 */
const HIDDEN_SELECTORS = [
  '.ytp-chrome-top',
  '.ytp-chrome-bottom',
  '.ytp-chrome-controls',
  '.ytp-gradient-top',
  '.ytp-gradient-bottom',
  '.ytp-title',
  '.ytp-title-text',
  '.ytp-show-cards-title',
  '.ytp-watermark',
  '.ytp-impression-link',
  '.ytp-pause-overlay',
  '.ytp-endscreen-content',
  '.ytp-ce-element',
  '.ytp-cued-thumbnail-overlay',
  '.ytp-large-play-button',
  '.ytp-spinner',
  '.ytp-timely-actions-content',
  '.ytp-paid-content-overlay',
  '.annotation',
]

/**
 * Injected verbatim into the embed's document.
 *
 * `pointer-events: none` as well as `display: none`, because a couple of these
 * are click targets that YouTube re-shows on hover; if one ever escapes the
 * display rule it must still not be clickable — a preview that navigates the
 * frame to youtube.com when brushed with the mouse is worse than a visible
 * button.
 */
const INJECTED_SCRIPT = `(() => {
  if (document.getElementById(${JSON.stringify(STYLE_ID)})) return 'already'
  const style = document.createElement('style')
  style.id = ${JSON.stringify(STYLE_ID)}
  style.textContent = ${JSON.stringify(
    `${HIDDEN_SELECTORS.join(',\n')} { display: none !important; opacity: 0 !important; pointer-events: none !important; }`,
  )}
  ;(document.head || document.documentElement).appendChild(style)
  return 'injected'
})()`

/**
 * Style away the chrome of every YouTube embed this `WebContents` loads.
 *
 * Attach once per window. `did-frame-navigate` is the hook because it fires for
 * *sub*frame navigations, which is the only kind a preview performs — the app's
 * own document never leaves its page.
 */
export function suppressEmbedChrome(contents: WebContents): void {
  contents.on(
    'did-frame-navigate',
    (_event, url, _httpResponseCode, _httpStatusText, isMainFrame, frameProcessId, frameRoutingId) => {
      if (isMainFrame || !url.includes(EMBED_HOST)) return

      const frame = webFrameMain.fromId(frameProcessId, frameRoutingId)
      if (!frame) return

      /**
       * Retry, because the first attempt always fails.
       *
       * `did-frame-navigate` fires when the navigation *commits*, which is
       * before the frame will accept script — measured, the first call rejects
       * every time and the second succeeds. The rejection carries no message,
       * so there is nothing to branch on; retrying briefly is the only way to
       * tell "too early" from "this frame is gone".
       *
       * Backs off and gives up rather than looping: a preview the pointer has
       * already left is destroyed mid-sequence, and that is a normal outcome
       * rather than an error worth reporting.
       */
      let attempt = 0
      const inject = (): void => {
        attempt += 1
        frame.executeJavaScript(INJECTED_SCRIPT, false).catch(() => {
          if (attempt < MAX_INJECT_ATTEMPTS) setTimeout(inject, INJECT_BACKOFF_MS * attempt)
        })
      }
      inject()
    },
  )
}
