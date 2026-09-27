/**
 * The Skip Intro button must never sit on the provider's own controls: it is a
 * native view, so whatever of the provider's is underneath it cannot be
 * clicked. That was the bug — the button covered the fullscreen button.
 */

import { describe, expect, it } from 'vitest'

import { PROVIDER_CONTROLS_PX, SKIP_RIGHT_PX, skipButtonBounds, type Rect } from './skipplacement'

/** The size the button reports for itself: 14px text, 13px/26px padding, a border. */
const BUTTON = { width: 132, height: 42 }

const bottom = (r: Rect): number => r.y + r.height
const right = (r: Rect): number => r.x + r.width

describe('skipButtonBounds', () => {
  /** The desktop player as measured: 940 by 915 under Xvfb. */
  const slot = { x: 0, y: 56, width: 940, height: 915 }

  it('keeps the whole button above the provider controls band', () => {
    const bounds = skipButtonBounds(slot, BUTTON)
    expect(bottom(bounds)).toBeLessThanOrEqual(bottom(slot) - PROVIDER_CONTROLS_PX)
  })

  it('keeps the button at its full size, against the right edge', () => {
    const bounds = skipButtonBounds(slot, BUTTON)
    expect(bounds.width).toBe(BUTTON.width)
    expect(bounds.height).toBe(BUTTON.height)
    expect(right(bounds)).toBe(right(slot) - SKIP_RIGHT_PX)
  })

  /** The provider's controls are drawn at a fixed size, so the lift is fixed too. */
  it('lifts by the same amount whatever the size of the picture', () => {
    const small = skipButtonBounds(slot, BUTTON)
    const fullscreen = skipButtonBounds({ x: 0, y: 0, width: 2560, height: 1440 }, BUTTON)
    expect(1440 - bottom(fullscreen)).toBe(bottom(slot) - bottom(small))
  })

  it('stays inside a picture too short to clear the controls', () => {
    const short = { x: 10, y: 20, width: 300, height: 120 }
    const bounds = skipButtonBounds(short, BUTTON)
    expect(bounds.y).toBeGreaterThanOrEqual(short.y)
    expect(bottom(bounds)).toBeLessThanOrEqual(bottom(short))
    expect(bounds.x).toBeGreaterThanOrEqual(short.x)
  })

  /** Zero size is what the view reports while there is no button to show. */
  it('takes no room when the button is not there', () => {
    const bounds = skipButtonBounds(slot, { width: 0, height: 0 })
    expect(bounds.width).toBe(0)
    expect(bounds.height).toBe(0)
  })
})
