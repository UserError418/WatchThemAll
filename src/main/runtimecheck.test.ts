/**
 * Tests for the "is this even the right thing" check.
 *
 * Weighted towards *not accusing*, because the two mistakes cost differently.
 * Missing a substitution leaves the user where they already were; wrongly
 * condemning a good provider demotes it silently and sends them somewhere
 * worse. So most of these pin cases that must come back `plausible` or
 * `unknown`, and only obvious substitutions are required to be caught.
 */

import { describe, expect, it } from 'vitest'
import { checkRuntime, lengthVerdict } from './runtimecheck'

const check = (deliveredSeconds: number, expectedMinutes: number | null) =>
  checkRuntime({ deliveredSeconds, expectedMinutes })

describe('when there is nothing to compare', () => {
  it('says so rather than guessing', () => {
    expect(check(3000, null).verdict).toBe('unknown')
    expect(check(3000, 0).verdict).toBe('unknown')
  })

  it('treats a video that has not loaded as no evidence', () => {
    expect(check(0, 45).verdict).toBe('unknown')
    expect(check(Number.NaN, 45).verdict).toBe('unknown')
  })

  it('treats a live stream as no evidence', () => {
    // An endless stream reports Infinity. That is not a claim about content.
    expect(check(Number.POSITIVE_INFINITY, 45).verdict).toBe('unknown')
  })
})

describe('what must be accepted', () => {
  it('accepts the measured real cases', () => {
    // Taken from an actual probe run rather than invented: these are what a
    // working provider delivered for titles TMDB rates at 58, 23 and 62.
    expect(check(3486.4, 58).verdict).toBe('plausible')
    expect(check(1382.4, 23).verdict).toBe('plausible')
    expect(check(3697.1, 62).verdict).toBe('plausible')
  })

  it('tolerates the few minutes an embed prepends', () => {
    expect(check(45 * 60 + 90, 45).verdict).toBe('plausible')
  })

  it('gives short titles an absolute margin, not a proportional one', () => {
    // A quarter of 22 minutes is five and a half, which a single advert break
    // would exceed. Short titles get ten minutes of room instead.
    expect(check(30 * 60, 22).verdict).toBe('plausible')
  })

  it('does not accuse over a regional cut of a long film', () => {
    expect(check(150 * 60, 130).verdict).toBe('plausible')
  })
})

describe('what must be caught', () => {
  it('catches an error clip or advert standing in for an episode', () => {
    const result = check(40, 45)
    expect(result.verdict).toBe('implausible')
    expect(result.reason).toMatch(/45 min title/)
  })

  it('catches a feature film served for a half-hour episode', () => {
    expect(check(115 * 60, 22).verdict).toBe('implausible')
  })

  it('catches the substitution shape this was written for', () => {
    // 71.5 minutes delivered where TMDB says 49 — measured on a real provider,
    // and the reason this check exists.
    expect(check(4288.0, 49).verdict).toBe('implausible')
  })

  it('explains itself with both numbers, so a log line can be argued with', () => {
    const result = check(4288.0, 49)
    expect(result.reason).toMatch(/71\.5/)
    expect(result.reason).toMatch(/49/)
  })
})

describe('the boundary', () => {
  it('is generous, and is where the comments say it is', () => {
    // 60-minute title: a quarter is 15, so 46..75 inclusive.
    expect(check(74 * 60, 60).verdict).toBe('plausible')
    expect(check(76 * 60, 60).verdict).toBe('implausible')
  })
})

describe('lengthVerdict', () => {
  it('holds a length to the runtime when there is one', () => {
    expect(lengthVerdict(8_348, 139)).toBe('plausible')
    // Videasy's "One Piece" episode 5: 52 minutes, for a 25-minute anime.
    expect(lengthVerdict(3_133, 25)).toBe('implausible')
  })

  it('refuses anything under ten minutes when there is no runtime', () => {
    // A pre-roll, or an ad served as its own playlist.
    expect(lengthVerdict(30, null)).toBe('implausible')
    expect(lengthVerdict(599, null)).toBe('implausible')
  })

  it('does not vouch for a long length without a runtime, only lets it through', () => {
    expect(lengthVerdict(600, null)).toBe('unknown')
    expect(lengthVerdict(3_133, null)).toBe('unknown')
  })

  it('leaves a length that is no length unknown', () => {
    // A live stream reports Infinity, a video before its metadata NaN.
    expect(lengthVerdict(Infinity, null)).toBe('unknown')
    expect(lengthVerdict(NaN, 25)).toBe('unknown')
  })
})
