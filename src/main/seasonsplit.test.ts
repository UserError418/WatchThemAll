import { describe, expect, it, vi } from 'vitest'
import type { TitleRating, WatchedEntry, WatchlistEntry } from '@shared/types'
import {
  runSeasonSplit,
  tmdbIdentify,
  seasonsWithProgress,
  splitTitleRating,
  splitWatchedEntry,
  type SeasonSplitDeps,
} from './seasonsplit'

/** A legacy whole-series entry, the shape this whole module exists to remove. */
function legacyEntry(over: Partial<WatchedEntry> = {}): WatchedEntry {
  return {
    id: 'w1',
    tmdbId: 1396,
    type: 'tv',
    season: null,
    title: 'Breaking Bad',
    posterPath: null,
    imdbId: 'tt0903747',
    genreIds: [18],
    rating: 8.9,
    addedAt: 1,
    source: 'user',
    malId: null,
    ...over,
  }
}

function watchlistEntry(over: Partial<WatchlistEntry> = {}): WatchlistEntry {
  return {
    id: 'l1',
    tmdbId: 1396,
    type: 'tv',
    title: 'Breaking Bad',
    posterPath: null,
    imdbId: 'tt0903747',
    lastSeason: 1,
    lastEpisode: 1,
    watchedEpisodes: [],
    episodeMarks: {},
    genreIds: [18],
    episodeCount: 62,
    rating: 8.9,
    addedAt: 1,
    providerId: null,
    ...over,
  }
}

function seriesRating(over: Partial<TitleRating> = {}): TitleRating {
  return {
    key: 'tv:tt0903747',
    tmdbId: 1396,
    type: 'tv',
    season: null,
    rating: 'like',
    genreIds: [18],
    at: 1,
    ...over,
  }
}

/** Deps with everything stubbed, plus the spies to assert against. */
function harness(over: Partial<SeasonSplitDeps> = {}) {
  const put = vi.fn<(entries: WatchedEntry[]) => void>()
  const removed: string[] = []
  const putRatings = vi.fn<(ratings: TitleRating[]) => void>()
  const removedRatings: string[] = []
  const deps: SeasonSplitDeps = {
    watched: () => [],
    ratings: () => [],
    watchlistEntry: () => undefined,
    identify: async () => ({ kind: 'unknown' }),
    putWatched: put,
    removeWatched: (id) => void removed.push(id),
    putRatings,
    removeRating: (key) => void removedRatings.push(key),
    wait: async () => {},
    ...over,
  }
  /** Every entry handed to `putWatched`, flattened across batches. */
  const created = (): WatchedEntry[] => put.mock.calls.flatMap(([entries]) => entries)
  return { deps, put, putRatings, removed, removedRatings, created }
}

describe('seasonsWithProgress', () => {
  it('reports the seasons that have a watched episode', () => {
    const entry = watchlistEntry({
      episodeMarks: {
        '1:1': { watched: true, at: 1 },
        '1:2': { watched: true, at: 2 },
        '3:5': { watched: true, at: 3 },
      },
    })
    expect(seasonsWithProgress(entry)).toEqual([1, 3])
  })

  /**
   * An episode opened and abandoned leaves a mark with `watched: false`. It is
   * evidence of interest, not of having watched the season.
   */
  it('ignores marks that record an episode as not watched', () => {
    const entry = watchlistEntry({
      episodeMarks: { '1:1': { watched: true, at: 1 }, '2:1': { watched: false, at: 2 } },
    })
    expect(seasonsWithProgress(entry)).toEqual([1])
  })

  /**
   * `episodeMarks` is the mergeable record and `watchedEpisodes` the rendered
   * one; an entry written before marks existed carries only the latter, and
   * reading just the marks would call such a library empty.
   */
  it('also reads the legacy watchedEpisodes list', () => {
    const entry = watchlistEntry({ watchedEpisodes: ['2:1', '2:2'], episodeMarks: {} })
    expect(seasonsWithProgress(entry)).toEqual([2])
  })

  it('sorts ascending and does not repeat a season', () => {
    const entry = watchlistEntry({ watchedEpisodes: ['3:1', '1:1', '3:2', '2:9'] })
    expect(seasonsWithProgress(entry)).toEqual([1, 2, 3])
  })

  it('discards keys that are not a 1-based season', () => {
    const entry = watchlistEntry({ watchedEpisodes: ['0:1', 'x:1', '', '1:1'] })
    expect(seasonsWithProgress(entry)).toEqual([1])
  })

  it('reports nothing for a title with no watchlist entry', () => {
    expect(seasonsWithProgress(undefined)).toEqual([])
  })
})

