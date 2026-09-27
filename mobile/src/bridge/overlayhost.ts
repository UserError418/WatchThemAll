/**
 * v2's own controls on the phone: `PlayerOverlay`, mounted over the picture.
 * What it says to the top bar goes through `overlayhub.ts`.
 *
 * ## Where the overlay sits
 *
 * Between the surface (299, with `PlayerFrame`'s transparent slot at 300) and
 * the top bar (400): over the picture, under the bar and its panels. The host
 * takes no taps itself; the overlay takes them where it draws, and over the
 * whole picture once it has the film.
 *
 * ## One mount per load
 *
 * The desktop gets a new shell document, and so a fresh overlay, with every
 * source and episode loaded. The phone's surface keeps its iframe and changes
 * its `src`, so the overlay is mounted again on every load instead (`load`):
 * what "started" and "revealed" mean is per load.
 */

import { mount, unmount } from 'svelte'

import PlayerOverlay from '@/player/PlayerOverlay.svelte'
import type { WtaPlayerApi } from '@shared/ipc'

/** Over the picture and `PlayerFrame`'s slot, under the top bar. */
const OVERLAY_Z = 350

export interface OverlayHost {
  /** Mount a fresh overlay over `frame`, the load now in the surface; null takes it down (a blank surface). */
  load(frame: HTMLIFrameElement | null): void
  /** Hidden while the player is in the corner: nothing may be drawn over the mini player's slot. */
  setHidden(hidden: boolean): void
  close(): void
}

export function createOverlayHost(api: WtaPlayerApi): OverlayHost {
  let host: HTMLDivElement | null = null
  let component: Record<string, unknown> | null = null
  let hidden = false

  const unmountOverlay = (): void => {
    if (component) void unmount(component)
    component = null
  }

  return {
    load(frame) {
      unmountOverlay()
      if (frame === null) {
        host?.remove()
        host = null
        return
      }
      if (!host) {
        host = document.createElement('div')
        host.id = 'wta-player-overlay'
        // The overlay decides where it takes taps; the host takes none.
        host.style.cssText = `position: fixed; inset: 0; z-index: ${OVERLAY_Z}; pointer-events: none`
        if (hidden) host.style.display = 'none'
        document.body.appendChild(host)
      }
      component = mount(PlayerOverlay, { target: host, props: { api, frame, touch: true } })
    },
    setHidden(next) {
      hidden = next
      if (host) host.style.display = next ? 'none' : ''
    },
    close() {
      unmountOverlay()
      host?.remove()
      host = null
    },
  }
}

