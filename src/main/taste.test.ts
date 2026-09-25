import { describe, expect, it } from 'vitest'
import {
  excludedTmdbIds,
  genreWeights,
  hasEnoughSignal,
  MIN_SIGNAL,
  SEED_LIMIT,
  seedTitles,
  titleAffinity,
  WEIGHTS,
} from './taste'
import type { StoreShape, Synced, TitleRating, WatchedEntry, WatchlistEntry } from '@shared/types'
import { stamp } from '@shared/store/core'
import { valueOfLegacy } from '@shared/rating'

type Profile = Pick<StoreShape, 'ratings' | 'watched' | 'watchlist'>

function profile(over: Partial<Profile> = {}): Profile {
  return { ratings: [], watched: [], watchlist: [], ...over }
}

function watchlist(tmdbId: number, genreIds: number[]): Synced<WatchlistEntry> {
  return stamp({
    id: `w${tmdbId}`,
    tmdbId,
    type: 'tv',
    title: `title ${tmdbId}`,
    posterPath: null,
    imdbId: null,
    lastSeason: 1,
    lastEpisode: 1,
    watchedEpisodes: [],
    episodeMarks: {},
    genreIds,
    episodeCount: null,
    rating: 0,
    addedAt: 0,
    providerId: null,
  })
}

function watched(tmdbId: number, genreIds: number[]): Synced<WatchedEntry> {
  return stamp({
    id: `s${tmdbId}`,
    tmdbId,
    type: 'tv',
    season: null,
    title: `title ${tmdbId}`,
    posterPath: null,
    imdbId: null,
    genreIds,
    addedAt: 0,
    rating: 0,
    source: 'user',
    malId: null,
  })
}

function seasonSeen(tmdbId: number, season: number): Synced<WatchedEntry> {
  return stamp({ ...watched(tmdbId, []), id: `s${tmdbId}-${season}`, season })
}

function rating(tmdbId: number, genreIds: number[], value: 'like' | 'dislike'): Synced<TitleRating> {
  return stamp({ key: `tv:${tmdbId}`, tmdbId, type: 'tv', season: null,
    value: valueOfLegacy(value), coarse: true, rating: value, genreIds, at: 0 })
}

describe('genreWeights', () => {
  it('is empty for a fresh install', () => {
    expect(genreWeights(profile())).toEqual([])
  })

  it('ranks a stated opinion above a saved intention', () => {
    const result = genreWeights(
      profile({
        // Four watchlist entries in genre 1 against one like in genre 2.
        watchlist: [1, 2, 3, 4].map((id) => watchlist(id, [1])),
        ratings: [rating(9, [2], 'like')],
      }),
    )

    // Deliberate: no amount of watchlist padding should outrank a handful of
    // stated opinions, but four to one is enough to win.
    expect(result[0]?.genreId).toBe(1)
    expect(result.find((g) => g.genreId === 2)?.weight).toBe(WEIGHTS.like)
  })

  it('lets one dislike cancel one like', () => {
    const result = genreWeights(
      profile({ ratings: [rating(1, [7], 'like'), rating(2, [7], 'dislike')] }),
    )

    // Net zero, and zero is not positive, so the genre drops out entirely.
    expect(result.find((g) => g.genreId === 7)).toBeUndefined()
  })

  it('drops a genre the user actively dislikes, rather than ranking it last', () => {
    // There is no "show me less of this" surface to spend a negative on.
    const result = genreWeights(
      profile({
        watchlist: [watchlist(1, [5])],
        ratings: [rating(2, [5], 'dislike')],
      }),
    )

    expect(result).toEqual([])
  })

  it('weights a finished title above a saved one', () => {
    const result = genreWeights(
      profile({ watched: [watched(1, [3])], watchlist: [watchlist(2, [4])] }),
    )

    expect(result.map((g) => g.genreId)).toEqual([3, 4])
  })

  it('accumulates a genre across every source', () => {
    const result = genreWeights(
      profile({
        watchlist: [watchlist(1, [10])],
        watched: [watched(2, [10])],
        ratings: [rating(3, [10], 'like')],
      }),
    )

    expect(result[0]).toEqual({
      genreId: 10,
      weight: WEIGHTS.watchlist + WEIGHTS.watched + WEIGHTS.like,
    })
  })

  it('survives an entry written before genreIds existed', () => {
    // Migration backfills these, but a store read mid-upgrade can still hand
    // us an entry without them, and iterating undefined throws.
    const broken = { ...watchlist(1, []), genreIds: undefined as unknown as number[] }

    expect(() => genreWeights(profile({ watchlist: [broken] }))).not.toThrow()
  })

  it('orders ties deterministically', () => {
    // Otherwise the row reshuffles between renders for no visible reason.
    const a = genreWeights(profile({ watchlist: [watchlist(1, [8, 2, 5])] }))
    const b = genreWeights(profile({ watchlist: [watchlist(1, [5, 8, 2])] }))

    expect(a).toEqual(b)
    expect(a.map((g) => g.genreId)).toEqual([2, 5, 8])
  })
})

