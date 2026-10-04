/**
 * Marking a whole season, and filling in a season the Watched list holds.
 *
 * Two faults, both about what a season's episode list contains:
 *
 * - TMDB lists a season's announced episodes with their future dates, and
 *   marking a season watched ticked those too. A weekly show caught up and
 *   marked watched then had next week's episode ticked when it came out, and
 *   Resume (which follows the furthest tick) pointed at an unaired episode.
 * - A season in the Watched list was filled in each time the title opened,
 *   by ticking every episode not ticked — including the ones the user had
 *   just unticked or cleared, with a newer stamp than their untick.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaSummary, WatchlistEntry } from '@shared/types'
import { resumeAnchor } from '@shared/watchlistrank'
import { resumeTarget } from '@shared/progress'

vi.stubGlobal('window', { wta: { store: { write: vi.fn(async () => {}) } } })

const { library } = await import('./library.svelte')

const show: MediaSummary = {
  tmdbId: 94997,
  imdbId: null,
  type: 'tv',
  title: 'A weekly show',
  posterPath: null,
  backdropPath: null,
  overview: '',
  releaseDate: null,
  rating: 8,
  genreIds: [18],
}

/** "Now" for these tests: episodes 1–5 have aired, 6–10 are announced. */
const NOW = new Date('2026-10-04T12:00:00').getTime()
const season2 = Array.from({ length: 10 }, (_, i) => ({
  episode: i + 1,
  airDate: `2026-${i < 5 ? '09' : '11'}-${String(i + 1).padStart(2, '0')}`,
}))

beforeEach(() => {
  library.watchlist = []
  library.watched = []
})

describe('markSeasonWatched', () => {
  it('ticks the episodes that have aired, and no others', () => {
    library.markSeasonWatched(show, 2, season2, NOW)

    expect(library.isWatched(show, 2, 5)).toBe(true)
    expect(library.isWatched(show, 2, 6)).toBe(false)
  })

  it('leaves Resume on the first episode not yet seen', () => {
    library.markSeasonWatched(show, 2, season2, NOW)

    const entry = library.watchlistEntry(show) as WatchlistEntry
    const anchor = resumeAnchor(entry)
    const target = resumeTarget({
      episodes: season2.map((e) => ({ season: 2, episode: e.episode })),
      lastSeason: anchor.season,
      lastEpisode: anchor.episode,
      seasonCount: 2,
      isWatched: (s, e) => library.isWatched(show, s, e),
    })
    expect(target).toEqual({ season: 2, episode: 6 })
  })

  it('does not put the title on the watchlist', () => {
    library.markSeasonWatched(show, 2, season2, NOW)

    expect(library.isInWatchlist(show)).toBe(false)
    expect(library.watchlistEntry(show)).toBeDefined()
  })
})

describe('fillWatchedSeason', () => {
  it('ticks the aired episodes nothing has said anything about', () => {
    library.fillWatchedSeason(show, 2, season2, NOW)

    expect(library.watchedCount(show)).toBe(5)
    expect(library.isWatched(show, 2, 6)).toBe(false)
  })

  it('leaves an episode the user unticked unticked, however often it runs', () => {
    library.fillWatchedSeason(show, 2, season2, NOW)
    library.setWatched(show, 2, 1, false)

    // The title is opened again.
    library.fillWatchedSeason(show, 2, season2, NOW)

    expect(library.isWatched(show, 2, 1)).toBe(false)
    expect(library.isWatched(show, 2, 2)).toBe(true)
  })

  it('leaves a cleared season cleared', () => {
    library.fillWatchedSeason(show, 2, season2, NOW)
    library.setSeasonWatched(show, 2, season2.map((e) => e.episode), false)

    library.fillWatchedSeason(show, 2, season2, NOW)

    expect(library.watchedCount(show)).toBe(0)
  })
})
