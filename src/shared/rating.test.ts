import { describe, expect, it } from 'vitest'
import {
  LEGACY_DISLIKE_VALUE,
  LEGACY_LIKE_VALUE,
  isRatingValue,
  legacyRatingOf,
  indexRatings,
  ratingBand,
  ratingScope,
  valueOfLegacy,
} from './rating'
import type { RatingValue } from './types'

const RATINGS = [
  { type: 'tv' as const, tmdbId: 1396, season: null, value: 9 as const },
  { type: 'tv' as const, tmdbId: 2316, season: 3, value: 4 as const },
  { type: 'tv' as const, tmdbId: 2316, season: 4, value: 7 as const },
]

const EVERY_VALUE: RatingValue[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

describe('the legacy conversion', () => {
  /** An explicit requirement, pinned so nobody "tidies" it to 10 and 1. */
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

describe('indexRatings', () => {
  type Rated = { type: 'tv' | 'movie'; tmdbId: number; season?: number | null; value: RatingValue }
  const valueAt = (ratings: Rated[], tmdbId: number, season: number | null, type: Rated['type'] = 'tv'): RatingValue | null =>
    indexRatings(ratings).get(ratingScope(type, tmdbId, season))?.value ?? null

  /** TMDB numbers films and series separately: the same number is two titles. */
  it('keeps a film and a series that share a TMDB number apart', () => {
    const shared: Rated[] = [...RATINGS, { type: 'movie', tmdbId: 1396, season: null, value: 2 }]
    expect(valueAt(shared, 1396, null, 'tv')).toBe(9)
    expect(valueAt(shared, 1396, null, 'movie')).toBe(2)
  })

  it('finds a whole-title opinion', () => {
    expect(valueAt(RATINGS, 1396, null)).toBe(9)
  })

  it('finds the opinion for one season without catching its neighbours', () => {
    expect(valueAt(RATINGS, 2316, 3)).toBe(4)
    expect(valueAt(RATINGS, 2316, 4)).toBe(7)
    expect(valueAt(RATINGS, 2316, 5)).toBeNull()
  })

  /**
   * The distinction the season scope exists to draw. Falling back to the series
   * opinion would make every season of a liked show look individually liked,
   * and the Unrated tab would then have nothing left to show.
   */
  it('does not answer a season question with the series opinion', () => {
    expect(valueAt(RATINGS, 1396, 2)).toBeNull()
  })

  /** And not the other way round either: a rated season leaves the series unrated. */
  it('does not answer a series question with a season opinion', () => {
    expect(valueAt(RATINGS, 2316, null)).toBeNull()
  })

  /**
   * Unresolved imports all carry `tmdbId: 0`, so they share one opinion. That
   * is accepted rather than guarded: `rate` writes the rating under `tv:0`
   * either way, and refusing to read it back makes the buttons look broken.
   */
  it('reads back a rating on an unresolved title', () => {
    expect(valueAt([{ type: 'tv', tmdbId: 0, season: null, value: 8 }], 0, null)).toBe(8)
  })

  /** Ratings written before 1.5.7 have no season field at all. */
  it('treats a missing season as the whole title', () => {
    expect(valueAt([{ type: 'tv', tmdbId: 7, value: 8 }], 7, null)).toBe(8)
  })

  /** `rate` prepends, so the first of two records at one scope is the newer. */
  it('keeps the first record when two share a scope', () => {
    const twice: Rated[] = [
      { type: 'tv', tmdbId: 7, season: null, value: 9 },
      { type: 'tv', tmdbId: 7, season: null, value: 3 },
    ]
    expect(valueAt(twice, 7, null)).toBe(9)
  })
})
