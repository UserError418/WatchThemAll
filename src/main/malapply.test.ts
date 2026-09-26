import { describe, expect, it, vi } from 'vitest'
import { applyMalImport, type ImportDecisions, type ResolvedTitle } from './malapply'
import { DEFAULT_TARGETS, type MalEntry } from './malimport'
import { emptyStore } from './migrate'
import type { MediaType, StoreShape } from '@shared/types'
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
  async (title: string, type: MediaType = 'tv'): Promise<ResolvedTitle> => ({
    tmdbId: fakeId(title),
    type,
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

  it('adds an unmatched title once, however often the list is imported', async () => {
    const obscure = [entry({ malId: 41487, title: 'Something Obscure', status: 'completed' })]
    const first = await applyMalImport(emptyStore(), obscure, decisions(), resolveNone)
    const again = await applyMalImport(first.store, obscure, decisions(), resolveNone)

    expect(again.store.watched).toHaveLength(1)
    expect(again.summary).toMatchObject({ watched: 0, unmatched: ['Something Obscure'] })
  })

  it('does not bring back an unmatched card the user deleted', async () => {
    const obscure = [entry({ malId: 41487, title: 'Something Obscure', status: 'completed' })]
    const first = await applyMalImport(emptyStore(), obscure, decisions(), resolveNone)
    const deleted = { ...first.store, watched: first.store.watched.map((w) => ({ ...w, deletedAt: 5 })) }

    const again = await applyMalImport(deleted, obscure, decisions(), resolveNone)

    expect(again.store.watched).toEqual(deleted.watched)
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
        type: 'tv',
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

  it('turns scores into ratings one to one, middle of the scale included', async () => {
    const { store, summary } = await applyMalImport(
      emptyStore(),
      [
        entry({ malId: 1, title: 'loved', score: 9 }),
        entry({ malId: 2, title: 'hated', score: 3 }),
        entry({ malId: 3, title: 'fine', score: 7 }),
        entry({ malId: 4, title: 'unscored', score: 0 }),
      ],
      decisions(),
      resolveAll,
    )

    expect(store.ratings.map((r) => r.value).sort()).toEqual([3, 7, 9])
    // Chosen by the user on the same 1–10 scale, so not a conversion.
    expect(store.ratings.every((r) => !r.coarse && r.season === null)).toBe(true)
    expect(store.ratings.find((r) => r.value === 7)?.rating).toBe('like')
    expect(summary).toMatchObject({ ratings: 3, refined: 0 })
  })

  it('never overwrites a rating the user set by hand', async () => {
    // An import is bulk and old; a rating made in the app is deliberate and
    // recent. Silently replacing the second is data loss nobody notices until
    // the recommendations stop making sense.
    const id = fakeId('Cowboy Bebop')
    const before: StoreShape = {
      ...emptyStore(),
      ratings: [stamp({ key: `tv:${id}`, tmdbId: id, type: 'tv', season: null,
        value: 9, coarse: false, rating: 'like', genreIds: [], at: 1 })],
    }

    const { store, summary } = await applyMalImport(
      before,
      [entry({ score: 7 })],
      decisions(),
      resolveAll,
    )

    expect(store.ratings).toEqual(before.ratings)
    expect(summary).toMatchObject({ ratings: 0, refined: 0 })
  })

  describe('refining a converted thumb', () => {
    const id = fakeId('Cowboy Bebop')
    /** A thumb from before the 1–10 scale, as `migrate` converted it. */
    const converted = (value: 8 | 4) =>
      stamp(
        { key: `tv:tt${id}`, tmdbId: id, type: 'tv' as const, season: null, value,
          coarse: true, rating: value === 8 ? ('like' as const) : ('dislike' as const),
          genreIds: [16], at: 1 },
        1,
      )

    /**
     * The point of the refine: the thumb said which side, MAL says how far,
     * and they agree — so the exact score replaces the conversion.
     */
    it('replaces a converted like with the exact score when MAL agrees', async () => {
      const { store, summary } = await applyMalImport(
        { ...emptyStore(), ratings: [converted(8)] },
        [entry({ score: 10 })],
        decisions(),
        resolveAll,
      )

      expect(store.ratings).toHaveLength(1)
      expect(store.ratings[0]).toMatchObject({
        key: `tv:tt${id}`,
        value: 10,
        coarse: false,
        rating: 'like',
        genreIds: [16],
      })
      // Stamped, so the refined record wins the next merge.
      expect(store.ratings[0]!.updatedAt).toBeGreaterThan(1)
      expect(summary).toMatchObject({ ratings: 0, refined: 1 })
    })

    /**
     * A converted like against a MAL 4: the two contradict each other, so the
     * user changed their mind at some point, and the thumb in the app is the
     * newer statement.
     */
    it('leaves a converted thumb alone when MAL contradicts it', async () => {
      const before = converted(8)
      const { store, summary } = await applyMalImport(
        { ...emptyStore(), ratings: [before] },
        [entry({ score: 4 })],
        decisions(),
        resolveAll,
      )

      expect(store.ratings).toEqual([before])
      expect(summary).toMatchObject({ ratings: 0, refined: 0 })
    })

    it('refines a converted dislike too', async () => {
      const { store } = await applyMalImport(
        { ...emptyStore(), ratings: [converted(4)] },
        [entry({ score: 2 })],
        decisions(),
        resolveAll,
      )

      expect(store.ratings[0]).toMatchObject({ value: 2, coarse: false, rating: 'dislike' })
    })

    /**
     * The case the same-side-of-6 rule got wrong: someone who thumbed a MAL 7
     * down draws the like/dislike line higher than the app does. It is the
     * same opinion, and the 7 is the precise version of it.
     */
    it('refines a dislike to a MAL 6 or 7, where the user drew the line higher', async () => {
      const { store, summary } = await applyMalImport(
        { ...emptyStore(), ratings: [converted(4)] },
        [entry({ score: 7 })],
        decisions(),
        resolveAll,
      )

      expect(store.ratings[0]).toMatchObject({ value: 7, coarse: false, rating: 'like' })
      expect(summary.refined).toBe(1)
    })

    /** The reach is three either way: 8 takes 5, not 4; 4 takes 7, not 8. */
    it.each([
      [8, 5, 5],
      [8, 4, 8],
      [4, 7, 7],
      [4, 8, 4],
    ] as const)('a converted %i against MAL %i ends up %i', async (thumb, score, expected) => {
      const { store } = await applyMalImport(
        { ...emptyStore(), ratings: [converted(thumb)] },
        [entry({ score })],
        decisions(),
        resolveAll,
      )

      expect(store.ratings[0]!.value).toBe(expected)
    })

    /**
     * Where most converted thumbs actually are. Splitting series into seasons
     * copied each thumb onto every season, and a title rating may or may not
     * have survived next to them. Each converted one is its own refined rating.
     */
    it('refines the title rating and every converted season thumb together', async () => {
      const seasons = [1, 2, 3].map((n) => ({ ...converted(8), key: `tv:tt${id}:s${n}`, season: n }))
      const { store, summary } = await applyMalImport(
        { ...emptyStore(), ratings: [converted(8), ...seasons] },
        [entry({ score: 9 })],
        decisions(),
        resolveAll,
      )

      expect(store.ratings.map((r) => [r.season, r.value, r.coarse])).toEqual([
        [null, 9, false],
        [1, 9, false],
        [2, 9, false],
        [3, 9, false],
      ])
      expect(summary).toMatchObject({ ratings: 0, refined: 4 })
    })

    it('refines converted season thumbs when there is no title rating', async () => {
      const season = { ...converted(4), key: `tv:tt${id}:s2`, season: 2 }
      const { store, summary } = await applyMalImport(
        { ...emptyStore(), ratings: [season] },
        [entry({ score: 6 })],
        decisions(),
        resolveAll,
      )

      // Refined in place; no title rating appears beside it.
      expect(store.ratings).toHaveLength(1)
      expect(store.ratings[0]).toMatchObject({ key: `tv:tt${id}:s2`, season: 2, value: 6, coarse: false })
      expect(summary).toMatchObject({ ratings: 0, refined: 1 })
    })

    /** A season the user rated on the scale is theirs, next to converted ones. */
    it('leaves a season rated on the scale alone while refining its neighbours', async () => {
      const chosen = { ...converted(8), key: `tv:tt${id}:s1`, season: 1, value: 10 as const, coarse: false }
      const thumb = { ...converted(8), key: `tv:tt${id}:s2`, season: 2 }
      const { store, summary } = await applyMalImport(
        { ...emptyStore(), ratings: [chosen, thumb] },
        [entry({ score: 7 })],
        decisions(),
        resolveAll,
      )

      expect(store.ratings[0]).toEqual(chosen)
      expect(store.ratings[1]).toMatchObject({ season: 2, value: 7, coarse: false })
      expect(summary.refined).toBe(1)
    })

    /**
     * TMDB numbers films and series separately, so a film can share an id
     * with an anime. Its rating is not an opinion about the anime.
     */
    it('ignores a rating on a film that shares the id', async () => {
      const film = { ...converted(8), key: `movie:${id}`, type: 'movie' as const }
      const { store, summary } = await applyMalImport(
        { ...emptyStore(), ratings: [film] },
        [entry({ score: 9 })],
        decisions(),
        resolveAll,
      )

      expect(store.ratings[0]).toEqual(film)
      expect(store.ratings[1]).toMatchObject({ type: 'tv', tmdbId: id, value: 9, coarse: false })
      expect(summary).toMatchObject({ ratings: 1, refined: 0 })
    })
  })

  /**
   * MAL files "2nd Season" as an entry of its own, and it resolves to the same
   * TMDB series. The title gets the mean of those scores — first-wins made the
   * result depend on the order of the export file.
   */
  describe('several MAL entries for one title', () => {
    const sameShow = async (): Promise<ResolvedTitle> => ({
      tmdbId: 42, type: 'tv', imdbId: 'tt42', title: 'Shingeki', posterPath: null, genreIds: [16], rating: 8,
    })
    const seasons = [
      entry({ malId: 1, title: 'Shingeki no Kyojin', score: 9 }),
      entry({ malId: 2, title: 'Shingeki no Kyojin Season 2', score: 6 }),
      entry({ malId: 3, title: 'Shingeki no Kyojin Season 3', score: 0 }),
    ]

    it('rates the title with the rounded mean of the scored entries', async () => {
      const { store, summary } = await applyMalImport(emptyStore(), seasons, decisions(), sameShow)

      // (9 + 6) / 2 = 7.5, rounded half up; the unscored entry is not a zero.
      expect(store.ratings).toHaveLength(1)
      expect(store.ratings[0]).toMatchObject({ tmdbId: 42, season: null, value: 8 })
      expect(summary.ratings).toBe(1)
    })

    it('gives the same answer whatever order the export lists them in', async () => {
      const forward = await applyMalImport(emptyStore(), seasons, decisions(), sameShow)
      const backward = await applyMalImport(
        emptyStore(), [...seasons].reverse(), decisions(), sameShow,
      )
      expect(backward.store.ratings[0]?.value).toBe(forward.store.ratings[0]?.value)
    })

    it('refines with the mean, not with whichever entry came first', async () => {
      const thumb = stamp({ key: 'tv:tt42', tmdbId: 42, type: 'tv' as const, season: null,
        value: 8 as const, coarse: true, rating: 'like' as const, genreIds: [], at: 1 }, 1)
      const { store, summary } = await applyMalImport(
        { ...emptyStore(), ratings: [thumb] },
        [entry({ malId: 1, score: 10 }), entry({ malId: 2, score: 7 })],
        decisions(),
        sameShow,
      )

      // (10 + 7) / 2 = 8.5 → 9, which agrees with the like it refines.
      expect(store.ratings[0]).toMatchObject({ value: 9, coarse: false })
      expect(summary.refined).toBe(1)
    })
  })

  /**
   * A MAL "TV" entry can resolve to a film. The id is a film's id, so filing it
   * as a series points at a different show or at nothing (a /tv/ lookup 404s).
   */
  describe('a MAL entry that resolves to the other media type', () => {
    const film = async (title: string): Promise<ResolvedTitle> => ({
      tmdbId: 431572, type: 'movie', imdbId: 'tt6342440', title, posterPath: null, genreIds: [16], rating: 6.6,
    })

    it('files the match under the type TMDB gives it', async () => {
      const { store } = await applyMalImport(
        emptyStore(),
        [
          entry({ malId: 1, status: 'completed', score: 9 }),
          entry({ malId: 2, status: 'watching' }),
          entry({ malId: 3, status: 'planToWatch' }),
        ],
        decisions(),
        film,
      )

      expect(store.watched[0]).toMatchObject({ tmdbId: 431572, type: 'movie' })
      expect(store.watchlist[0]).toMatchObject({ type: 'movie', lastSeason: null, lastEpisode: null })
      // Films have no episodes to track.
      expect(store.trackers).toHaveLength(0)
      expect(store.ratings[0]).toMatchObject({ key: 'movie:tt6342440', type: 'movie', value: 9 })
    })

    /**
     * The season-split pass (1.5.8) already re-keyed mistyped MAL imports from
     * tv:X to movie:X. A re-import has to find that rating, not create a new
     * tv:X beside it.
     */
    it('refines the rating filed under the film', async () => {
      const repaired = stamp({ key: 'movie:431572', tmdbId: 431572, type: 'movie' as const, season: null,
        value: 8 as const, coarse: true, rating: 'like' as const, genreIds: [], at: 1 }, 1)
      const { store, summary } = await applyMalImport(
        { ...emptyStore(), ratings: [repaired] },
        [entry({ score: 9 })],
        decisions(),
        film,
      )

      expect(store.ratings).toHaveLength(1)
      expect(store.ratings[0]).toMatchObject({ key: 'movie:431572', value: 9, coarse: false })
      expect(summary).toMatchObject({ ratings: 0, refined: 1 })
    })

    it('keeps a series and a film that share an id apart', async () => {
      const either = async (title: string): Promise<ResolvedTitle> => ({
        tmdbId: 99, type: title === 'the film' ? 'movie' : 'tv', imdbId: null, title, posterPath: null, genreIds: [], rating: 7,
      })
      const { store } = await applyMalImport(
        emptyStore(),
        [entry({ malId: 1, title: 'the series', score: 9 }), entry({ malId: 2, title: 'the film', score: 3 })],
        decisions(),
        either,
      )

      expect(store.watched.map((w) => w.type).sort()).toEqual(['movie', 'tv'])
      expect(store.ratings.map((r) => [r.type, r.value]).sort()).toEqual([['movie', 3], ['tv', 9]])
    })
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
