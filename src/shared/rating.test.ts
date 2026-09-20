import { describe, expect, it } from 'vitest'
import { ratingForEntry, ratingForScope } from './rating'

const RATINGS = [
  { tmdbId: 1396, season: null, rating: 'like' as const },
  { tmdbId: 2316, season: 3, rating: 'dislike' as const },
  { tmdbId: 2316, season: 4, rating: 'like' as const },
]

describe('ratingForScope', () => {
  it('finds a whole-title opinion', () => {
    expect(ratingForScope(RATINGS, 1396, null)).toBe('like')
  })

  it('finds the opinion for one season without catching its neighbours', () => {
    expect(ratingForScope(RATINGS, 2316, 3)).toBe('dislike')
    expect(ratingForScope(RATINGS, 2316, 4)).toBe('like')
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
    expect(ratingForScope([{ tmdbId: 0, season: null, rating: 'like' }], 0, null)).toBe('like')
  })

  /** Ratings written before 1.5.7 have no season field at all. */
  it('treats a missing season as the whole title', () => {
    expect(ratingForScope([{ tmdbId: 7, rating: 'like' }], 7, null)).toBe('like')
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
    expect(ratingForEntry(RATINGS, entry)).toBe('like')
  })

  it('uses the whole title for a film or a legacy entry', () => {
    expect(ratingForEntry(RATINGS, { tmdbId: 1396, season: null })).toBe('like')
  })

  it('reports no opinion for a season nobody has rated', () => {
    expect(ratingForEntry(RATINGS, { tmdbId: 2316, season: 9 })).toBeNull()
  })
})
