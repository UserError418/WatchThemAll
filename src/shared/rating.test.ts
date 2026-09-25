import { describe, expect, it } from 'vitest'
import {
  LEGACY_DISLIKE_VALUE,
  LEGACY_LIKE_VALUE,
  isRatingValue,
  legacyRatingOf,
  ratingBand,
  ratingForEntry,
  ratingForScope,
  valueOfLegacy,
} from './rating'
import type { RatingValue } from './types'

const RATINGS = [
  { tmdbId: 1396, season: null, value: 9 as const },
  { tmdbId: 2316, season: 3, value: 4 as const },
  { tmdbId: 2316, season: 4, value: 7 as const },
]

const EVERY_VALUE: RatingValue[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

describe('the legacy conversion', () => {
  /** the owner's explicit requirement, pinned so nobody "tidies" it to 10 and 1. */
  it('turns a like into an 8 and a dislike into a 4', () => {
    expect(LEGACY_LIKE_VALUE).toBe(8)
    expect(LEGACY_DISLIKE_VALUE).toBe(4)
    expect(valueOfLegacy('like')).toBe(8)
    expect(valueOfLegacy('dislike')).toBe(4)
  })

  /**
   * The property the midpoint exists for: a record that crosses to an old
   * build and back does not drift, however many times it makes the trip.
   */
  it('round-trips exactly through the two-valued form', () => {
    expect(legacyRatingOf(valueOfLegacy('like'))).toBe('like')
    expect(legacyRatingOf(valueOfLegacy('dislike'))).toBe('dislike')
  })

  it('reads 6 and above as a like for builds that know only two values', () => {
    expect(EVERY_VALUE.filter((v) => legacyRatingOf(v) === 'like')).toEqual([6, 7, 8, 9, 10])
  })
})

describe('isRatingValue', () => {
  it('accepts the whole numbers 1 to 10', () => {
    expect(EVERY_VALUE.every(isRatingValue)).toBe(true)
  })

  /** A TMDB score is the thing most likely to be passed here by mistake. */
  it('rejects a TMDB score, zero, out-of-range numbers and non-numbers', () => {
    for (const x of [7.4, 0, 11, -1, NaN, Infinity, '8', null, undefined, 'like']) {
      expect(isRatingValue(x)).toBe(false)
    }
  })
})

describe('ratingBand', () => {
  it('reads 8–10 as liked, 6–7 as mixed and 1–5 as disliked', () => {
    const bands = Object.fromEntries(EVERY_VALUE.map((v) => [v, ratingBand(v)]))
    expect(bands).toEqual({
      1: 'disliked', 2: 'disliked', 3: 'disliked', 4: 'disliked', 5: 'disliked',
      6: 'mixed', 7: 'mixed',
      8: 'liked', 9: 'liked', 10: 'liked',
    })
  })

  /**
   * Why the upgrade does not reshuffle the Watched tab: every converted like
   * is still under "Liked", every dislike under "Disliked", and "Mixed" starts
   * empty.
   */
  it('keeps every converted rating in the band its thumb was', () => {
    expect(ratingBand(valueOfLegacy('like'))).toBe('liked')
    expect(ratingBand(valueOfLegacy('dislike'))).toBe('disliked')
  })
})

describe('ratingForScope', () => {
  it('finds a whole-title opinion', () => {
    expect(ratingForScope(RATINGS, 1396, null)).toBe(9)
  })

  it('finds the opinion for one season without catching its neighbours', () => {
    expect(ratingForScope(RATINGS, 2316, 3)).toBe(4)
    expect(ratingForScope(RATINGS, 2316, 4)).toBe(7)
    expect(ratingForScope(RATINGS, 2316, 5)).toBeNull()
  })

  /**
   * The distinction the season scope exists to draw. Falling back to the series
   * opinion would make every season of a liked show look individually liked,
   * and the Unrated tab would then have nothing left to show.
   */
  it('does not answer a season question with the series opinion', () => {
    expect(ratingForScope(RATINGS, 1396, 2)).toBeNull()
  })

  /** And not the other way round either: a rated season leaves the series unrated. */
  it('does not answer a series question with a season opinion', () => {
    expect(ratingForScope(RATINGS, 2316, null)).toBeNull()
  })

  /**
   * Unresolved imports all carry `tmdbId: 0`, so they share one opinion. That
   * is accepted rather than guarded: `rate` writes the rating under `tv:0`
   * either way, and refusing to read it back makes the buttons look broken.
   */
  it('reads back a rating on an unresolved title', () => {
    expect(ratingForScope([{ tmdbId: 0, season: null, value: 8 }], 0, null)).toBe(8)
  })

  /** Ratings written before 1.5.7 have no season field at all. */
  it('treats a missing season as the whole title', () => {
    expect(ratingForScope([{ tmdbId: 7, value: 8 }], 7, null)).toBe(8)
  })
})

describe('ratingForEntry', () => {
  /**
   * The reported bug, as a test. The Watched tab listed a season the user had
   * just rated under "Unrated", because it asked for the *series* opinion while
   * the card's own buttons set the *season* one. Both calls were well-typed;
   * they disagreed about an argument one of them left out.
   */
  it('uses the entry own scope, so a rated season is not listed as unrated', () => {
    const entry = { tmdbId: 2316, season: 4 }
    expect(ratingForEntry(RATINGS, entry)).toBe(7)
  })

  it('uses the whole title for a film or a legacy entry', () => {
    expect(ratingForEntry(RATINGS, { tmdbId: 1396, season: null })).toBe(9)
  })

  it('reports no opinion for a season nobody has rated', () => {
    expect(ratingForEntry(RATINGS, { tmdbId: 2316, season: 9 })).toBeNull()
  })
})
