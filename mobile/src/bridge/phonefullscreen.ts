/**
 * Fullscreen on the phone, for v2's own controls (the owner, 2026-09-27:
 * "rotate = fullscreen").
 *
 * - Turning the phone sideways goes fullscreen (the status bar hides), and
 *   turning it upright leaves it.
 * - Our fullscreen button locks landscape, so it works held upright too.
 * - Leaving by the button while the phone is still held sideways would go
 *   straight back in by the first rule. So the button leaves into a portrait
 *   lock, released once the phone is physically upright
 *   (`deviceorientation`): from then on, turning it sideways goes fullscreen
 *   again. That is how YouTube behaves.
 *
 * Only while the full player is on screen (`active`): not in the corner, not
 * while casting, not with the player closed.
 */

import { ScreenOrientation } from '@capacitor/screen-orientation'
import { StatusBar } from '@capacitor/status-bar'

export interface PhoneFullscreen {
  /** Whether we are fullscreen now. */
  current(): boolean
  /** Our button. */
  toggle(): void
  /** The full player is on screen (true), or not (false: mini, casting, closed). */
  setActive(active: boolean): void
}

/** How upright counts as upright: tilted back less than this from vertical, and not on its side. */
const UPRIGHT_BETA_MIN = 45
const UPRIGHT_GAMMA_MAX = 30

export function createPhoneFullscreen(onChange: (fullscreen: boolean) => void): PhoneFullscreen {
  let active = false
  let fullscreen = false
  /** Left by the button: held in portrait until the phone is upright. */
  let heldUpright = false
  /** Our button locked landscape: ours to unlock, and nobody else's lock is. */
  let lockedLandscape = false
  const landscape = window.matchMedia('(orientation: landscape)')

  const apply = (next: boolean): void => {
    if (next === fullscreen) return
    fullscreen = next
    void (next ? StatusBar.hide() : StatusBar.show()).catch(() => {})
    onChange(next)
  }

  const onOrientation = (): void => {
    if (!active || heldUpright) return
    apply(landscape.matches)
  }

  const onTilt = (event: DeviceOrientationEvent): void => {
    if (!heldUpright) return
    const beta = event.beta ?? 0
    const gamma = Math.abs(event.gamma ?? 90)
    if (beta >= UPRIGHT_BETA_MIN && gamma <= UPRIGHT_GAMMA_MAX) release()
  }

  const release = (): void => {
    heldUpright = false
    window.removeEventListener('deviceorientation', onTilt)
    void ScreenOrientation.unlock().catch(() => {})
  }

  landscape.addEventListener('change', onOrientation)

  return {
    current: () => fullscreen,

    toggle() {
      if (!active) return
      if (!fullscreen) {
        heldUpright = false
        window.removeEventListener('deviceorientation', onTilt)
        lockedLandscape = true
        void ScreenOrientation.lock({ orientation: 'landscape' }).catch(() => {})
        apply(true)
        return
      }
      lockedLandscape = false
      heldUpright = true
      window.addEventListener('deviceorientation', onTilt)
      void ScreenOrientation.lock({ orientation: 'portrait' }).catch(() => {})
      apply(false)
    },

    setActive(next) {
      if (next === active) return
      active = next
      if (active) {
        // Already sideways when the player comes up: that is a request too.
        onOrientation()
        return
      }
      // Only our own locks: casting sets one of its own after this.
      if (heldUpright) release()
      else if (lockedLandscape) void ScreenOrientation.unlock().catch(() => {})
      lockedLandscape = false
      apply(false)
    },
  }
}