describe('splitWatchedEntry', () => {
  it('keeps every field but the id and the season', () => {
    const [first] = splitWatchedEntry(legacyEntry(), [1])
    expect(first).toMatchObject({ title: 'Breaking Bad', tmdbId: 1396, rating: 8.9, season: 1 })
  })

  /**
   * The reason ids are derived rather than random: a desktop and a phone each
   * running this pass must produce records the merge sees as one, or the user
   * ends up with every season twice.
   */
  it('derives ids deterministically from the original', () => {
    const ids = splitWatchedEntry(legacyEntry(), [1, 2]).map((e) => e.id)
    expect(ids).toEqual(['w1:s1', 'w1:s2'])
    expect(splitWatchedEntry(legacyEntry(), [1, 2]).map((e) => e.id)).toEqual(ids)
  })
})

describe('splitTitleRating', () => {
  it('copies the series opinion onto each season key', () => {
    const copies = splitTitleRating(seriesRating(), [1, 2], new Set())
    expect(copies.map((r) => r.key)).toEqual(['tv:tt0903747:s1', 'tv:tt0903747:s2'])
    expect(copies.every((r) => r.rating === 'like')).toBe(true)
    expect(copies.map((r) => r.season)).toEqual([1, 2])
  })

  /** A specific opinion about season 3 outranks a copy of the series opinion. */
  it('leaves a season the user has already rated alone', () => {
    const copies = splitTitleRating(seriesRating(), [1, 2], new Set(['tv:tt0903747:s2']))
    expect(copies.map((r) => r.key)).toEqual(['tv:tt0903747:s1'])
  })
})

