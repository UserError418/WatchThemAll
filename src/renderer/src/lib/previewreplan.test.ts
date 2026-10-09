import { describe, expect, it } from 'vitest'
import { mayPlanAgain, type HeroNow } from './previewreplan'

/** The trailer (or the still) on show: the plan said no preview, or it gave up with nothing on screen. */
const TRAILER: HeroNow = {
  answered: true,
  streamMounted: false,
  copyLoaded: false,
  playerOpen: false,
  carrying: false,
}

describe('mayPlanAgain', () => {
  it('plans again while the hero shows only the trailer or the still', () => {
    // The case it exists for: "Test all sources" found a fast source, and
    // the view should not have to be opened again to show it.
    expect(mayPlanAgain(TRAILER)).toBe(true)
  })

  it('never interrupts a preview that is loading or playing', () => {
    expect(mayPlanAgain({ ...TRAILER, streamMounted: true })).toBe(false)
  })

  it('never interrupts the kept copy, playing or holding its last frame', () => {
    expect(mayPlanAgain({ ...TRAILER, copyLoaded: true })).toBe(false)
  })

  it('leaves it to the player closing, while the player is open', () => {
    // A play files its result while the player is open; closing it asks
    // for the preview again from where the player stopped.
    expect(mayPlanAgain({ ...TRAILER, playerOpen: true })).toBe(false)
  })

  it('never disturbs Resume carrying the preview over', () => {
    expect(mayPlanAgain({ ...TRAILER, carrying: true })).toBe(false)
  })

  it('waits for the answer already on its way', () => {
    // Also before the view has asked at all: it asks once Resume knows its
    // episode, and that question sees the new results.
    expect(mayPlanAgain({ ...TRAILER, answered: false })).toBe(false)
  })
})
