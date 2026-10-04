/**
 * A file saved with a byte-order mark still opens.
 *
 * The desktop's library is pretty-printed so that people can open and repair
 * it by hand, and some editors save UTF-8 with a byte-order mark, which
 * `JSON.parse` refuses. The library was then set aside as unreadable and the
 * app started on an empty one.
 */

import { describe, expect, it } from 'vitest'

import { emptyDocument, stamp } from './core'
import { ResultStore } from './results'
import { MemoryFile, storeOn } from '../sync/fakedrive.fixture'

describe('a byte-order mark', () => {
  it('does not stop the library opening', async () => {
    const doc = emptyDocument('desktop-1')
    doc.watchlist = [
      stamp({
        id: 'kept',
        tmdbId: 1,
        type: 'tv' as const,
        title: 'Kept',
        posterPath: null,
        imdbId: null,
        lastSeason: 1,
        lastEpisode: 1,
        watchedEpisodes: [],
        episodeMarks: {},
        genreIds: [],
        episodeCount: null,
        rating: 0,
        addedAt: 1,
        providerId: null,
      }),
    ]
    const file = new MemoryFile()
    file.text = `\uFEFF${JSON.stringify(doc, null, 2)}`

    const store = await storeOn('desktop', file)

    expect(store.read().watchlist.map((w) => w.id)).toEqual(['kept'])
    expect(store.recovered).toBeNull()
  })

  it('does not stop the test history opening', async () => {
    const now = Date.UTC(2026, 9, 1)
    const file = new MemoryFile()
    file.text = `\uFEFF${JSON.stringify({
      results: 1,
      items: [
        {
          titleKey: 'movie:tt0137523',
          season: null,
          episode: null,
          providerId: 'vidsrc',
          at: now,
          deviceId: 'desktop-1',
          deviceKind: 'desktop',
          origin: 'test',
          verdict: 'stream',
        },
      ],
    })}`
    const results = new ResultStore(file, () => now)
    await results.load()

    expect(results.all()).toHaveLength(1)
  })
})
