/**
 * Auto-next: what counts as the end, and moving to what comes next.
 */

import { describe, expect, it } from 'vitest'

import type { NextEpisode } from '@shared/episodesteps'
import { UpNextController, isEpisodeEnd } from './upnext'

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
  const PLAYING = { seconds: 600, duration: 2700, ended: false }
  const END = { seconds: 2700, duration: 2700, ended: true }
  /** Lets the TMDB answer settle. */
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  function controller(options: { enabled?: boolean; resolve?: NextEpisode | null } = {}) {
    const advanced: Array<[NextEpisode, boolean]> = []
    const upNext = new UpNextController({
      enabled: () => options.enabled ?? true,
      resolve: async () => (options.resolve === undefined ? next : options.resolve),
      advance: (episode, onTv) => advanced.push([episode, onTv]),
    })
    /** The episode plays, then ends. */
    const watchToEnd = async (at = place, onTv = false): Promise<void> => {
      upNext.observe(at, PLAYING, 45, onTv)
      upNext.observe(at, END, 45, onTv)
      await flush()
    }
    return { upNext, advanced, watchToEnd }
  }

  /** The owner, 2026-09-29: no countdown and no prompt. */
  it('plays the next episode as soon as the end is seen, here or on the television', async () => {
    const here = controller()
    await here.watchToEnd()
    expect(here.advanced).toEqual([[next, false]])

    const tv = controller()
    await tv.watchToEnd(place, true)
    expect(tv.advanced).toEqual([[next, true]])
  })

  /** Several readings report the same end; only one may move the viewer. */
  it('handles each end once, and the next end after a reset', async () => {
    const { upNext, advanced, watchToEnd } = controller()
    await watchToEnd()
    upNext.observe(place, END, 45, false)
    await flush()
    expect(advanced).toHaveLength(1)

    upNext.reset()
    await watchToEnd({ ...place, episode: 2 })
    expect(advanced).toHaveLength(2)
  })

  /**
   * The episode left keeps reporting its end for a moment after the step.
   * Measured on the emulator: one end ran S1E3 on to S2E1 in twenty seconds.
   */
  it('does not take the episode left, still reporting its end, for the end of the next', async () => {
    const { upNext, advanced, watchToEnd } = controller()
    await watchToEnd()
    upNext.reset()
    const stepped = { ...place, episode: 2 }
    upNext.observe(stepped, END, 45, false)
    upNext.observe(stepped, END, 45, false)
    await flush()
    expect(advanced).toHaveLength(1)
  })

  it('does not count an advert as the episode playing', async () => {
    const { upNext, advanced } = controller()
    upNext.observe(place, { seconds: 10, duration: 30, ended: false }, 45, false)
    upNext.observe(place, END, 45, false)
    await flush()
    expect(advanced).toEqual([])
  })

  it('does nothing when switched off or when nothing is next', async () => {
    const off = controller({ enabled: false })
    await off.watchToEnd()
    expect(off.advanced).toEqual([])

    const last = controller({ resolve: null })
    await last.watchToEnd()
    expect(last.advanced).toEqual([])
  })

  it('drops an answer that arrives after the viewer moved on', async () => {
    let answer: (value: NextEpisode | null) => void = () => {}
    const advanced: NextEpisode[] = []
    const upNext = new UpNextController({
      enabled: () => true,
      resolve: () => new Promise((resolve) => (answer = resolve)),
      advance: (episode) => advanced.push(episode),
    })

    upNext.observe(place, PLAYING, 45, false)
    upNext.observe(place, END, 45, false)
    upNext.reset()
    answer(next)
    await flush()
    expect(advanced).toEqual([])
  })
})
