/**
 * Removing a title from the watchlist keeps what the title recorded.
 *
 * The entry holds the episode ticks, the position and the chosen source, so
 * deleting it on "Remove" lost all three to one click, on every device. It is
 * unlisted instead: off the list, progress intact.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaSummary } from '@shared/types'

vi.stubGlobal('window', { wta: { store: { write: vi.fn(async () => {}) } } })

const { library } = await import('./library.svelte')

const show: MediaSummary = {
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
})

describe('removeFromWatchlist', () => {
  it('keeps the ticks, the position and the chosen source', () => {
    library.addToWatchlist(show)
    library.setSeasonWatched(show, 3, [21, 22, 23], true)
    library.setPosition(show, 3, 23)
    library.setEntryProvider(show, 'vidrock')

    library.removeFromWatchlist(show)

    expect(library.watchedCount(show)).toBe(3)
    expect(library.watchlistEntry(show)).toMatchObject({ lastSeason: 3, lastEpisode: 23, providerId: 'vidrock' })
  })

  it('takes the title off the list', () => {
    library.addToWatchlist(show)

    library.removeFromWatchlist(show)

    expect(library.isInWatchlist(show)).toBe(false)
    expect(library.listedWatchlist).toHaveLength(0)
  })

  it('finds the progress again when the title is listed again', () => {
    library.addToWatchlist(show)
    library.setSeasonWatched(show, 1, [1, 2], true)
    library.removeFromWatchlist(show)

    library.addToWatchlist(show)

    expect(library.isInWatchlist(show)).toBe(true)
    expect(library.watchedCount(show)).toBe(2)
  })

  it('undoes to exactly where it stood, the date added included', () => {
    const entry = library.addToWatchlist(show)
    entry.addedAt = 1_000
    const undo = library.removeFromWatchlist(show)

    undo()

    expect(library.isInWatchlist(show)).toBe(true)
    expect(library.watchlistEntry(show)?.addedAt).toBe(1_000)
  })

  /** Two devices that listed a title before they synced can leave two entries. */
  it('takes every listed copy of the title off the list', () => {
    library.addToWatchlist(show)
    library.watchlist = [...library.watchlist, { ...library.watchlist[0]!, id: 'other-device' }]

    library.removeFromWatchlist(show)

    expect(library.isInWatchlist(show)).toBe(false)
  })
})

describe('undoing a removal after the library reloaded', () => {
  /**
   * The store echoes the renderer's own write, and the reload hands the
   * watchlist back as new objects before the user can reach Undo. Found in
   * the running app: Undo after "Remove" left the title off the list.
   */
  it('lists the title again', () => {
    library.addToWatchlist(show)
    const undo = library.removeFromWatchlist(show)

    library.watchlist = JSON.parse(JSON.stringify(library.watchlist))
    undo()

    expect(library.isInWatchlist(show)).toBe(true)
  })
})
