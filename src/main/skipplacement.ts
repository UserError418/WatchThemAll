/**
 * Where the Skip Intro button sits over the picture on the desktop.
 *
 * Bottom-right, where every player puts it, but *above* the provider's own
 * control bar rather than on it. It used to sit 28px from the corner, which
 * is exactly where each provider draws its seek bar and its row of buttons:
 * the owner's screenshot (2026-09-27) showed it over the fullscreen button.
 * The button is a native view, so it takes every click inside its rectangle,
 * and anything of the provider's underneath it cannot be pressed at all.
 *
 * Plain geometry with no Electron in it, so the rule can be tested.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * How much of the picture's bottom edge belongs to the provider's controls.
 *
 * Measured 2026-09-27 on the desktop with the controls showing, from the
 * picture's bottom edge to the top of the seek bar: VidRock about 60px,
 * VidFlix and MoviesAPI about 70px, VidLux 88px counting the bar's hit area.
 * Rounded up to 90 for the tallest. These are CSS pixels drawn at the page's
 * own scale, so they do not grow with the window, and the lift must not either.
 */
export const PROVIDER_CONTROLS_PX = 90

/** Clear air between the provider's seek bar and the button. */
export const SKIP_GAP_PX = 16

/**
 * Distance from the picture's right edge. The providers' last icon ends
 * about 15–30px in, so the button's right edge lines up with that column.
 */
export const SKIP_RIGHT_PX = 28

/** The least room kept between the button and any edge of a small picture. */
const EDGE_PX = 12

/**
 * The button's bounds inside `slot`, the rectangle the video occupies.
 *
 * In a picture too short to hold the button above the controls band it stays
 * inside the picture instead, as high as it can go: over the controls, but
 * still whole and still on screen.
 */
export function skipButtonBounds(slot: Rect, size: { width: number; height: number }): Rect {
  const width = Math.max(0, Math.min(size.width, slot.width - SKIP_RIGHT_PX - EDGE_PX))
  const height = Math.max(0, Math.min(size.height, slot.height - EDGE_PX * 2))
  const lifted = slot.y + slot.height - PROVIDER_CONTROLS_PX - SKIP_GAP_PX - height
  return {
    x: slot.x + slot.width - SKIP_RIGHT_PX - width,
    y: Math.max(slot.y + EDGE_PX, lifted),
    width,
    height,
  }
}
