/**
 * Episode marks follow the same clock rule as every other stamp.
 *
 * A mark is decided on its own `at` (`store/merge.ts`), so an un-mark made
 * here after seeing a mark from a device whose clock runs ahead has to come
 * after that mark, or the next sync puts the tick straight back.
 */

import { describe, expect, it, vi } from 'vitest'
import type { WatchlistEntry } from '@shared/types'

// `persist` writes through the preload bridge; a stub stands in for it.
const write = vi.fn(async () => {})
vi.stubGlobal('window', { wta: { store: { write } } })

const { library } = await import('./library.svelte')

function show(marks: WatchlistEntry['episodeMarks']): WatchlistEntry {
  return {
    id: 'bb',
    tmdbId: 1396,
    type: 'tv',
    title: 'Breaking Bad',
    posterPath: null,
    imdbId: null,
    lastSeason: 1,
    lastEpisode: 1,
    watchedEpisodes: Object.keys(marks).filter((key) => marks[key]!.watched),
    episodeMarks: marks,
    genreIds: [],
    episodeCount: null,
    rating: 0,
    addedAt: 1,
    providerId: null,
  }
}

describe('episode marks', () => {
  it('stamps an un-mark one past a mark from a device whose clock runs ahead', () => {
    const ahead = Date.now() + 60 * 60_000
    library.watchlist = [show({ '1:1': { watched: true, at: ahead } })]

    library.setWatched(1396, 1, 1, false)

    expect(library.watchlist[0]!.episodeMarks['1:1']).toEqual({ watched: false, at: ahead + 1 })
    expect(library.watchlist[0]!.watchedEpisodes).toEqual([])
  })
})
