import { describe, expect, it } from 'vitest'

import type { PreviewReport } from '@shared/ipc'
import { PreviewWatch } from './previewwatch'

const report = (seconds: number, extra: Partial<PreviewReport> = {}): PreviewReport => ({
  started: true,
  seconds,
  duration: 2700,
  playing: true,
  waiting: false,
  muted: false,
  streamedMs: null,
  ...extra,
})

describe('PreviewWatch', () => {
  /** The owner, 2026-09-29: no five-second grace any more. */
  it('counts from the first second heard', () => {
    const watch = new PreviewWatch()
    watch.feed(report(600))
    expect(watch.kept()).toEqual({ seconds: 600, duration: 2700, playedMs: 0 })
    watch.feed(report(602))
    expect(watch.kept()).toEqual({ seconds: 602, duration: 2700, playedMs: 2000 })
  })

  /** The owner, 2026-09-30: muted counts too. */
  it('counts muted time like time with sound', () => {
    const watch = new PreviewWatch()
    watch.feed(report(600, { muted: true }))
    watch.feed(report(602, { muted: true }))
    watch.feed(report(604))
    expect(watch.kept()).toEqual({ seconds: 604, duration: 2700, playedMs: 4000 })
  })

  it('does not count a jump as watching', () => {
    const watch = new PreviewWatch()
    watch.feed(report(10))
    watch.feed(report(600))
    watch.feed(report(602))
    expect(watch.kept()?.playedMs).toBe(2000)
  })

  it('counts nothing before the film has really started, or while it is paused', () => {
    const watch = new PreviewWatch()
    watch.feed(report(0, { started: false }))
    watch.feed(report(600, { playing: false }))
    expect(watch.kept()).toBeNull()
  })
})
