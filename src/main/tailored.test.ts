import { describe, expect, it, vi } from 'vitest'
import { buildTailoredRow, ENOUGH, interleave } from './tailored'
import { stamp } from '@shared/store/core'
import type { MediaSummary, MediaType, StoreShape, Synced, WatchlistEntry } from '@shared/types'

type Store = Pick<StoreShape, 'ratings' | 'watched' | 'watchlist' | 'history'>

function saved(tmdbId: number): Synced<WatchlistEntry> {
  return stamp({
    id: `w${tmdbId}`,
    tmdbId,
    type: 'tv' as const,
    title: `title ${tmdbId}`,
    posterPath: null,
    imdbId: null,
    lastSeason: 1,
    lastEpisode: 1,
    watchedEpisodes: [],
    episodeMarks: {},
    genreIds: [18],
    episodeCount: null,
    rating: 0,
    addedAt: 0,
    providerId: null,
  })
}

function store(over: Partial<Store> = {}): Store {
  return { ratings: [], watched: [], watchlist: [], history: [], ...over }
}

function summary(tmdbId: number, rating = 7): MediaSummary {
  return {
    tmdbId,
    type: 'tv',
    title: `rec ${tmdbId}`,
    posterPath: null,
    backdropPath: null,
    overview: '',
    rating,
    releaseDate: null,
    genreIds: [18],
  }
}

/** Enough saved titles to clear `hasEnoughSignal` and produce seeds. */
const SIGNAL = store({ watchlist: [saved(1), saved(2), saved(3)] })

const noDiscover = vi.fn(async () => ({ items: [] as MediaSummary[] }))

describe('buildTailoredRow', () => {
  it('says it is not ready rather than guessing from nothing', async () => {
    const result = await buildTailoredRow(store(), 1, {
      recommendations: vi.fn(),
      discoverByGenres: noDiscover,
    })

    expect(result.ready).toBe(false)
    expect(result.items).toEqual([])
  })

  /**
   * The whole point of the change. Genre discover must not be reached when
   * there are enough content-based matches, or the row is back to "popular in
   * Drama this week" with extra steps.
   */
  it('does not fall back to genres when recommendations are enough', async () => {
    const discover = vi.fn(async () => ({ items: [summary(999)] }))
    const many = Array.from({ length: ENOUGH }, (_, i) => summary(100 + i))

    const result = await buildTailoredRow(SIGNAL, 1, {
      recommendations: async () => ({ items: many }),
      discoverByGenres: discover,
    })

    expect(discover).not.toHaveBeenCalled()
    expect(result.items).toHaveLength(ENOUGH)
  })

  it('fills a thin result out with genre matches', async () => {
    const result = await buildTailoredRow(SIGNAL, 1, {
      recommendations: async () => ({ items: [summary(100)] }),
      discoverByGenres: async () => ({ items: [summary(200), summary(201)] }),
    })

    expect(result.items.map((m) => m.tmdbId)).toContain(100)
    expect(result.items.map((m) => m.tmdbId)).toContain(200)
  })

  /**
   * Agreement between seeds is the signal. A title several of someone's
   * favourites all point at is a better bet than one only a single favourite
   * mentions, regardless of what TMDB thinks of it in the abstract.
   */
  it('ranks a title several seeds agree on above one only a single seed names', async () => {
    const agreed = summary(500, 5)
    const lonely = summary(501, 9)

    const result = await buildTailoredRow(SIGNAL, 1, {
      recommendations: async (tmdbId) =>
        tmdbId === 1 ? { items: [agreed, lonely] } : { items: [agreed] },
      discoverByGenres: noDiscover,
    })

    expect(result.items[0]?.tmdbId).toBe(500)
  })

  /** Recommending something already in the library discredits the whole row. */
  it('never recommends a title the user already has', async () => {
    const result = await buildTailoredRow(SIGNAL, 1, {
      recommendations: async () => ({ items: [summary(1), summary(600)] }),
      discoverByGenres: noDiscover,
    })

    expect(result.items.map((m) => m.tmdbId)).not.toContain(1)
    expect(result.items.map((m) => m.tmdbId)).toContain(600)
  })

  it('does not list the same title twice when both queries return it', async () => {
    const both = summary(700)
    const result = await buildTailoredRow(SIGNAL, 1, {
      recommendations: async () => ({ items: [both] }),
      discoverByGenres: async () => ({ items: [both, summary(701)] }),
    })

    const ids = result.items.map((m) => m.tmdbId)
    expect(ids.filter((id) => id === 700)).toHaveLength(1)
  })

  it('asks about each seed once, and only about seeds', async () => {
    const recommendations =
      vi.fn<(tmdbId: number, type: MediaType, page: number) => Promise<{ items: MediaSummary[] }>>(
        async () => ({ items: [] }),
      )
    await buildTailoredRow(SIGNAL, 3, { recommendations, discoverByGenres: noDiscover })

    expect(recommendations).toHaveBeenCalledTimes(3)
    // The page is carried through, so paging the row pages the recommendations.
    for (const call of recommendations.mock.calls) expect(call[2]).toBe(3)
  })
})

describe('interleave', () => {
  it('alternates, and keeps the longer tail', () => {
    expect(interleave([1, 3, 5], [2, 4])).toEqual([1, 2, 3, 4, 5])
    expect(interleave([1], [2, 4, 6])).toEqual([1, 2, 4, 6])
  })

  it('handles either side being empty', () => {
    expect(interleave([], [1, 2])).toEqual([1, 2])
    expect(interleave([1, 2], [])).toEqual([1, 2])
  })
})