describe('runSeasonSplit', () => {
  it('splits by the seasons the user actually has progress in', async () => {
    const { deps, removed, created } = harness({
      watched: () => [legacyEntry()],
      watchlistEntry: () =>
        watchlistEntry({
          episodeMarks: { '1:1': { watched: true, at: 1 }, '2:1': { watched: true, at: 2 } },
        }),
    })

    const report = await runSeasonSplit(deps)

    expect(created().map((e) => e.season)).toEqual([1, 2])
    expect(removed).toEqual(['w1'])
    expect(report).toEqual({ split: 1, created: 2, ratings: 0, retyped: 0, skipped: 0 })
  })

  /**
   * A MyAnimeList import, or a series marked watched from a card without ever
   * being opened. The old entry claimed the whole series, so every season of it
   * is the faithful reading.
   */
  it('falls back to every season TMDB reports when there are no marks', async () => {
    const { deps, created } = harness({
      watched: () => [legacyEntry()],
      watchlistEntry: () => watchlistEntry(),
      identify: async () => ({ kind: 'series', seasons: 5 }),
    })

    const report = await runSeasonSplit(deps)

    expect(created().map((e) => e.season)).toEqual([1, 2, 3, 4, 5])
    expect(report.created).toBe(5)
  })

  /** Marks are a statement; a season count is an inference. Never ask if we know. */
  it('does not call TMDB when the marks already answer the question', async () => {
    const identify = vi.fn(async () => ({ kind: 'series', seasons: 5 }) as const)
    const { deps } = harness({
      watched: () => [legacyEntry()],
      watchlistEntry: () => watchlistEntry({ watchedEpisodes: ['1:1'] }),
      identify,
    })

    await runSeasonSplit(deps)

    expect(identify).not.toHaveBeenCalled()
  })

  it('copies the series rating down to each new season', async () => {
    const { deps, putRatings } = harness({
      watched: () => [legacyEntry()],
      ratings: () => [seriesRating()],
      watchlistEntry: () => watchlistEntry({ watchedEpisodes: ['1:1', '2:1'] }),
    })

    const report = await runSeasonSplit(deps)

    expect(putRatings.mock.calls[0]?.[0].map((r) => r.key)).toEqual([
      'tv:tt0903747:s1',
      'tv:tt0903747:s2',
    ])
    expect(report.ratings).toBe(2)
  })

  /**
   * The user's own words for what is at stake: the shows they rated must not
   * come out the other side looking unrated.
   */
  it('keeps the series rating as well as the copies', async () => {
    const ratings = [seriesRating()]
    const { deps, putRatings } = harness({
      watched: () => [legacyEntry()],
      ratings: () => ratings,
      watchlistEntry: () => watchlistEntry({ watchedEpisodes: ['1:1'] }),
    })

    await runSeasonSplit(deps)

    // Nothing was asked to overwrite or tombstone `tv:tt0903747` itself.
    expect(putRatings.mock.calls.flatMap(([r]) => r).map((r) => r.key)).not.toContain(
      'tv:tt0903747',
    )
  })

  it('leaves films and already-split entries untouched', async () => {
    const { deps, put, removed } = harness({
      watched: () => [
        legacyEntry({ id: 'm1', type: 'movie' }),
        legacyEntry({ id: 'w1:s1', season: 1 }),
      ],
    })

    const report = await runSeasonSplit(deps)

    expect(put).not.toHaveBeenCalled()
    expect(removed).toEqual([])
    expect(report.split).toBe(0)
  })

  /** An unresolved import has no id to ask TMDB with. Guessing is worse. */
  it('skips a title with no marks and no tmdb id', async () => {
    const identify = vi.fn(async () => ({ kind: 'series', seasons: 5 }) as const)
    const { deps, put, removed } = harness({
      watched: () => [legacyEntry({ tmdbId: 0 })],
      identify,
    })

    const report = await runSeasonSplit(deps)

    expect(identify).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
    expect(removed).toEqual([])
    expect(report.skipped).toBe(1)
  })

  /**
   * One unreachable title must not strand every title behind it — and it stays
   * legacy, so the next launch tries it again.
   */
  it('keeps going when a lookup fails, leaving that title for next time', async () => {
    const { deps, removed, created } = harness({
      watched: () => [legacyEntry({ id: 'bad', tmdbId: 7 }), legacyEntry({ id: 'ok', tmdbId: 8 })],
      identify: async (tmdbId) =>
        tmdbId === 7 ? { kind: 'unknown' } : { kind: 'series', seasons: 2 },
    })

    const report = await runSeasonSplit(deps)

    expect(removed).toEqual(['ok'])
    expect(created().map((e) => e.id)).toEqual(['ok:s1', 'ok:s2'])
    expect(report).toEqual({ split: 1, created: 2, ratings: 0, retyped: 0, skipped: 1 })
  })

  /** TMDB not knowing the title is not a licence to invent one season. */
  it('skips a title TMDB will not serve', async () => {
    const { deps, put } = harness({
      watched: () => [legacyEntry()],
      identify: async () => ({ kind: 'unknown' }),
    })

    const report = await runSeasonSplit(deps)

    expect(put).not.toHaveBeenCalled()
    expect(report.skipped).toBe(1)
  })

  /**
   * Six of these were in the real library this was written against: MyAnimeList
   * films and OVAs imported as `type: 'tv'`. They have no seasons because they
   * are not series, and left alone they sit in Watched as cards that cannot be
   * opened.
   */
  it('corrects an entry TMDB serves as a film, keeping its id', async () => {
    const { deps, created, removed } = harness({
      watched: () => [legacyEntry({ id: 'w9', tmdbId: 677602, title: 'Grand Blue' })],
      identify: async () => ({ kind: 'film' }),
    })

    const report = await runSeasonSplit(deps)

    expect(created()).toEqual([
      expect.objectContaining({ id: 'w9', type: 'movie', season: null }),
    ])
    // Nothing tombstoned: the record is corrected in place, not replaced.
    expect(removed).toEqual([])
    expect(report).toEqual({ split: 0, created: 0, ratings: 0, retyped: 1, skipped: 0 })
  })

  /**
   * The rating's key *is* its merge identity and encodes the type, so a
   * corrected film needs its rating moved rather than edited — and the old key
   * tombstoned, or the library ends up holding the same opinion twice.
   */
  it('re-keys a corrected film rating and tombstones the old key', async () => {
    const { deps, putRatings, removedRatings } = harness({
      watched: () => [legacyEntry({ tmdbId: 677602 })],
      ratings: () => [seriesRating({ key: 'tv:tt8712248', tmdbId: 677602 })],
      identify: async () => ({ kind: 'film' }),
    })

    await runSeasonSplit(deps)

    expect(putRatings.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ key: 'movie:tt8712248', type: 'movie', rating: 'like' }),
    ])
    expect(removedRatings).toEqual(['tv:tt8712248'])
  })

  it('leaves a corrected film with no rating alone', async () => {
    const { deps, putRatings, removedRatings } = harness({
      watched: () => [legacyEntry({ tmdbId: 677602 })],
      identify: async () => ({ kind: 'film' }),
    })

    await runSeasonSplit(deps)

    expect(putRatings).not.toHaveBeenCalled()
    expect(removedRatings).toEqual([])
  })

  /**
   * A film corrected on one launch must not be looked at again on the next —
   * `type: 'movie'` is outside the legacy filter, which is what makes the pass
   * terminate without a flag to remember it by.
   */
  it('does not revisit a film it has already corrected', async () => {
    let watched = [legacyEntry({ id: 'w9', tmdbId: 677602 })]
    const identify = vi.fn(async () => ({ kind: 'film' }) as const)
    const { deps, created } = harness({ watched: () => watched, identify })

    await runSeasonSplit(deps)
    watched = created()
    const second = await runSeasonSplit(deps)

    expect(identify).toHaveBeenCalledTimes(1)
    expect(second.retyped).toBe(0)
  })

  /**
   * The property that makes an interrupted run safe: what is left to do is
   * read off the data, so running again over an already-split library is a
   * no-op rather than a second round of splitting.
   */
  it('is a no-op on a library it has already migrated', async () => {
    let watched = [legacyEntry()]
    const { deps, created, removed } = harness({
      watched: () => watched,
      watchlistEntry: () => watchlistEntry({ watchedEpisodes: ['1:1', '2:1'] }),
    })

    await runSeasonSplit(deps)
    // What the store would hold afterwards: the seasons, and no legacy entry.
    watched = created()

    const second = await runSeasonSplit(deps)

    expect(second).toEqual({ split: 0, created: 0, ratings: 0, retyped: 0, skipped: 0 })
    expect(removed).toEqual(['w1'])
  })
})

