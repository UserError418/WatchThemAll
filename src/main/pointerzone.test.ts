/**
 * The sequences that broke the chrome bar, replayed.
 *
 * Each case here is a real report, and every one of them is a *sequence* — the
 * bug was never in a single decision, it was in what the watcher remembered
 * between two of them. That is also why this file exists at all: the real path
 * runs on Electron's `input-event`, which CDP-injected mouse events do not
 * reach, so the only way to drive these orders is to drive the policy directly.
 */

import { describe, expect, it } from 'vitest'
import { createPointerZoneWatcher } from './pointerzone'

const TOP = 90
const REPEAT = 300

const watcher = (): ReturnType<typeof createPointerZoneWatcher> =>
  createPointerZoneWatcher({ topZonePx: TOP, repeatMs: REPEAT })

describe('what crosses the bridge', () => {
  it('reports the first position it sees', () => {
    expect(watcher().move(100, 400, 0)).toBe(false)
  })

  it('says nothing while the answer is unchanged and low', () => {
    const w = watcher()
    expect(w.move(100, 400, 0)).toBe(false)
    expect(w.move(200, 500, 50)).toBeNull()
    expect(w.move(300, 600, 5_000)).toBeNull()
  })

  it('reports each crossing of the zone boundary', () => {
    const w = watcher()
    expect(w.move(100, 400, 0)).toBe(false)
    expect(w.move(100, TOP, 100)).toBe(true)
    expect(w.move(100, TOP + 1, 200)).toBe(false)
  })
})

describe('a pointer that keeps moving inside the zone', () => {
  it('repeats, so the bar can be summoned back after it has hidden', () => {
    // The reason repeats exist. Once the bar has timed out, the only thing that
    // brings it back is a fresh report — and moving from 60 to 58 produces no
    // transition to report.
    const w = watcher()
    expect(w.move(100, 60, 0)).toBe(true)
    expect(w.move(100, 58, REPEAT)).toBe(true)
  })

  it('but not faster than the repeat interval', () => {
    const w = watcher()
    expect(w.move(100, 60, 0)).toBe(true)
    expect(w.move(101, 60, 10)).toBeNull()
    expect(w.move(102, 60, 100)).toBeNull()
    expect(w.move(103, 60, REPEAT)).toBe(true)
  })

  it('never repeats a low position, which nothing downstream acts on', () => {
    const w = watcher()
    expect(w.move(100, 400, 0)).toBe(false)
    expect(w.move(101, 401, 10_000)).toBeNull()
  })
})

describe('a pointer that is not moving', () => {
  it('reports nothing when told it is where it already was', () => {
    // Chromium re-hit-tests after a layout change, and the bar hiding *is* a
    // layout change. Without this the bar could resize the view, be told the
    // pointer is still near the top, and reopen itself in a loop.
    const w = watcher()
    expect(w.move(100, 60, 0)).toBe(true)
    expect(w.move(100, 60, REPEAT * 10)).toBeNull()
    expect(w.move(100, 60, REPEAT * 20)).toBeNull()
  })

  it('distinguishes a sideways move from no move at the same height', () => {
    const w = watcher()
    expect(w.move(100, 60, 0)).toBe(true)
    expect(w.move(140, 60, REPEAT)).toBe(true)
  })
})

describe('leaving the view', () => {
  it('says the pointer is gone when it leaves anywhere but upward', () => {
    const w = watcher()
    expect(w.move(100, 60, 0)).toBe(true)
    expect(w.move(100, 400, 100)).toBe(false)
    // Already `false`, so nothing new to say.
    expect(w.leave(200)).toBeNull()
  })

  it('stays quiet when the pointer leaves upward onto the app\'s own chrome', () => {
    // Saying "not near the top" here would fight the renderer, which can see
    // the pointer perfectly well once it is over the bar — and would shut the
    // bar in the instant the user reached for it.
    const w = watcher()
    expect(w.move(100, 400, 0)).toBe(false)
    expect(w.move(100, 20, 100)).toBe(true)
    expect(w.leave(200)).toBeNull()
  })

  it('reports the pointer gone when it leaves from below the zone', () => {
    const w = watcher()
    expect(w.move(100, 20, 0)).toBe(true)
    expect(w.move(100, 900, 100)).toBe(false)
    expect(w.move(100, 20, 200)).toBe(true)
    // Back down, then out of the window entirely.
    expect(w.move(100, 900, 300)).toBe(false)
    expect(w.leave(400)).toBeNull()
  })
})
