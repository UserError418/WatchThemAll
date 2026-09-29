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

  function controller(options: { enabled?: boolean; resolve?: NextEpisode | null } = {}) {
    const advanced: Array<[NextEpisode, boolean]> = []
    const upNext = new UpNextController({
      enabled: () => options.enabled ?? true,
      resolve: async () => (options.resolve === undefined ? next : options.resolve),
      advance: (episode, onTv) => advanced.push([episode, onTv]),
    })
    return { upNext, advanced }
  }

  /** The owner, 2026-09-29: no countdown and no prompt. */
  it('plays the next episode as soon as the end is seen, here or on the television', async () => {
    const here = controller()
    await here.upNext.ended(place, false)
    expect(here.advanced).toEqual([[next, false]])

    const tv = controller()
    await tv.upNext.ended(place, true)
    expect(tv.advanced).toEqual([[next, true]])
  })

  /** Several readings report the same end; only one may move the viewer. */
  it('handles each end once, and the next end after a reset', async () => {
    const { upNext, advanced } = controller()

    await upNext.ended(place, false)
    await upNext.ended(place, false)
    expect(advanced).toHaveLength(1)

    upNext.reset()
    await upNext.ended({ ...place, episode: 2 }, false)
    expect(advanced).toHaveLength(2)
  })

  it('does nothing when switched off or when nothing is next', async () => {
    const off = controller({ enabled: false })
    await off.upNext.ended(place, false)
    expect(off.advanced).toEqual([])

    const last = controller({ resolve: null })
    await last.upNext.ended(place, false)
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

    const pending = upNext.ended(place, false)
    upNext.reset()
    answer(next)
    await pending
    expect(advanced).toEqual([])
  })
})
