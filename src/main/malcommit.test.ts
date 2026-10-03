/**
 * Committing a MyAnimeList import keeps what was written while it ran.
 *
 * The import resolves every entry against TMDB, which takes minutes for a
 * real list, and builds its result from the library as it stood when it
 * began. Committed with `replaceDocument`, that result put back everything
 * written meanwhile: a play opened, a position saved, a setting changed.
 */

import { describe, expect, it } from 'vitest'

import { storeOn } from '@shared/sync/fakedrive.fixture'
import { applyMalImport, type ImportDecisions } from './malapply'
import type { MalEntry } from './malimport'

const ENTRY: MalEntry = {
  malId: 1,
  title: 'Some Anime',
  status: 'completed',
  score: 0,
  watchedEpisodes: 12,
  totalEpisodes: 12,
  seriesType: 'TV',
} as MalEntry

describe('committing a MyAnimeList import', () => {
  it('keeps what was written during the lookups, and what the import added', async () => {
    const store = await storeOn('desktop')
    let lookUp!: () => void
    const answered = new Promise<void>((resolve) => (lookUp = resolve))
    const decisions = {
      targets: new Proxy({}, { get: () => 'watched' }),
      excludedMalIds: [],
      applyScores: false,
    } as unknown as ImportDecisions
    const importing = applyMalImport(store.read(), [ENTRY], decisions, async () => {
      await answered
      return { tmdbId: 777, type: 'tv', imdbId: null, title: 'Some Anime', posterPath: null, genreIds: [], rating: 0 }
    })

    // While TMDB is being searched.
    store.collection('history').put({
      id: 'played-meanwhile',
      tmdbId: 5,
      type: 'movie',
      title: 'Played meanwhile',
      posterPath: null,
      season: null,
      episode: null,
      watchedAt: Date.now(),
    })
    store.collection('resumePoints').put({ key: '5:m:m', tmdbId: 5, seconds: 900, duration: 7000 })
    store.patchSettings({ autoNext: false })
    lookUp()
    const { store: next } = await importing
    await store.mergeDocument(next)

    expect(store.read().history.map((h) => h.id)).toContain('played-meanwhile')
    expect(store.read().resumePoints.map((p) => p.key)).toContain('5:m:m')
    expect(store.read().settings.autoNext).toBe(false)
    expect(store.read().watched.some((w) => w.tmdbId === 777)).toBe(true)
  })
})