describe('excludedTmdbIds', () => {
  it('excludes everything already saved, seen, or judged', () => {
    const ids = excludedTmdbIds(
      profile({
        watchlist: [watchlist(1, [])],
        watched: [watched(2, [])],
        ratings: [rating(3, [], 'like')],
      }),
    )

    expect(ids.sort()).toEqual([1, 2, 3])
  })

  it('drops the zero id used by unresolved imports', () => {
    // A MAL entry that has not been matched to TMDB yet carries tmdbId 0.
    // Excluding "0" would exclude nothing and cost a comparison per candidate.
    expect(excludedTmdbIds(profile({ watched: [watched(0, [])] }))).toEqual([])
  })
})

describe('hasEnoughSignal', () => {
  it('is false below the threshold', () => {
    // "Because you watch Drama" from two saved titles is a guess in the costume
    // of a recommendation.
    expect(hasEnoughSignal(profile({ watchlist: [watchlist(1, [1])] }))).toBe(false)
  })

  it('is true once any mix of sources reaches it', () => {
    expect(
      hasEnoughSignal(
        profile({
          watchlist: Array.from({ length: MIN_SIGNAL }, (_, i) => watchlist(i + 1, [1])),
        }),
      ),
    ).toBe(true)
  })
})

/* ── Affinity ────────────────────────────────────────────────────────────── */

function play(tmdbId: number, playedMs: number, id = `h${tmdbId}-${playedMs}`) {
  return stamp({
    id,
    tmdbId,
    type: 'tv' as const,
    title: `title ${tmdbId}`,
    posterPath: null,
    season: 1,
    episode: 1,
    watchedAt: 0,
    playedMs,
  })
}

function affinityStore(over: Partial<Parameters<typeof titleAffinity>[0]> = {}) {
  return { ratings: [], watched: [], watchlist: [], history: [], ...over } as Parameters<
    typeof titleAffinity
  >[0]
}

describe('titleAffinity', () => {
  it('ranks a stated like above a mere watchlist entry', () => {
    const ranked = titleAffinity(
      affinityStore({
        watchlist: [watchlist(1, [18]), watchlist(2, [18])],
        ratings: [rating(2, [18], 'like')],
      }),
    )

    expect(ranked[0]?.tmdbId).toBe(2)
  })

  /**
   * The signal the store has always recorded and nothing read. Saving a title
   * is an intention and rating one is a claim; sitting through eleven hours of
   * something is a fact.
   */
  it('lets time actually invested outrank an untouched saved title', () => {
    const ranked = titleAffinity(
      affinityStore({
        watchlist: [watchlist(1, [18]), watchlist(2, [18])],
        history: [play(2, 11 * 3_600_000)],
      }),
    )

    expect(ranked[0]?.tmdbId).toBe(2)
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score)
  })

  /**
   * A 90-hour comfort show must not become the entire profile. Hours are
   * damped, so ten times the watching is not ten times the weight.
   */
  it('damps hours so one long series cannot swamp everything else', () => {
    const modest = titleAffinity(
      affinityStore({ watchlist: [watchlist(1, [18])], history: [play(1, 4 * 3_600_000)] }),
    )[0]!.score
    const enormous = titleAffinity(
      affinityStore({ watchlist: [watchlist(1, [18])], history: [play(1, 400 * 3_600_000)] }),
    )[0]!.score

    // A hundred times the hours, nowhere near a hundred times the weight.
    expect(enormous).toBeLessThan(modest * 12)
  })

  /** Asking "what is like this?" about something disliked discredits the row. */
  it('keeps disliked titles out entirely rather than ranking them last', () => {
    const ranked = titleAffinity(
      affinityStore({ watchlist: [watchlist(7, [18])], ratings: [rating(7, [18], 'dislike')] }),
    )

    expect(ranked.map((t) => t.tmdbId)).not.toContain(7)
  })

  /**
   * The acceptance criterion for this change: recommendations have to move when
   * the history moves. A profile that returns the same order regardless of what
   * was watched is the static behaviour this replaced.
   */
  it('produces a different ordering for a different history', () => {
    const base = { watchlist: [watchlist(1, [18]), watchlist(2, [18]), watchlist(3, [18])] }

    const likesOne = titleAffinity(affinityStore({ ...base, history: [play(1, 20 * 3_600_000)] }))
    const likesThree = titleAffinity(affinityStore({ ...base, history: [play(3, 20 * 3_600_000)] }))

    expect(likesOne.map((t) => t.tmdbId)).not.toEqual(likesThree.map((t) => t.tmdbId))
    expect(likesOne[0]?.tmdbId).toBe(1)
    expect(likesThree[0]?.tmdbId).toBe(3)
  })

  it('counts several watched seasons as a bigger claim than one', () => {
    const oneSeason = titleAffinity(affinityStore({ watched: [seasonSeen(1, 1)] }))[0]!.score
    const three = titleAffinity(
      affinityStore({ watched: [seasonSeen(1, 1), seasonSeen(1, 2), seasonSeen(1, 3)] }),
    )[0]!.score

    expect(three).toBeGreaterThan(oneSeason)
  })
})

describe('seedTitles', () => {
  it('takes only the strongest few, since each one costs a request', () => {
    const many = Array.from({ length: 20 }, (_, i) => watchlist(i + 1, [18]))
    expect(seedTitles(affinityStore({ watchlist: many })).length).toBe(SEED_LIMIT)
  })
})
