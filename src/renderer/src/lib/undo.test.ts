/**
 * The detail view's bulk season buttons say what they did, and Undo puts
 * back exactly the episodes they changed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaSummary } from '@shared/types'

vi.stubGlobal('window', { wta: { store: { write: vi.fn(async () => {}) } } })

const { library } = await import('./library.svelte')
const { toast } = await import('./toast.svelte')
const { setSeasonTicks } = await import('./undo')

const show: MediaSummary = {
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
const season1 = [1, 2, 3, 4].map((episode) => ({ episode, airDate: '2008-01-20' }))

beforeEach(() => {
  library.watchlist = []
  toast.dismiss()
})

describe('setSeasonTicks', () => {
  it('clears a season, and Undo ticks back only what was ticked', () => {
    library.markSeasonWatched(show, 1, season1.slice(0, 2))

    setSeasonTicks(show, 1, season1, false)
    expect(library.watchedCount(show)).toBe(0)
    expect(toast.current?.message).toBe('Cleared Breaking Bad season 1')

    toast.act()
    expect([1, 2, 3, 4].map((e) => library.isWatched(show, 1, e))).toEqual([true, true, false, false])
  })

  it('ticks a season, and Undo unticks only what it ticked', () => {
    library.markSeasonWatched(show, 1, season1.slice(0, 1))

    setSeasonTicks(show, 1, season1, true)
    expect(library.watchedCount(show)).toBe(4)

    toast.act()
    expect([1, 2, 3, 4].map((e) => library.isWatched(show, 1, e))).toEqual([true, false, false, false])
  })

  it('says nothing when nothing changed', () => {
    setSeasonTicks(show, 1, season1, false)
    expect(toast.current).toBeNull()
  })
})
