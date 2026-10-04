import { describe, expect, it } from 'vitest'
import { episodeToPlay, pickUp, resumeTarget, type EpisodeRef } from './progress'

/** One season of ten, which is what most of these need. */
function season(number: number, count = 10): EpisodeRef[] {
  return Array.from({ length: count }, (_, index) => ({ season: number, episode: index + 1 }))
}

/** `isWatched` from a list of `"S:E"` keys, matching the store's own shape. */
function watched(...keys: string[]) {
  const set = new Set(keys)
  return (s: number, e: number): boolean => set.has(`${s}:${e}`)
}

describe('resumeTarget', () => {
  it('offers the episode that was started but not finished', () => {
    expect(
      resumeTarget({
        episodes: season(1),
        lastSeason: 1,
        lastEpisode: 4,
        seasonCount: 3,
        isWatched: watched('1:1', '1:2', '1:3'),
      }),
    ).toEqual({ season: 1, episode: 4 })
  })

  /**
   * The reported bug. Finishing an episode leaves it as the last one *started*,
   * and reading that field straight out offered it again — with the "you are
   * here" highlight on the same row.
   */
  it('moves past an episode that was watched to the end', () => {
    expect(
      resumeTarget({
        episodes: season(1),
        lastSeason: 1,
        lastEpisode: 1,
        seasonCount: 3,
        isWatched: watched('1:1'),
      }),
    ).toEqual({ season: 1, episode: 2 })
  })

  it('skips a run of episodes already watched out of order', () => {
    expect(
      resumeTarget({
        episodes: season(1),
        lastSeason: 1,
        lastEpisode: 1,
        seasonCount: 3,
        isWatched: watched('1:1', '1:2', '1:3', '1:5'),
      }),
    ).toEqual({ season: 1, episode: 4 })
  })

  it('crosses into the next season when this one is finished', () => {
    expect(
      resumeTarget({
        episodes: season(2, 3),
        lastSeason: 2,
        lastEpisode: 3,
        seasonCount: 4,
        isWatched: watched('2:1', '2:2', '2:3'),
      }),
    ).toEqual({ season: 3, episode: 1 })
  })

  it('stays put on the last episode of the last season', () => {
    expect(
      resumeTarget({
        episodes: season(4, 3),
        lastSeason: 4,
        lastEpisode: 3,
        seasonCount: 4,
        isWatched: watched('4:1', '4:2', '4:3'),
      }),
    ).toEqual({ season: 4, episode: 3 })
  })

  /**
   * The overlay shows one season at a time, so the loaded list is routinely a
   * different season from the stored position. Counting those episodes as
   * candidates would send the user to the wrong season entirely.
   */
  it('ignores episodes belonging to another season', () => {
    expect(
      resumeTarget({
        episodes: season(4),
        lastSeason: 1,
        lastEpisode: 2,
        seasonCount: 4,
        isWatched: watched('1:2'),
      }),
    ).toEqual({ season: 1, episode: 2 })
  })

  /**
   * With no list for that season there is no way to tell "finished it" from
   * "have not been told what is in it", and guessing forward would offer an
   * episode that may not exist.
   */
  it('does not guess forward when the season has not been loaded', () => {
    expect(
      resumeTarget({
        episodes: [],
        lastSeason: 1,
        lastEpisode: 6,
        seasonCount: 3,
        isWatched: watched('1:6'),
      }),
    ).toEqual({ season: 1, episode: 6 })
  })

  it('handles a season whose episodes arrive out of order', () => {
    const shuffled: EpisodeRef[] = [
      { season: 1, episode: 3 },
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
    ]
    expect(
      resumeTarget({
        episodes: shuffled,
        lastSeason: 1,
        lastEpisode: 1,
        seasonCount: 1,
        isWatched: watched('1:1'),
      }),
    ).toEqual({ season: 1, episode: 2 })
  })
})

describe('episodeToPlay', () => {
  const withRuntime = (s: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({ season: s, episode: i + 1, runtime: 20 + i }))

  it('returns the listed episode, so its own runtime goes with it', () => {
    expect(episodeToPlay({ season: 3, episode: 2 }, [withRuntime(3, 5)])).toEqual({
      season: 3,
      episode: 2,
      runtime: 21,
    })
  })

  it('looks through every listing it is given', () => {
    const found = episodeToPlay({ season: 3, episode: 1 }, [withRuntime(1, 6), withRuntime(3, 5)])
    expect(found).toEqual({ season: 3, episode: 1, runtime: 20 })
  })

  it('never substitutes a different episode for one it cannot find', () => {
    // The shipped bug: target S02E01, only season 1 on screen, and the first
    // episode on screen played instead of the one the button named.
    expect(episodeToPlay({ season: 2, episode: 1 }, [withRuntime(1, 6)])).toEqual({
      season: 2,
      episode: 1,
    })
  })
})

describe('pickUp', () => {
  const listing = (season: number, count: number): EpisodeRef[] =>
    Array.from({ length: count }, (_, i) => ({ season, episode: i + 1 }))
  /** Watched up to and including `season`x`episode`, in order. */
  const watchedThrough = (season: number, episode: number) => (s: number, e: number) =>
    s < season || (s === season && e <= episode)

  it('goes back to an episode started and not finished, needing no listing', () => {
    expect(
      pickUp({ anchor: { season: 1, episode: 4 }, anchorSeason: null, nextSeason: null, isWatched: () => false }),
    ).toEqual({ target: { season: 1, episode: 4 }, need: null })
  })

  it('asks for the season listing before moving past a finished episode', () => {
    expect(
      pickUp({ anchor: { season: 1, episode: 12 }, anchorSeason: null, nextSeason: null, isWatched: watchedThrough(1, 12) }),
    ).toEqual({ target: { season: 1, episode: 12 }, need: 1 })
  })

  it('moves to the next episode of the season', () => {
    expect(
      pickUp({ anchor: { season: 1, episode: 12 }, anchorSeason: listing(1, 26), nextSeason: null, isWatched: watchedThrough(1, 12) }),
    ).toEqual({ target: { season: 1, episode: 13 }, need: null })
  })

  it("asks for the next season's listing at the end of a season", () => {
    expect(
      pickUp({ anchor: { season: 3, episode: 23 }, anchorSeason: listing(3, 23), nextSeason: null, isWatched: watchedThrough(3, 23) }),
    ).toEqual({ target: { season: 3, episode: 23 }, need: 4 })
  })

  /** The Watchlist card's fault: after a finale its play button replayed it. */
  it('crosses into the next season when there is one', () => {
    expect(
      pickUp({ anchor: { season: 3, episode: 23 }, anchorSeason: listing(3, 23), nextSeason: listing(4, 14), isWatched: watchedThrough(3, 23) }),
    ).toEqual({ target: { season: 4, episode: 1 }, need: null })
  })

  it('stays on the last episode, as a re-watch, when the series is done', () => {
    expect(
      pickUp({ anchor: { season: 7, episode: 6 }, anchorSeason: listing(7, 6), nextSeason: [], isWatched: watchedThrough(7, 6) }),
    ).toEqual({ target: { season: 7, episode: 6 }, need: null })
  })

  it('takes a known season count over a listing it does not need', () => {
    expect(
      pickUp({ anchor: { season: 3, episode: 23 }, anchorSeason: listing(3, 23), nextSeason: null, seasonCount: 9, isWatched: watchedThrough(3, 23) }),
    ).toEqual({ target: { season: 4, episode: 1 }, need: null })
  })
})
