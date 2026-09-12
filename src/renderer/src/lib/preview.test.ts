import { beforeEach, describe, expect, it } from 'vitest'
import { previewAudio, previewId } from './preview.svelte'

/**
 * Only one preview may be audible at a time.
 *
 * This is not a nicety. Previews play with sound by default, the browse
 * billboard starts on its own after a couple of seconds, and a hovered card
 * starts its own trailer on top of that — without an owner rule the user hears
 * two soundtracks over each other and the app sounds broken.
 *
 * The handover cases below are the ones that are easy to get subtly wrong, and
 * each failure mode is silent: nothing throws, the sound is just wrong.
 */

const billboard = 'billboard-fixed'
const card = 'card-fixed'

beforeEach(() => {
  previewAudio.release(previewAudio.owner ?? '')
})

describe('taking and giving back the sound', () => {
  it('starts with nobody holding it, so an ambient surface may claim', () => {
    expect(previewAudio.free).toBe(true)
  })

  it('lets the newest preview take the sound from the current holder', () => {
    previewAudio.claim(billboard)
    previewAudio.claim(card)

    // Hovering a card is deliberate; the billboard is ambient. The deliberate
    // one wins, which means the last claim wins.
    expect(previewAudio.holds(card)).toBe(true)
    expect(previewAudio.holds(billboard)).toBe(false)
  })

  it('frees the sound when the holder stops', () => {
    previewAudio.claim(card)
    previewAudio.release(card)

    expect(previewAudio.free).toBe(true)
  })

  /**
   * The ordering bug this exists to prevent: a card that was superseded and
   * then stopped must not silence whatever took over from it. Without the
   * ownership check in `release`, the pointer leaving an old card would mute
   * the preview the user is actually looking at.
   */
  it('ignores a release from a surface that no longer holds the sound', () => {
    previewAudio.claim(card)
    previewAudio.claim(billboard)
    previewAudio.release(card)

    expect(previewAudio.holds(billboard)).toBe(true)
    expect(previewAudio.free).toBe(false)
  })

  it('reports itself free again after the real holder releases', () => {
    previewAudio.claim(card)
    previewAudio.claim(billboard)
    previewAudio.release(card)
    previewAudio.release(billboard)

    // Free is what lets the billboard's effect re-claim, so a card hover
    // followed by a mouse-out ends with the ambient preview audible again.
    expect(previewAudio.free).toBe(true)
  })
})

describe('surface ids', () => {
  it('gives every instance a distinct id', () => {
    // Two cards in the same row must not be able to hold the sound as one, or
    // sweeping between them would leave both unmuted.
    expect(previewId('card')).not.toBe(previewId('card'))
  })

  it('keeps the surface name in the id, which is what makes a log readable', () => {
    expect(previewId('billboard')).toMatch(/^billboard-\d+$/)
  })
})
