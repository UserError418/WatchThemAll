import { describe, expect, it } from 'vitest'
import { resumeTarget, type EpisodeRef } from './progress'

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
