/**
 * Weighted towards refusing bad data, because the two mistakes are not
 * symmetric: a refused good segment costs one button nobody presses, and an
 * accepted bad one throws somebody into the middle of their own episode with
 * no way to tell whether they lost the intro or the first scene.
 *
 * The real timestamps here were read from the live databases and checked by
 * hand against the shows, so a change that breaks them is a change that breaks
 * the feature on its most popular titles.
 */

import { describe, expect, it } from 'vitest'

import {
  SOURCE_ORDER,
  chooseSegment,
  isWithinOffer,
  skipTarget,
  vetSegment,
  type SkipSegment,
} from './skiptimes'

const seg = (
  startSeconds: number,
  endSeconds: number,
  source: SkipSegment['source'] = 'introdb',
): SkipSegment => ({ startSeconds, endSeconds, source })

describe('choosing between databases', () => {
  it('prefers IntroDB, which measured both broader and more accurate', () => {
    const picked = chooseSegment([seg(100, 190, 'skipdb'), seg(437, 531, 'introdb')])
    expect(picked?.source).toBe('introdb')
  })

  it('falls through to SkipDB, then AniSkip', () => {
    expect(chooseSegment([seg(1, 90, 'aniskip'), seg(2, 91, 'skipdb')])?.source).toBe('skipdb')
    expect(chooseSegment([seg(1, 90, 'aniskip')])?.source).toBe('aniskip')
  })

  it('has an answer for nothing at all', () => {
    expect(chooseSegment([null, null, null])).toBeNull()
  })

  it('names every source it claims to order', () => {
    // A source added to the fetchers and forgotten here would be silently
    // unreachable — `chooseSegment` only returns what the order lists.
    expect([...SOURCE_ORDER].sort()).toEqual(['aniskip', 'introdb', 'skipdb'])
  })
})

describe('segments that are about this stream', () => {
  it('accepts the real Game of Thrones S01E01 intro', () => {
    // 437-531s, verified by hand: the cold open runs past seven minutes.
    const vet = vetSegment({
      segment: seg(437, 531),
      streamSeconds: 3720,
      expectedMinutes: 62,
    })
    expect(vet.ok).toBe(true)
  })

  it('accepts a very short title card', () => {
    // Breaking Bad S02E05, 74-90s. Sixteen seconds is a real intro on that
    // show, and a minimum tuned to anime openings would have thrown it out.
    expect(vetSegment({ segment: seg(74, 90), streamSeconds: 2849, expectedMinutes: 47 }).ok).toBe(
      true,
    )
  })

  it('accepts one that starts at zero', () => {
    // The Office and Friends both open cold on the titles.
    expect(vetSegment({ segment: seg(0, 31), streamSeconds: 1380, expectedMinutes: 23 }).ok).toBe(
      true,
    )
  })

  it('accepts when TMDB has no runtime to compare against', () => {
    const vet = vetSegment({ segment: seg(60, 150), streamSeconds: 1440, expectedMinutes: null })
    expect(vet.ok).toBe(true)
  })
})

describe('segments that are not', () => {
  it('refuses one that runs past the end of the stream', () => {
    // The reference cut is longer than what this provider served, so every
    // number derived from it is off by an unknown amount.
    const vet = vetSegment({ segment: seg(3400, 3500), streamSeconds: 2700, expectedMinutes: 45 })
    expect(vet.ok).toBe(false)
    expect(vet.reason).toContain('stream is only')
  })

  it('refuses when the stream is the wrong length for the episode', () => {
    // Measured: a provider served a 71-minute programme for a 49-minute
    // episode. The intro timestamps for the real episode mean nothing here.
    const vet = vetSegment({ segment: seg(505, 555), streamSeconds: 4288, expectedMinutes: 49 })
    expect(vet.ok).toBe(false)
    expect(vet.reason).toContain('wrong length')
  })

  it('refuses before the stream has reported a duration', () => {
    expect(vetSegment({ segment: seg(60, 150), streamSeconds: 0, expectedMinutes: 24 }).ok).toBe(
      false,
    )
  })

  it('refuses a three-second stinger', () => {
    expect(vetSegment({ segment: seg(60, 63), streamSeconds: 1440, expectedMinutes: 24 }).ok).toBe(
      false,
    )
  })

  it('refuses a six-minute "intro"', () => {
    expect(vetSegment({ segment: seg(60, 420), streamSeconds: 3600, expectedMinutes: 60 }).ok).toBe(
      false,
    )
  })

  it('refuses an intro in the back third, which is a mislabelled outro', () => {
    const vet = vetSegment({ segment: seg(3400, 3460), streamSeconds: 3600, expectedMinutes: 60 })
    expect(vet.ok).toBe(false)
    expect(vet.reason).toContain('would not start')
  })

  it('refuses an inverted or empty interval', () => {
    expect(vetSegment({ segment: seg(150, 60), streamSeconds: 1440, expectedMinutes: 24 }).ok).toBe(
      false,
    )
    expect(vetSegment({ segment: seg(60, 60), streamSeconds: 1440, expectedMinutes: 24 }).ok).toBe(
      false,
    )
  })

  it('refuses NaN rather than propagating it into a seek', () => {
    const vet = vetSegment({
      segment: seg(Number.NaN, 90),
      streamSeconds: 1440,
      expectedMinutes: 24,
    })
    expect(vet.ok).toBe(false)
  })
})

describe('when the button is on screen', () => {
  const intro = seg(437, 531)

  it('is absent before the intro and after it', () => {
    expect(isWithinOffer(intro, 100)).toBe(false)
    expect(isWithinOffer(intro, 531)).toBe(false)
    expect(isWithinOffer(intro, 900)).toBe(false)
  })

  it('appears just before the intro starts', () => {
    // The databases disagree by a second or two on where an intro begins; a
    // button that is a moment early reads as ready, a late one as broken.
    expect(isWithinOffer(intro, 435)).toBe(true)
    expect(isWithinOffer(intro, 434)).toBe(false)
  })

  it('stays for the whole intro', () => {
    expect(isWithinOffer(intro, 437)).toBe(true)
    expect(isWithinOffer(intro, 500)).toBe(true)
    expect(isWithinOffer(intro, 530.9)).toBe(true)
  })

  it('does not go negative for an intro at the very start', () => {
    expect(isWithinOffer(seg(0, 31), 0)).toBe(true)
  })

  it('lands just past the end, not exactly on it', () => {
    // Some players show the last frame of the title card when seeked to the
    // boundary exactly.
    expect(skipTarget(intro)).toBeGreaterThan(531)
    expect(skipTarget(intro)).toBeLessThan(532)
  })
})
