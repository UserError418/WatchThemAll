/**
 * A film and a series that share a TMDB number are two titles.
 *
 * TMDB numbers films and series in separate spaces, so the same number names
 * one of each. Every library lookup used to match on the number alone: a film
 * read as "in the watchlist" because a series with its number was, rating the
 * film deleted the series' rating, and removing the film removed the series.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaSummary } from '@shared/types'

// `persist` writes through the preload bridge; a stub stands in for it.
vi.stubGlobal('window', { wta: { store: { write: vi.fn(async () => {}) } } })

const { library } = await import('./library.svelte')

const summary = (over: Partial<MediaSummary>): MediaSummary => ({
  tmdbId: 1399,
  imdbId: null,
  type: 'tv',
  title: '',
  posterPath: null,
  backdropPath: null,
  overview: '',
  releaseDate: null,
  rating: 8,
  genreIds: [18],
  ...over,
})

const series = summary({ type: 'tv', title: 'A series', imdbId: 'tt0944947' })
const film = summary({ type: 'movie', title: 'An unrelated film', imdbId: 'tt0000001' })

beforeEach(() => {
  library.watchlist = []
  library.watched = []
  library.ratings = []
  library.trackers = []
})

describe('a film and a series with the same TMDB number', () => {
  it("rating the film leaves the series' rating alone", () => {
    library.rate(series, 9)
    library.rate(film, 3)

    expect(library.ratingFor(series)).toBe(9)
    expect(library.ratingFor(film)).toBe(3)
  })

  it('the film is not on the watchlist because the series is', () => {
    library.addToWatchlist(series)

    expect(library.isInWatchlist(series)).toBe(true)
    expect(library.isInWatchlist(film)).toBe(false)
    expect(library.watchlistEntry(film)).toBeUndefined()
  })

  it("removing the film leaves the series' entry and ticks alone", () => {
    library.addToWatchlist(series)
    library.setSeasonWatched(series, 1, [1, 2, 3], true)
    library.addToWatchlist(film)

    library.removeFromWatchlist(film)

    expect(library.isInWatchlist(series)).toBe(true)
    expect(library.watchedCount(series)).toBe(3)
  })

  it('seeing the film does not mark the series seen', () => {
    library.addToWatched(film)

    expect(library.hasSeen(film)).toBe(true)
    expect(library.hasSeen(series)).toBe(false)
    expect(library.hasSeenSeason(series, 1)).toBe(false)
  })

  it('a film is never tracked, even when a series with its number is', () => {
    library.addTracker(series)

    expect(library.isTracked(series)).toBe(true)
    expect(library.isTracked(film)).toBe(false)
  })
})
