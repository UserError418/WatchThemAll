/**
 * The library's rating writes: what `rate` stores, and when a tap clears.
 *
 * The toggle is the part worth pinning. Tapping the value a title already has
 * clears it — except on a value converted from a thumb, where the same tap
 * confirms it. Getting that backwards deletes an opinion the user has held
 * since before the 1–10 scale, from the one gesture the "tap to refine" hint
 * invites.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaSummary, TitleRating } from '@shared/types'

// `persist` writes through the preload bridge; a stub stands in for it.
const write = vi.fn(async () => {})
vi.stubGlobal('window', { wta: { store: { write } } })

const { library } = await import('./library.svelte')

const media: MediaSummary = {
  tmdbId: 1396,
  imdbId: 'tt0903747',
  type: 'tv',
  title: 'Breaking Bad',
  posterPath: null,
  backdropPath: null,
  overview: '',
  releaseDate: null,
  rating: 8.9,
  genreIds: [18],
}

/** A thumb from before the scale, as the migration converted it. */
const converted: TitleRating = {
  key: 'tv:tt0903747',
  tmdbId: 1396,
  type: 'tv',
  season: null,
  value: 8,
  coarse: true,
  rating: 'like',
  genreIds: [18],
  at: 1,
}

beforeEach(() => {
  library.ratings = []
  write.mockClear()
})

describe('rate', () => {
  it('stores the value as chosen, with the legacy string derived from it', () => {
    library.rate(media, 7)

    expect(library.ratings).toHaveLength(1)
    expect(library.ratings[0]).toMatchObject({
      key: 'tv:tt0903747',
      season: null,
      value: 7,
      coarse: false,
      rating: 'like',
      genreIds: [18],
    })
    expect(write).toHaveBeenCalledOnce()
  })

  it('keys a season rating apart from the series', () => {
    library.rate(media, 9)
    library.rate(media, 3, 2)

    expect(library.ratingFor(1396)).toBe(9)
    expect(library.ratingFor(1396, 2)).toBe(3)
    expect(library.ratings.find((r) => r.season === 2)?.key).toBe('tv:tt0903747:s2')
  })

  it('replaces a rating with a different value', () => {
    library.rate(media, 7)
    library.rate(media, 4)

    expect(library.ratings).toHaveLength(1)
    expect(library.ratingFor(1396)).toBe(4)
  })

  it('clears a chosen rating when the same value is tapped again', () => {
    library.rate(media, 7)
    library.rate(media, 7)

    expect(library.ratingFor(1396)).toBeNull()
  })

  /** The exception, and the reason for this file. */
  it('confirms a converted value instead of clearing it', () => {
    library.ratings = [converted]

    library.rate(media, 8)

    expect(library.ratingFor(1396)).toBe(8)
    expect(library.isCoarse(1396)).toBe(false)
    // And from then on it is an ordinary rating, which the next tap clears.
    library.rate(media, 8)
    expect(library.ratingFor(1396)).toBeNull()
  })

  it('refines a converted value to whatever else is tapped', () => {
    library.ratings = [converted]

    library.rate(media, 10)

    expect(library.ratings).toHaveLength(1)
    expect(library.ratings[0]).toMatchObject({ value: 10, coarse: false, rating: 'like' })
  })
})

describe('clearRating', () => {
  it('removes the rating at exactly that scope and nothing else', () => {
    library.rate(media, 9)
    library.rate(media, 3, 2)

    library.clearRating(media, 2)

    expect(library.ratingFor(1396)).toBe(9)
    expect(library.ratingFor(1396, 2)).toBeNull()
  })

  it('writes nothing when there was nothing to clear', () => {
    library.clearRating(media, 5)
    expect(write).not.toHaveBeenCalled()
  })
})
