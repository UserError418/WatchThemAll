import { describe, expect, it } from 'vitest'
import type { StoreShape } from '@shared/types'
import { emptyStore } from './migrate'
import { exportStore, importIntoStore, roundTrip } from './sync'
import { stampAll } from '@shared/store/core'

/**
 * The export format is shared with the Android app and the ReelVault extension,
 * neither of which knows this app was rewritten. These tests exist to make
 * breaking that contract loud — a silent break desyncs the user's devices while
 * every app keeps appearing to work.
 */

function populated(): StoreShape {
  const store = emptyStore()
  store.watchlist = stampAll([
    {
      id: 'bm-1',
      tmdbId: 1396,
      type: 'tv',
      title: 'Breaking Bad',
      posterPath: '/poster.jpg',
      imdbId: 'tt0903747',
      lastSeason: 3,
      lastEpisode: 7,
      watchedEpisodes: ['1:1', '1:2'],
      episodeMarks: {},
      genreIds: [18, 80],
      episodeCount: null,
      rating: 0,
      addedAt: 1_700_000_000_000,
      providerId: 'moviesapi',
    },
    {
      id: 'bm-2',
      tmdbId: 693134,
      type: 'movie',
      title: 'Dune: Part Two',
      posterPath: '/dune.jpg',
      imdbId: 'tt15239678',
      lastSeason: null,
      lastEpisode: null,
      watchedEpisodes: [],
      episodeMarks: {},
      genreIds: [878],
      episodeCount: null,
      rating: 0,
      addedAt: 1_700_000_100_000,
      providerId: null,
    },
  ])
  store.trackers = stampAll([
    {
      id: 'tr-1',
      tmdbId: 94997,
      title: 'House of the Dragon',
      posterPath: '/hotd.jpg',
      status: 'Returning Series',
      nextEpisode: { season: 3, episode: 1, name: 'A Son for a Son', airDate: '2026-06-15' },
      lastNotified: { season: 2, episode: 8, name: 'The Queen Who Ever Was', airDate: '2024-08-04' },
      addedAt: 1_700_000_200_000,
      lastChecked: 1_700_000_300_000,
    },
  ])
  store.history = stampAll([
    {
      id: 'h-1',
      tmdbId: 1396,
      type: 'tv',
      title: 'Breaking Bad',
      posterPath: '/poster.jpg',
      season: 3,
      episode: 7,
      watchedAt: 1_700_000_400_000,
    },
  ])
  store.activeProviderIds = ['moviesapi', 'vidflix']
  return store
}

describe('exportStore', () => {
  const payload = exportStore(populated())

  it('emits the frozen top-level shape', () => {
    expect(payload.version).toBe(1)
    expect(typeof payload.exportedAt).toBe('string')
    expect(Object.keys(payload.data).sort()).toEqual([
      'vidsrc_active_providers',
      'vidsrc_bookmarks',
      'vidsrc_history',
      'vidsrc_schemas',
      'vidsrc_watchlist_items',
    ])
  })

  it('emits bookmarks under the legacy field names', () => {
    const [bookmark] = payload.data.vidsrc_bookmarks
    expect(bookmark).toMatchObject({
      bookmarkId: 'bm-1',
      name: 'Breaking Bad',
      imdb: 'tt0903747',
      type: 'tv',
      lastSeason: 3,
      lastEpisode: 7,
    })
  })

  it('never exports an empty schemaId', () => {
    // The other apps drop bookmarks whose schemaId is falsy — that is the exact
    // bug that made recommendation-added entries vanish in the original.
    for (const bookmark of payload.data.vidsrc_bookmarks) {
      expect(bookmark.schemaId, `${bookmark.name} needs a schemaId`).toBeTruthy()
    }
  })

  it('expands TMDB poster paths into absolute URLs the other apps can render', () => {
    const [bookmark] = payload.data.vidsrc_bookmarks
    expect(bookmark!.imageUrl).toBe('https://image.tmdb.org/t/p/w342/poster.jpg')
  })

  it('formats the tracker next-episode string the way the other apps display it', () => {
    const [tracker] = payload.data.vidsrc_watchlist_items
    expect(tracker!.nextEpisodeInfo).toBe('S03E01 · A Son for a Son')
    expect(tracker!.nextEpisodeAirdate).toBe('2026-06-15')
    expect(tracker!.lastKnownSeason).toBe(2)
    expect(tracker!.lastKnownEpisode).toBe(8)
  })
})

