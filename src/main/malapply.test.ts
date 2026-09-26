import { describe, expect, it, vi } from 'vitest'
import { applyMalImport, type ImportDecisions, type ResolvedTitle } from './malapply'
import { DEFAULT_TARGETS, type MalEntry } from './malimport'
import { emptyStore } from './migrate'
import type { StoreShape } from '@shared/types'
import { stamp } from '@shared/store/core'

function entry(over: Partial<MalEntry> = {}): MalEntry {
  return {
    malId: 1,
    title: 'Cowboy Bebop',
    status: 'completed',
    score: 0,
    watchedEpisodes: 0,
    totalEpisodes: 26,
    seriesType: 'TV',
    ...over,
  }
}

function decisions(over: Partial<ImportDecisions> = {}): ImportDecisions {
  return { targets: { ...DEFAULT_TARGETS }, excludedMalIds: [], applyScores: true, ...over }
}

/**
 * Resolves everything, deriving a stable but *distinct* id per title.
 *
 * A first version keyed off `title.length`, which gave "loved" and "hated" the
 * same id — and the dedupe correctly refused the second rating. The fixture was
 * wrong, not the code, but it is worth a real hash so the next collision is not
 * mistaken for a bug either.
 */
function fakeId(title: string): number {
  let hash = 0
  for (const char of title) hash = (hash * 31 + char.charCodeAt(0)) % 100_000
  return hash + 1
}

const resolveAll = vi.fn(
  async (title: string): Promise<ResolvedTitle> => ({
    tmdbId: fakeId(title),
    imdbId: `tt${fakeId(title)}`,
    title,
    posterPath: '/p.jpg',
    genreIds: [16],
    rating: 8.1,
  }),
)

const resolveNone = async (): Promise<null> => null

