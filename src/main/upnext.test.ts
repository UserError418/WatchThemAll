/**
 * Auto-next: what counts as the end, what comes next, and the countdown.
 */

import { describe, expect, it, vi } from 'vitest'

import type { UpNextOffer } from '@shared/ipc'
import type { NextEpisode } from '@shared/episodesteps'
import { UP_NEXT_COUNTDOWN_MS, UpNextController, isEpisodeEnd } from './upnext'

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

describe('UpNextController', () => {
  const place = { tmdbId: 7, season: 1, episode: 1 }
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

  /** A backgrounded phone's timers run a minute late; its native ticks do not. */
  it('plays a due offer when poked, before its own timer', async () => {
    vi.useFakeTimers({ now: NOW })
    const advanced: NextEpisode[] = []
    let clock = NOW
    const upNext = new UpNextController({
      enabled: () => true,
      resolve: async () => next,
      announce: () => {},
      advance: (episode) => advanced.push(episode),
      now: () => clock,
      // A timer that never fires, as a throttled one may not for a minute.
      setTimeout: () => 0,
      clearTimeout: () => {},
    })

    await upNext.ended(place, true)
    clock = NOW + UP_NEXT_COUNTDOWN_MS - 1
    upNext.poke()
    expect(advanced).toEqual([])
    clock = NOW + UP_NEXT_COUNTDOWN_MS
    upNext.poke()
    expect(advanced).toEqual([next])
    vi.useRealTimers()
  })
})

