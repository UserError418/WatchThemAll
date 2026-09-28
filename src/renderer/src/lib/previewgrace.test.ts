import { describe, expect, it } from 'vitest'
import type { PreviewReport } from '@shared/ipc'
import { GRACE_SECONDS, PreviewGrace } from './previewgrace'

const at = (seconds: number, patch: Partial<PreviewReport> = {}): PreviewReport => ({
  started: true,
  seconds,
  duration: 2_700,
  playing: true,
  muted: false,
  streamedMs: 2_000,
  ...patch,
})

describe('PreviewGrace', () => {
  it('counts five seconds heard, then keeps the place', () => {
    const grace = new PreviewGrace()
    for (const s of [100, 102, 104]) grace.feed(at(s))
    expect(grace.kept()).toBeNull()
    grace.feed(at(100 + GRACE_SECONDS + 1))
    expect(grace.kept()).toEqual({ seconds: 106, duration: 2_700 })
  })

  it('never counts muted playing', () => {
    const grace = new PreviewGrace()
    for (let s = 0; s <= 60; s += 2) grace.feed(at(s, { muted: true }))
    expect(grace.kept()).toBeNull()
  })

  it('does not count a jump as listening', () => {
    const grace = new PreviewGrace()
    grace.feed(at(0))
    grace.feed(at(754))
    grace.feed(at(756))
    expect(grace.kept()).toBeNull()
  })

  it('does not count before the film is shown, or while it is paused', () => {
    const grace = new PreviewGrace()
    for (let s = 0; s <= 20; s += 2) grace.feed(at(s, { started: false }))
    for (let s = 20; s <= 40; s += 2) grace.feed(at(s, { playing: false }))
    expect(grace.kept()).toBeNull()
  })

  it('keeps the last place heard, not where a muted stretch ran on to', () => {
    const grace = new PreviewGrace()
    for (const s of [10, 12, 14, 16]) grace.feed(at(s))
    expect(grace.kept()?.seconds).toBe(16)
    for (const s of [18, 40, 80]) grace.feed(at(s, { muted: true }))
    expect(grace.kept()?.seconds).toBe(16)
  })

  it('adds up heard time across a muted break', () => {
    const grace = new PreviewGrace()
    grace.feed(at(0))
    grace.feed(at(3))
    grace.feed(at(5, { muted: true }))
    grace.feed(at(7))
    grace.feed(at(9))
    expect(grace.kept()?.seconds).toBe(9)
  })
})
