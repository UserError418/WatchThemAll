/**
 * Next and previous episode: the rule auto-next and the cast remote share.
 */

import { describe, expect, it, vi } from 'vitest'

import type { Season } from './types'
import { nextAiredEpisode, previousEpisode } from './episodesteps'

const NOW = new Date(2026, 8, 27, 20, 0, 0).getTime()

const ep = (episode: number, airDate: string | null, name = `Episode ${episode}`) => ({
  season: 0,
  episode,
  name,
  airDate,
  overview: '',
  stillPath: null,
  runtime: 45,
  rating: 0,
})

const seasons: Record<number, Season> = {
  1: { season: 1, name: 'Season 1', episodes: [ep(1, '2026-01-01'), ep(2, '2026-01-08'), ep(3, '2026-01-15')] },
  2: { season: 2, name: 'Season 2', episodes: [ep(1, '2026-09-20', 'Return'), ep(2, '2026-10-04')] },
}
const fetchSeason = vi.fn(async (n: number) => seasons[n] ?? null)

const failing = async (): Promise<Season | null> => {
  throw new Error('offline')
}

describe('nextAiredEpisode', () => {
  it('plays the next episode of the season', async () => {
    expect(await nextAiredEpisode({ season: 1, episode: 1 }, 2, fetchSeason, NOW)).toEqual({ season: 1, episode: 2, name: 'Episode 2' })
  })

  it('rolls into the next season after the last episode', async () => {
    expect(await nextAiredEpisode({ season: 1, episode: 3 }, 2, fetchSeason, NOW)).toEqual({ season: 2, episode: 1, name: 'Return' })
  })

  it('stops at the last aired episode', async () => {
    expect(await nextAiredEpisode({ season: 2, episode: 1 }, 2, fetchSeason, NOW)).toBeNull()
  })

  it('stops at the end of the last season', async () => {
    expect(await nextAiredEpisode({ season: 2, episode: 2 }, 2, fetchSeason, NOW)).toBeNull()
  })

  /** The remote does not know the season count; a season that is not there fails to fetch. */
  it('stops at the end when the season count is unknown', async () => {
    const strict = async (n: number): Promise<Season | null> => {
      const found = seasons[n]
      if (!found) throw new Error('404')
      return found
    }
    expect(await nextAiredEpisode({ season: 1, episode: 3 }, Infinity, strict, NOW)).toEqual({ season: 2, episode: 1, name: 'Return' })
    expect(await nextAiredEpisode({ season: 2, episode: 2 }, Infinity, strict, NOW)).toBeNull()
  })

  it('does not guess when TMDB cannot be asked', async () => {
    expect(await nextAiredEpisode({ season: 1, episode: 1 }, 2, failing, NOW)).toBeNull()
  })

  it('treats an episode with no date as not out', async () => {
    const undated = async () => ({ season: 1, name: '', episodes: [ep(1, '2026-01-01'), ep(2, null)] })
    expect(await nextAiredEpisode({ season: 1, episode: 1 }, 1, undated, NOW)).toBeNull()
  })
})

describe('previousEpisode', () => {
  it('steps back within the season', async () => {
    expect(await previousEpisode({ season: 1, episode: 3 }, fetchSeason)).toEqual({ season: 1, episode: 2, name: 'Episode 2' })
  })

  /** The gap this exists to close: it used to land on episode 1 of the season before. */
  it('goes to the last episode of the previous season from an episode 1', async () => {
    expect(await previousEpisode({ season: 2, episode: 1 }, fetchSeason)).toEqual({ season: 1, episode: 3, name: 'Episode 3' })
  })

  it('has nothing before the first episode of the first season', async () => {
    expect(await previousEpisode({ season: 1, episode: 1 }, fetchSeason)).toBeNull()
  })

  /** Everything before the episode being watched is out; old seasons often lack dates. */
  it('does not ask whether an earlier episode has aired', async () => {
    const undated = async () => ({ season: 1, name: '', episodes: [ep(1, null), ep(2, null)] })
    expect(await previousEpisode({ season: 1, episode: 2 }, undated)).toEqual({ season: 1, episode: 1, name: 'Episode 1' })
  })

  /** Seasons numbered on from the last one, as some anime are on TMDB. */
  it('follows the list rather than counting', async () => {
    const numberedOn = async (n: number) =>
      n === 2 ? { season: 2, name: '', episodes: [ep(13, '2026-01-01'), ep(14, '2026-01-08')] } : seasons[1]!
    expect(await previousEpisode({ season: 2, episode: 13 }, numberedOn)).toEqual({ season: 1, episode: 3, name: 'Episode 3' })
  })

  it('still steps back within a season when TMDB cannot be asked', async () => {
    expect(await previousEpisode({ season: 2, episode: 5 }, failing)).toEqual({ season: 2, episode: 4, name: null })
  })

  it('does not guess across a season boundary when TMDB cannot be asked', async () => {
    expect(await previousEpisode({ season: 2, episode: 1 }, failing)).toBeNull()
  })

  /** The chrome's `season` answers null for a list it could not get, rather than throwing. */
  it('treats a season that came back empty-handed like one that could not be asked', async () => {
    const nothing = async () => null
    expect(await previousEpisode({ season: 2, episode: 5 }, nothing)).toEqual({ season: 2, episode: 4, name: null })
    expect(await previousEpisode({ season: 2, episode: 1 }, nothing)).toBeNull()
  })
})
