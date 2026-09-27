/**
 * Auto-next: what counts as the end, what comes next, and the countdown.
 */

import { describe, expect, it, vi } from 'vitest'

import type { Season } from '@shared/types'
import { UP_NEXT_COUNTDOWN_MS, UpNextController, isEpisodeEnd, nextAiredEpisode, type NextEpisode, type UpNextOffer } from './upnext'

const NOW = new Date(2026, 8, 27, 20, 0, 0).getTime()

describe('isEpisodeEnd', () => {
  it('takes the last second and a half, and the video ending', () => {
    expect(isEpisodeEnd({ seconds: 2_698.6, duration: 2_700, ended: false }, 45)).toBe(true)
    expect(isEpisodeEnd({ seconds: 2_700, duration: 2_700, ended: true }, 45)).toBe(true)
    expect(isEpisodeEnd({ seconds: 2_690, duration: 2_700, ended: false }, 45)).toBe(false)
  })

  /** The reason for the length check: an advert ends too. */
  it("does not take an advert's end for the episode's", () => {
    expect(isEpisodeEnd({ seconds: 30, duration: 30, ended: true }, 45)).toBe(false)
    expect(isEpisodeEnd({ seconds: 30, duration: 30, ended: true }, null)).toBe(false)
  })

  it('needs a length to measure against', () => {
    expect(isEpisodeEnd({ seconds: 2_700, duration: null, ended: true }, 45)).toBe(false)
    expect(isEpisodeEnd({ seconds: 2_700, duration: Infinity, ended: true }, 45)).toBe(false)
  })
})

describe('nextAiredEpisode', () => {
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

  it('does not guess when TMDB cannot be asked', async () => {
    const failing = async () => {
      throw new Error('offline')
    }
    expect(await nextAiredEpisode({ season: 1, episode: 1 }, 2, failing, NOW)).toBeNull()
  })

  it('treats an episode with no date as not out', async () => {
    const undated = async () => ({ season: 1, name: '', episodes: [ep(1, '2026-01-01'), ep(2, null)] })
    expect(await nextAiredEpisode({ season: 1, episode: 1 }, 1, undated, NOW)).toBeNull()
  })
})

describe('UpNextController', () => {
  const place = { tmdbId: 7, season: 1, episode: 1, seasonCount: 2 }
  const next: NextEpisode = { season: 1, episode: 2, name: 'Two' }

  function controller(options: { enabled?: boolean; resolve?: NextEpisode | null } = {}) {
    vi.useFakeTimers({ now: NOW })
    const offers: Array<UpNextOffer | null> = []
    const advanced: Array<[NextEpisode, boolean]> = []
    const upNext = new UpNextController({
      enabled: () => options.enabled ?? true,
      resolve: async () => (options.resolve === undefined ? next : options.resolve),
      announce: (offer) => offers.push(offer),
      advance: (episode, onTv) => advanced.push([episode, onTv]),
    })
    return { upNext, offers, advanced }
  }

  it('counts down five seconds, then plays the next episode', async () => {
    const { upNext, offers, advanced } = controller()

    await upNext.ended(place, false)
    expect(offers).toEqual([{ ...next, at: NOW + UP_NEXT_COUNTDOWN_MS, onTv: false }])

    vi.advanceTimersByTime(UP_NEXT_COUNTDOWN_MS - 1)
    expect(advanced).toEqual([])
    vi.advanceTimersByTime(1)
    expect(advanced).toEqual([[next, false]])
    expect(offers.at(-1)).toBeNull()
    vi.useRealTimers()
  })

  /** Several readings report the same end; only one countdown may start. */
  it('handles each end once', async () => {
    const { upNext, offers } = controller()

    await upNext.ended(place, false)
    await upNext.ended(place, false)
    expect(offers).toHaveLength(1)
    vi.useRealTimers()
  })

  it('stays cancelled for this end, and counts the next one', async () => {
    const { upNext, advanced } = controller()

    await upNext.ended(place, false)
    upNext.cancel()
    await upNext.ended(place, false)
    vi.advanceTimersByTime(10_000)
    expect(advanced).toEqual([])

    upNext.reset()
    await upNext.ended({ ...place, episode: 2 }, false)
    vi.advanceTimersByTime(UP_NEXT_COUNTDOWN_MS)
    expect(advanced).toHaveLength(1)
    vi.useRealTimers()
  })

  it('plays at once when asked', async () => {
    const { upNext, advanced } = controller()
    await upNext.ended(place, true)
    upNext.playNow()
    expect(advanced).toEqual([[next, true]])
    vi.useRealTimers()
  })

  it('does nothing when switched off or when nothing is next', async () => {
    const off = controller({ enabled: false })
    await off.upNext.ended(place, false)
    expect(off.offers).toEqual([])

    const last = controller({ resolve: null })
    await last.upNext.ended(place, false)
    expect(last.offers).toEqual([])
    vi.useRealTimers()
  })

  it('drops an answer that arrives after the viewer moved on', async () => {
    vi.useFakeTimers({ now: NOW })
    let answer: (value: NextEpisode | null) => void = () => {}
    const offers: Array<UpNextOffer | null> = []
    const upNext = new UpNextController({
      enabled: () => true,
      resolve: () => new Promise((resolve) => (answer = resolve)),
      announce: (offer) => offers.push(offer),
      advance: () => {},
    })

    const pending = upNext.ended(place, false)
    upNext.reset()
    answer(next)
    await pending
    expect(offers).toEqual([])
    vi.useRealTimers()
  })
})