describe('applyMalImport', () => {
  it('routes each status to its default list', async () => {
    const { store, summary } = await applyMalImport(
      emptyStore(),
      [
        entry({ malId: 1, title: 'watching one', status: 'watching' }),
        entry({ malId: 2, title: 'completed one', status: 'completed' }),
        entry({ malId: 3, title: 'planned one', status: 'planToWatch' }),
      ],
      decisions(),
      resolveAll,
    )

    expect(store.watchlist).toHaveLength(1)
    expect(store.watched).toHaveLength(1)
    expect(store.trackers).toHaveLength(1)
    expect(summary).toMatchObject({ watchlist: 1, watched: 1, releases: 1 })
  })

  it('drops a group routed to skip', async () => {
    const { store, summary } = await applyMalImport(
      emptyStore(),
      [entry({ status: 'dropped' })],
      decisions({ targets: { ...DEFAULT_TARGETS, dropped: 'skip' } }),
      resolveAll,
    )

    expect(store.watched).toHaveLength(0)
    expect(summary.skipped).toBe(1)
  })

  it('drops a title the user unticked', async () => {
    const { store, summary } = await applyMalImport(
      emptyStore(),
      [entry({ malId: 7 }), entry({ malId: 8, title: 'Trigun' })],
      decisions({ excludedMalIds: [7] }),
      resolveAll,
    )

    expect(store.watched.map((w) => w.title)).toEqual(['Trigun'])
    expect(summary.skipped).toBe(1)
  })

  it('keeps an unmatched title in Watched, with no id', async () => {
    // Watched is the one list that means something without a TMDB id: it
    // records that the user saw this, and the title alone carries that.
    const { store, summary } = await applyMalImport(
      emptyStore(),
      [entry({ title: 'Something Obscure', status: 'completed' })],
      decisions(),
      resolveNone,
    )

    expect(store.watched).toMatchObject([{ tmdbId: 0, title: 'Something Obscure', source: 'mal' }])
    expect(summary.unmatched).toEqual(['Something Obscure'])
  })

  it('does not create an unmatched watchlist entry or tracker', async () => {
    // Both would be a row that can never play or check anything.
    const { store, summary } = await applyMalImport(
      emptyStore(),
      [
        entry({ malId: 1, title: 'a', status: 'watching' }),
        entry({ malId: 2, title: 'b', status: 'planToWatch' }),
      ],
      decisions(),
      resolveNone,
    )

    expect(store.watchlist).toHaveLength(0)
    expect(store.trackers).toHaveLength(0)
    expect(summary.unmatched).toEqual(['a', 'b'])
  })

  it('survives a resolver that throws', async () => {
    // One failed lookup must not abandon the other 300.
    const flaky = vi
      .fn<(title: string) => Promise<ResolvedTitle | null>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({
        tmdbId: 5,
        imdbId: null,
        title: 'ok',
        posterPath: null,
        genreIds: [],
        rating: 0,
      })

    const { store, summary } = await applyMalImport(
      emptyStore(),
      [entry({ malId: 1, title: 'boom' }), entry({ malId: 2, title: 'ok' })],
      decisions(),
      flaky,
    )

    expect(summary.unmatched).toEqual(['boom'])
    expect(store.watched.some((w) => w.tmdbId === 5)).toBe(true)
  })

  it('seeds ratings from scores, on the same thresholds as the parser', async () => {
    const { store, summary } = await applyMalImport(
      emptyStore(),
      [
        entry({ malId: 1, title: 'loved', score: 9 }),
        entry({ malId: 2, title: 'hated', score: 3 }),
        entry({ malId: 3, title: 'shrug', score: 6 }),
      ],
      decisions(),
      resolveAll,
    )

    expect(store.ratings.map((r) => r.rating).sort()).toEqual(['dislike', 'like'])
    expect(summary.ratings).toBe(2)
  })

  it('never overwrites a rating the user set by hand', async () => {
    // An import is bulk and old; a rating made in the app is deliberate and
    // recent. Silently replacing the second is data loss nobody notices until
    // the recommendations stop making sense.
    const id = fakeId('Cowboy Bebop')
    const before: StoreShape = {
      ...emptyStore(),
      ratings: [stamp({ key: `tv:${id}`, tmdbId: id, type: 'tv', season: null,
 rating: 'like', genreIds: [], at: 1 })],
    }

    const { store } = await applyMalImport(
      before,
      [entry({ score: 2 })],
      decisions(),
      resolveAll,
    )

    expect(store.ratings).toHaveLength(1)
    expect(store.ratings[0]?.rating).toBe('like')
  })

  it('leaves scores alone when the user opted out', async () => {
    const { store } = await applyMalImport(
      emptyStore(),
      [entry({ score: 10 })],
      decisions({ applyScores: false }),
      resolveAll,
    )

    expect(store.ratings).toHaveLength(0)
  })

  it('does not duplicate something already in the list', async () => {
    const first = await applyMalImport(emptyStore(), [entry()], decisions(), resolveAll)
    const second = await applyMalImport(first.store, [entry()], decisions(), resolveAll)

    expect(second.store.watched).toHaveLength(1)
    expect(second.summary.watched).toBe(0)
  })

  it('lists an entry kept only for its ticks when MAL says it is being watched', async () => {
    const first = await applyMalImport(emptyStore(), [entry({ status: 'watching' })], decisions(), resolveAll)
    const ticked = { ...first.store.watchlist[0]!, listed: false, watchedEpisodes: ['1:1'] }
    const second = await applyMalImport(
      { ...first.store, watchlist: [ticked] },
      [entry({ status: 'watching' })],
      decisions(),
      resolveAll,
    )

    expect(second.store.watchlist).toHaveLength(1)
    expect(second.store.watchlist[0]).not.toHaveProperty('listed')
    expect(second.store.watchlist[0]?.watchedEpisodes).toEqual(['1:1'])
    expect(second.summary.watchlist).toBe(1)
  })

  it('carries the MAL progress into a watchlist resume position', async () => {
    const { store } = await applyMalImport(
      emptyStore(),
      [entry({ status: 'watching', watchedEpisodes: 7, totalEpisodes: 26 })],
      decisions(),
      resolveAll,
    )

    expect(store.watchlist[0]).toMatchObject({ lastSeason: 1, lastEpisode: 7, episodeCount: 26 })
  })

  it('never writes a zero episode position for a series with no progress', async () => {
    // Positions are 1-based everywhere; a 0 would be a permanently invalid key.
    const { store } = await applyMalImport(
      emptyStore(),
      [entry({ status: 'watching', watchedEpisodes: 0 })],
      decisions(),
      resolveAll,
    )

    expect(store.watchlist[0]?.lastEpisode).toBe(1)
  })

  it('does not track a film for releases', async () => {
    const { store } = await applyMalImport(
      emptyStore(),
      [entry({ status: 'planToWatch', seriesType: 'Movie' })],
      decisions(),
      resolveAll,
    )

    expect(store.trackers).toHaveLength(0)
  })

  it('reports progress once per selected title', async () => {
    const onProgress = vi.fn()
    await applyMalImport(
      emptyStore(),
      [entry({ malId: 1 }), entry({ malId: 2, title: 'b' }), entry({ malId: 3, title: 'c' })],
      decisions({ excludedMalIds: [3] }),
      resolveAll,
      onProgress,
    )

    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(onProgress).toHaveBeenLastCalledWith(2, 2)
  })

  it('leaves the store it was given untouched', async () => {
    const before = emptyStore()
    await applyMalImport(before, [entry()], decisions(), resolveAll)

    expect(before.watched).toHaveLength(0)
  })
})
