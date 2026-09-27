import { describe, expect, it } from 'vitest'

import { createOverlayHub } from './overlayhub'

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('createOverlayHub', () => {
  /**
   * Delivered at once, the top bar's handler ran inside our controls' effect
   * and looped it (`effect_update_depth_exceeded` on the emulator). IPC never
   * delivers inside the sender's call, and neither may this.
   */
  it('delivers a message after the sender returns, never during its call', async () => {
    const hub = createOverlayHub()
    const heard: boolean[] = []
    hub.chrome.onActivity((hold) => heard.push(hold))
    hub.activity(true)
    expect(heard).toEqual([])
    await settle()
    expect(heard).toEqual([true])
  })

  it('ends with the bar as it was last said, however quickly it changed', async () => {
    const hub = createOverlayHub()
    const seen: boolean[] = []
    hub.onBarState((state) => seen.push(state.visible))
    hub.chrome.setOverlayArea({ height: 0, width: null, barVisible: false })
    hub.chrome.setOverlayArea({ height: 64, width: null, barVisible: true })
    await settle()
    expect(seen.at(-1)).toBe(true)
  })

  it('knows when a panel is open, for Back', () => {
    const hub = createOverlayHub()
    expect(hub.panelOpen()).toBe(false)
    hub.chrome.setOverlayArea({ height: 10_000, width: null, barVisible: true, sourcesOpen: true })
    expect(hub.panelOpen()).toBe(true)
  })
})
