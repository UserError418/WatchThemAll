/**
 * The player's chrome, mounted over the video surface.
 *
 * The desktop equivalent is a whole second renderer entry: `chrome.html` built
 * into its own bundle and loaded into a transparent `WebContentsView` stacked
 * above the player. It needs to be a separate document there because the app
 * window's page always paints *beneath* the window's native child views, so
 * controls drawn in it would render behind the picture.
 *
 * None of that applies here. The video surface is an `<iframe>` in this very
 * document (see `playersurface.ts`), so the chrome is simply another element
 * with a higher `z-index` — no second bundle, no second document, no IPC. The
 * component is the desktop's, unmodified apart from the `touch` prop it takes
 * for the two behaviours that need a pointer.
 *
 * ## Mounted with the player, not with the app
 *
 * `PlayerChrome` learns what it is framing from `wtaChrome.onContext`, a
 * subscription that only ever *sets* a context and never clears one — because
 * on desktop the view it lives in is created when playback starts and
 * destroyed when it ends, so "no context" is not a state it can be in. Keeping
 * that true here is cheaper than teaching the component a state it has never
 * needed, so this mounts and unmounts with the player too.
 */

import { mount, unmount } from 'svelte'

import PlayerChrome from '@/PlayerChrome.svelte'

/**
 * Above the surface's 299 and above `PlayerFrame`'s own 300.
 *
 * The surface sits *behind* the frame so that `mobile.css` can punch a hole in
 * the frame the shape of the video; the chrome has to be in front of both, or
 * it is the thing behind the picture instead.
 */
const CHROME_Z = 400

export interface ChromeOverlay {
  /** Put the chrome on screen. Safe to call when it already is. */
  open(): void
  /** Take it down. Safe to call when nothing is open. */
  close(): void
}

export function createChromeOverlay(): ChromeOverlay {
  let host: HTMLDivElement | null = null
  let component: Record<string, unknown> | null = null

  return {
    open() {
      if (host) return

      host = document.createElement('div')
      host.id = 'wta-player-chrome'
      host.style.cssText = [
        'position: fixed',
        'inset: 0',
        `z-index: ${CHROME_Z}`,
        /*
          The host covers the whole screen so the bar can sit at the top and a
          banner can float anywhere, but it must not intercept a single tap it
          does not paint on — everything underneath is the provider's own
          controls. `mobile.css` restores `pointer-events: auto` on the chrome
          itself; this is the same inversion `.player` already uses.
        */
        'pointer-events: none',
      ].join(';')

      document.body.appendChild(host)
      component = mount(PlayerChrome, { target: host, props: { touch: true } })
    },

    close() {
      if (component) void unmount(component)
      component = null
      host?.remove()
      host = null
    },
  }
}