describe('tmdbIdentify', () => {
  /** A 404 is how TMDB says "not under this type", and it throws. */
  const missing = () => Promise.reject(new Error('TMDB responded 404'))

  it('reports a series with its season count', async () => {
    const identify = tmdbIdentify(async () => ({ seasonCount: 5 }))
    expect(await identify(1396)).toEqual({ kind: 'series', seasons: 5 })
  })

  /** A genuine series costs one request; only a mis-filed title pays for two. */
  it('does not ask about a film once the series lookup answered', async () => {
    const detail = vi.fn(async () => ({ seasonCount: 5 }))
    await tmdbIdentify(detail)(1396)
    expect(detail).toHaveBeenCalledTimes(1)
    expect(detail).toHaveBeenCalledWith(1396, 'tv')
  })

  /**
   * The MyAnimeList case: a compilation film imported as `type: 'tv'`, so
   * `/tv/{id}` refuses and `/movie/{id}` answers.
   */
  it('reports a film when only the movie lookup answers', async () => {
    const identify = tmdbIdentify(async (_id, type) =>
      type === 'movie' ? { seasonCount: 0 } : missing(),
    )
    expect(await identify(677602)).toEqual({ kind: 'film' })
  })

  it('reports unknown when neither type resolves', async () => {
    expect(await tmdbIdentify(missing)(1677043)).toEqual({ kind: 'unknown' })
  })

  /** Offline looks exactly like "neither type resolves", and must not split. */
  it('reports unknown rather than guessing when the network is down', async () => {
    const identify = tmdbIdentify(() => Promise.reject(new Error('ENOTFOUND')))
    expect(await identify(1396)).toEqual({ kind: 'unknown' })
  })

  /** A series TMDB serves but reports no seasons for is not a usable answer. */
  it('does not treat a zero season count as a series', async () => {
    const identify = tmdbIdentify(async (_id, type) =>
      type === 'tv' ? { seasonCount: 0 } : missing(),
    )
    expect(await identify(1)).toEqual({ kind: 'unknown' })
  })
})
