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
 * Only named chrome is hidden, never a wildcard. `[class*="ytp-"]` would be
 * shorter and would also match the player root and the video container itself,
 * hiding the picture along with the buttons.
 *
 * Nothing that *contains the video* is ever hidden, only drawn transparent —
 * see `TRANSPARENT_SELECTORS`. Hiding the picture is the one move that
 * deadlocks: a player Chromium considers invisible does not autoplay, and a
 * paused YouTube player draws exactly the overlay this file exists to remove.
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

/**
 * How often, and for how long, to retry the injection; see `suppressEmbedChrome`.
 *
 * Tight rather than backed off, because the stylesheet has to land before
 * YouTube paints: the first attempt is always refused, and with the old
 * 300 ms back-off the second one arrived after the embed had already drawn its
 * spinner and black page. The ceiling only bounds the work for a frame that
 * never accepts script at all.
 */
const INJECT_RETRY_MS = 16
const INJECT_GIVE_UP_MS = 4_000

/**
 * The overlays a preview must not show.
 *
 * YouTube serves two different player UIs to embeds, and which one arrives is
 * YouTube's choice, not ours — so both are listed.
 *
 * **The current one** (seen in every embed as of 2026-09-26) puts its entire
 * control layer in one element, `#player-controls`, a sibling of the player
 * rather than a child of it: the centre transport (previous / play-pause /
 * next), the title and channel row, the loading spinner, the "More videos"
 * strip, the "Watch on YouTube" wordmark, the cued-state play button and
 * thumbnail, and the end-of-video suggestions. Hiding that one host removes
 * all of it. None of the older `.ytp-*` selectors match any of it, which is
 * why the start-up overlay came back while this file still looked correct.
 *
 * **The older one** draws the same things as `.ytp-*` elements inside the
 * player: the title and share buttons across the top, the gradients that back
 * them, the watermark, the big play button on a cued player, the end-screen
 * cards, the grid of suggestions it puts up when paused. The transport bar is
 * included even though `controls=0` already suppresses it, because that
 * parameter is advisory and this is not.
 *
 * Both share the caption layer and the "tap to unmute" pill, which muted
 * autoplay — every preview — invites. Captions are also unloaded over the
 * iframe API (see `TrailerEmbed.svelte`); this is the guarantee that they never
 * show even for the instant before that command lands.
 */
const HIDDEN_SELECTORS = [
  // Current player UI.
  '#player-controls',
  // Older player UI.
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
  // Both.
  '.ytp-unmute',
  '.ytp-caption-window-container',
  '.caption-window',
]

/**
 * The page and the player boxes around the video, drawn see-through.
 *
 * YouTube paints all of these black (the root white), so between the iframe
 * appearing and the first video frame a preview used to be a black rectangle
 * — the better part of a second on every hover. Transparent, the artwork the
 * preview sits on shows through until the video has a frame to cover it with,
 * and the switch from still to motion is the only change the user sees.
 *
 * Background only. The boxes stay laid out and visible, and the `<video>`
 * itself is untouched, so the player is exactly as "visible" to Chromium's
 * autoplay rules as before.
 */
const TRANSPARENT_SELECTORS = [
  'html',
  'body',
  '#player',
  '#movie_player',
  '.html5-video-player',
  '.html5-video-container',
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
const STYLESHEET =
  `${HIDDEN_SELECTORS.join(',\n')} { display: none !important; opacity: 0 !important; pointer-events: none !important; }\n` +
  `${TRANSPARENT_SELECTORS.join(',\n')} { background: transparent !important; }`

const INJECTED_SCRIPT = `(() => {
  if (document.getElementById(${JSON.stringify(STYLE_ID)})) return 'already'
  const style = document.createElement('style')
  style.id = ${JSON.stringify(STYLE_ID)}
  style.textContent = ${JSON.stringify(STYLESHEET)}
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
       * before the frame will accept script — measured, the first call is
       * refused every time. The refusal carries no message, so there is
       * nothing to branch on; retrying on a short interval is the only way to
       * tell "too early" from "this frame is gone", and it lands the stylesheet
       * within a frame or two of the document existing.
       *
       * Gives up rather than looping forever: a preview the pointer has
       * already left is destroyed mid-sequence, and that is a normal outcome
       * rather than an error worth reporting.
       */
      const navigatedAt = Date.now()
      const inject = (): void => {
        if (frame.isDestroyed()) return
        frame.executeJavaScript(INJECTED_SCRIPT, false).catch(() => {
          if (Date.now() - navigatedAt < INJECT_GIVE_UP_MS) setTimeout(inject, INJECT_RETRY_MS)
        })
      }
      inject()
    },
  )
}
