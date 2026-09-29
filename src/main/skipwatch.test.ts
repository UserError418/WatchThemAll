/**
 * The skip buttons, reading by reading: what made the intro button flaky
 * until 2.0.6 is pinned here, one test per cause (see `skipwatch.ts`).
 */

import { describe, expect, it } from 'vitest'

import type { SkipOffer } from '@shared/ipc'
import { SKIP_RETRY_MS, SkipWatch } from './skipwatch'
import type { SkipSegment } from './skiptimes'

const INTRO: SkipSegment = { kind: 'intro', startSeconds: 437, endSeconds: 531, source: 'introdb' }
const OUTRO: SkipSegment = { kind: 'outro', startSeconds: 3600, endSeconds: 3720, source: 'introdb' }
const EPISODE = 3720

/** Lets a lookup's promise settle before the next reading. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function watch(options: { segments?: SkipSegment[][]; hasNext?: boolean; enabled?: () => boolean } = {}) {
  const answers = [...(options.segments ?? [[INTRO, OUTRO]])]
  const offers: Array<SkipOffer | null> = []
  const lookups: number[] = []
  let clock = 0
  const skip = new SkipWatch({
    enabled: options.enabled ?? (() => true),
    expectedMinutes: () => 62,
    lookup: async (seconds) => {
      lookups.push(seconds)
      return answers.shift() ?? []
    },
    hasNext: async () => options.hasNext ?? true,
    announce: (offer) => offers.push(offer),
    now: () => clock,
  })
  return { skip, offers, lookups, tick: (ms: number) => (clock += ms) }
}

describe('SkipWatch', () => {
  it('offers the intro while it plays, and takes it down after', async () => {
    const { skip, offers } = watch()
    skip.reading({ seconds: 10, duration: EPISODE })
    await settle()
    skip.reading({ seconds: 440, duration: EPISODE })
    skip.reading({ seconds: 445, duration: EPISODE })
    skip.reading({ seconds: 540, duration: EPISODE })
    expect(offers).toEqual([{ kind: 'intro' }, null])
  })

  /** The flaky button's main cause: the first reading was an advert's. */
  it('does not ask, or refuse anything, while an advert plays', async () => {
    const { skip, offers, lookups } = watch()
    skip.reading({ seconds: 5, duration: 30 })
    await settle()
    expect(lookups).toEqual([])
    skip.reading({ seconds: 440, duration: EPISODE })
    await settle()
    skip.reading({ seconds: 441, duration: EPISODE })
    expect(lookups).toEqual([EPISODE])
    expect(offers).toEqual([{ kind: 'intro' }])
  })

  it('asks again, a while later, when a lookup found nothing', async () => {
    const { skip, offers, lookups, tick } = watch({ segments: [[], [INTRO]] })
    skip.reading({ seconds: 10, duration: EPISODE })
    await settle()
    skip.reading({ seconds: 20, duration: EPISODE })
    expect(lookups).toHaveLength(1)
    tick(SKIP_RETRY_MS)
    skip.reading({ seconds: 30, duration: EPISODE })
    await settle()
    skip.reading({ seconds: 440, duration: EPISODE })
    expect(lookups).toHaveLength(2)
    expect(offers).toEqual([{ kind: 'intro' }])
  })

  it('seeks past the intro when pressed, and does not offer it again', async () => {
    const { skip, offers } = watch()
    skip.reading({ seconds: 10, duration: EPISODE })
    await settle()
    skip.reading({ seconds: 440, duration: EPISODE })
    expect(skip.press()).toEqual({ kind: 'seek', seconds: 531.5 })
    skip.reading({ seconds: 441, duration: EPISODE })
    expect(offers).toEqual([{ kind: 'intro' }, null])
    expect(skip.press()).toBeNull()
  })

  it('offers the next episode over the credits, once it knows there is one', async () => {
    const { skip, offers } = watch()
    skip.reading({ seconds: 10, duration: EPISODE })
    await settle()
    skip.reading({ seconds: 3605, duration: EPISODE })
    await settle()
    skip.reading({ seconds: 3607, duration: EPISODE })
    expect(offers).toEqual([{ kind: 'next' }])
    expect(skip.press()).toEqual({ kind: 'next' })
  })

  it('offers nothing over the last episode aired', async () => {
    const { skip, offers } = watch({ hasNext: false })
    skip.reading({ seconds: 10, duration: EPISODE })
    await settle()
    skip.reading({ seconds: 3605, duration: EPISODE })
    await settle()
    skip.reading({ seconds: 3607, duration: EPISODE })
    expect(offers).toEqual([])
  })

  it('drops an answer about the episode left', async () => {
    let answer: (segments: SkipSegment[]) => void = () => {}
    const offers: Array<SkipOffer | null> = []
    const skip = new SkipWatch({
      enabled: () => true,
      expectedMinutes: () => 62,
      lookup: () => new Promise((resolve) => (answer = resolve)),
      hasNext: async () => true,
      announce: (offer) => offers.push(offer),
    })
    skip.reading({ seconds: 10, duration: EPISODE })
    skip.reset()
    answer([INTRO])
    await settle()
    skip.reading({ seconds: 440, duration: EPISODE })
    expect(offers).toEqual([])
  })

  it('stands down when switched off, and never asks', async () => {
    let on = true
    const { skip, offers, lookups } = watch({ enabled: () => on })
    skip.reading({ seconds: 10, duration: EPISODE })
    await settle()
    skip.reading({ seconds: 440, duration: EPISODE })
    on = false
    skip.reading({ seconds: 441, duration: EPISODE })
    expect(offers).toEqual([{ kind: 'intro' }, null])

    const off = watch({ enabled: () => false })
    off.skip.reading({ seconds: 440, duration: EPISODE })
    expect(off.lookups).toEqual([])
    expect(lookups).toHaveLength(1)
  })
})
