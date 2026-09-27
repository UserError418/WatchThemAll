import { describe, expect, it } from 'vitest'

import { fitToDisplay } from './windowstate'

/** The owner's display: 3840×2160 at 135%. */
const display = { width: 2844, height: 1600 }

describe('fitToDisplay', () => {
  it("opens a window saved at the display's full size maximized", () => {
    expect(fitToDisplay({ x: 0, y: 0, width: 2844, height: 1600, maximized: false }, display)).toEqual({
      width: 1440,
      height: 900,
      maximized: true,
    })
  })

  it('leaves a window that fits alone', () => {
    const saved = { x: 200, y: 100, width: 1440, height: 900, maximized: false }
    expect(fitToDisplay(saved, display)).toEqual(saved)
  })

  it('leaves room for the title bar on a narrow window that is too tall', () => {
    expect(fitToDisplay({ width: 1400, height: 1590 }, display)).toEqual({ width: 1400, height: 1552 })
  })

  it('treats a window from a larger display as maximized on a smaller one', () => {
    expect(fitToDisplay({ width: 3000, height: 1800 }, { width: 1920, height: 1080 })).toEqual({
      width: 1440,
      height: 900,
      maximized: true,
    })
  })
})
