/**
 * Where a library series picks up, settled by fetching only the listings the
 * answer depends on: the anchor's season, and at its end the next one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaSummary, Season } from '@shared/types'

/** Season listings as TMDB would answer: The Office's seasons 3 and 4. */
const LENGTHS: Record<number, number> = { 3: 23, 4: 14 }
const season = vi.fn(async (tmdbId: number, number: number): Promise<Season | null> => {
  const count = LENGTHS[number]
  if (count === undefined) return null
  return {
    season: number,
    episodes: Array.from({ length: count }, (_, i) => ({ season: number, episode: i + 1 })),
  } as unknown as Season
})
vi.stubGlobal('window', { wta: { store: { write: vi.fn(async () => {}) }, tmdb: { season } } })

const { library } = await import('./library.svelte')
const { clearEpisodeCache } = await import('./episodecache')
const { seriesPickUp, settlePickUp } = await import('./pickup.svelte')

const office: MediaSummary = {
  tmdbId: 2316,
  imdbId: 'tt0386676',
  type: 'tv',
  title: 'The Office',
  posterPath: null,
  backdropPath: null,
  overview: '',
  releaseDate: null,
  rating: 8.6,
  genreIds: [35],
}

beforeEach(() => {
  library.watchlist = []
  clearEpisodeCache()
  season.mockClear()
})

describe('settlePickUp', () => {
  it('crosses into the next season after a finale', async () => {
    library.addToWatchlist(office)
    library.setSeasonWatched(office, 3, [21, 22, 23], true)
    const entry = library.watchlistEntry(office)!

    // Before any listing is in, it says where the user is, and what it needs.
    expect(seriesPickUp(entry)).toEqual({ target: { season: 3, episode: 23 }, need: 3 })

    expect(await settlePickUp(entry)).toEqual({ season: 4, episode: 1 })
    expect(season.mock.calls.map(([, number]) => number)).toEqual([3, 4])
    // And readers that peek see the settled answer.
    expect(seriesPickUp(entry).target).toEqual({ season: 4, episode: 1 })
  })

  it('fetches nothing for an episode started and not finished', async () => {
    library.addToWatchlist(office)
    library.setPosition(office, 3, 5)
    const entry = library.watchlistEntry(office)!

    expect(await settlePickUp(entry)).toEqual({ season: 3, episode: 5 })
    expect(season).not.toHaveBeenCalled()
  })
})
