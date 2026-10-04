/**
 * Playing from a card: the episode the detail view's Resume would start, a
 * play that cannot start says why, and one that starts is listed and written
 * to History as a play from the detail view is.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaSummary, Season } from '@shared/types'
import type { PlayRequest } from '@shared/ipc'

const play = vi.fn(async (_req: PlayRequest): Promise<{ ok: boolean; error?: string }> => ({ ok: true }))
const season = vi.fn(async (_tmdbId: number, number: number): Promise<Season | null> =>
  number === 3 || number === 4
    ? ({ season: number, episodes: Array.from({ length: number === 3 ? 23 : 14 }, (_, i) => ({ season: number, episode: i + 1, runtime: 22 })) } as unknown as Season)
    : null,
)
vi.stubGlobal('window', { wta: { store: { write: vi.fn(async () => {}) }, tmdb: { season }, play } })

const { library } = await import('./library.svelte')
const { clearEpisodeCache } = await import('./episodecache')
const { toast } = await import('./toast.svelte')
const { playFromCard } = await import('./play')

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
  library.history = []
  clearEpisodeCache()
  toast.dismiss()
  play.mockClear()
})

describe('playFromCard', () => {
  it('plays where the series picks up, across a season end', async () => {
    library.addToWatchlist(office)
    library.setSeasonWatched(office, 3, [22, 23], true)

    await playFromCard(office)

    expect(play.mock.calls[0]![0]).toMatchObject({ season: 4, episode: 1, imdbId: 'tt0386676', runtimeMinutes: 22 })
  })

  it('says why when the play cannot start', async () => {
    play.mockResolvedValueOnce({ ok: false, error: 'No providers are enabled — turn one on in the Providers panel' })

    await playFromCard(office)

    expect(toast.current?.message).toBe('No providers are enabled — turn one on in the Providers panel')
    expect(library.isInWatchlist(office)).toBe(false)
  })

  it('lists the title and starts its History row when it plays', async () => {
    await playFromCard(office)

    expect(play.mock.calls[0]![0]).toMatchObject({ season: 1, episode: 1 })
    expect(library.isInWatchlist(office)).toBe(true)
    expect(library.history[0]).toMatchObject({ tmdbId: 2316, type: 'tv', season: 1, episode: 1 })
  })
})