describe('importIntoStore', () => {
  it('rejects something that is not an export file', () => {
    const store = emptyStore()
    expect(importIntoStore(store, { nope: true }).ok).toBe(false)
    expect(importIntoStore(store, null).ok).toBe(false)
    expect(importIntoStore(store, 'a string').ok).toBe(false)
  })

  it('merges rather than replacing', () => {
    const store = populated()
    const incoming = emptyStore()
    incoming.watchlist = [
      {
        ...populated().watchlist[0]!,
        id: 'bm-other',
        tmdbId: 1399,
        title: 'Game of Thrones',
      },
    ]

    importIntoStore(store, exportStore(incoming))
    expect(store.watchlist).toHaveLength(3)
    expect(store.watchlist.map((w) => w.title)).toContain('Breaking Bad')
    expect(store.watchlist.map((w) => w.title)).toContain('Game of Thrones')
  })

  it('is idempotent — importing the same file twice adds nothing the second time', () => {
    const store = emptyStore()
    const payload = exportStore(populated())

    const first = importIntoStore(store, payload)
    const second = importIntoStore(store, payload)

    expect(first.added.watchlist).toBe(2)
    expect(second.added.watchlist).toBe(0)
    expect(store.watchlist).toHaveLength(2)
  })

  it('converts absolute TMDB image URLs back to bare paths', () => {
    const store = emptyStore()
    importIntoStore(store, exportStore(populated()))
    expect(store.watchlist[0]!.posterPath).toBe('/poster.jpg')
  })

  it('passes non-TMDB image URLs through untouched', () => {
    // Imports from the Android app or the extension carry TVmaze URLs.
    const store = emptyStore()
    importIntoStore(store, {
      data: {
        vidsrc_bookmarks: [
          {
            bookmarkId: 'x',
            name: 'Old Entry',
            imageUrl: 'https://static.tvmaze.com/uploads/images/medium/1.jpg',
          },
        ],
      },
    })
    expect(store.watchlist[0]!.posterPath).toBe(
      'https://static.tvmaze.com/uploads/images/medium/1.jpg',
    )
  })

  it('survives entries with missing and malformed fields', () => {
    const store = emptyStore()
    const result = importIntoStore(store, {
      data: {
        vidsrc_bookmarks: [
          null,
          { name: 'No id — skipped' },
          { bookmarkId: 'ok', name: 'Kept', lastSeason: 'not a number' },
        ],
        vidsrc_history: ['garbage', { historyId: 'h', name: 'Kept' }],
      },
    })
    expect(result.ok).toBe(true)
    expect(store.watchlist).toHaveLength(1)
    expect(store.watchlist[0]!.lastSeason).toBe(1)
    expect(store.history).toHaveLength(1)
  })
})

describe('round trip', () => {
  it('preserves the fields the other apps read', () => {
    const before = populated()
    const after = roundTrip(before)

    expect(after.watchlist.map((w) => w.title)).toEqual(before.watchlist.map((w) => w.title))
    expect(after.watchlist.map((w) => w.imdbId)).toEqual(before.watchlist.map((w) => w.imdbId))
    expect(after.watchlist.map((w) => w.lastSeason)).toEqual(
      before.watchlist.map((w) => w.lastSeason),
    )
    expect(after.watchlist.map((w) => w.tmdbId)).toEqual(before.watchlist.map((w) => w.tmdbId))
    expect(after.history.map((h) => h.watchedAt)).toEqual(before.history.map((h) => h.watchedAt))
    expect(after.activeProviderIds).toEqual(before.activeProviderIds)
    expect(after.trackers.map((t) => t.title)).toEqual(before.trackers.map((t) => t.title))
  })

  it('loses only what the shared format has nowhere to put', () => {
    // Documented, not accidental: the wire format has no field for per-episode
    // watch marks or genre ids. If a future format version adds them, this test
    // is what should change first.
    const after = roundTrip(populated())
    expect(after.watchlist[0]!.watchedEpisodes).toEqual([])
    expect(after.watchlist[0]!.genreIds).toEqual([])
  })
})
