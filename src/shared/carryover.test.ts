import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  CARRY_GIVE_UP_MS,
  CARRY_MAX_SEEKS,
  CARRY_SEEK_LEAD_S,
  CARRY_SEEK_SETTLE_MS,
  CARRY_TOLERANCE_S,
  CarryOver,
  type HeldFilm,
} from './carryover'

const T0 = 1_800_000_000_000
const film = (seconds: number, patch: Partial<HeldFilm> = {}): HeldFilm => ({
  seconds,
  duration: 2_700,
  playing: true,
  ...patch,
})

describe('CarryOver', () => {
  it('waits while the held player has no film, an advert, or a film not yet moving', () => {
    const carry = new CarryOver(T0)
    carry.update({ seconds: 600, paused: false, muted: false, at: T0 })
    expect(carry.step(null, T0 + 1_000)).toEqual({ kind: 'wait' })
    expect(carry.step(film(5, { duration: 30 }), T0 + 1_000)).toEqual({ kind: 'wait' })
    expect(carry.step(film(600, { playing: false }), T0 + 1_000)).toEqual({ kind: 'wait' })
  })

  it("moves the film to the preview's second as it is now, a little ahead, then lets the player be seen", () => {
    const carry = new CarryOver(T0)
    carry.update({ seconds: 600, paused: false, muted: false, at: T0 })
    // Four seconds later the preview is at 604; the film started at the kept 600.
    expect(carry.step(film(601), T0 + 4_000)).toEqual({ kind: 'seek', to: 604 + CARRY_SEEK_LEAD_S })
    // The seek has not landed yet.
    expect(carry.step(film(601.5), T0 + 4_500)).toEqual({ kind: 'wait' })
    // Landed, within a second of the preview, but not yet seen moving: it may still be buffering.
    expect(carry.step(film(605.8), T0 + 5_600)).toEqual({ kind: 'wait' })
    // A second later it has moved on by a second: playing, so it is shown.
    expect(carry.step(film(606.8), T0 + 6_600)).toEqual({ kind: 'release', why: 'at-place' })
    expect(carry.done).toBe(true)
  })

  it('waits while the film says it is buffering, and starts watching it move again afterwards', () => {
    const carry = new CarryOver(T0)
    carry.update({ seconds: 600, paused: false, muted: false, at: T0 })
    expect(carry.step(film(600.1, { waiting: true }), T0 + 100)).toEqual({ kind: 'wait' })
    expect(carry.step(film(600.1), T0 + 200)).toEqual({ kind: 'wait' })
    expect(carry.step(film(601.1), T0 + 1_200)).toEqual({ kind: 'release', why: 'at-place' })
  })

  it('aims at the frame a stalled preview is showing, not where it would be by now', () => {
    const carry = new CarryOver(T0)
    carry.update({ seconds: 600, paused: false, muted: false, stalled: true, at: T0 })
    expect(carry.target(T0 + 4_000)).toBe(600)
    expect(carry.step(film(610), T0 + 4_000)).toEqual({ kind: 'seek', to: 600 })
    // Moving again: projected on from its next report.
    carry.update({ seconds: 600.5, paused: false, muted: false, stalled: false, at: T0 + 5_000 })
    expect(carry.target(T0 + 6_000)).toBeCloseTo(601.5)
  })

  it('does not lead a paused preview: the film waits at its second', () => {
    const carry = new CarryOver(T0)
    carry.update({ seconds: 600, paused: true, muted: false, at: T0 })
    expect(carry.step(film(610), T0 + 9_000)).toEqual({ kind: 'seek', to: 600 })
    expect(carry.target(T0 + 60_000)).toBe(600)
  })

  it('shows the player wherever its film is after a few seeks that did not take', () => {
    const carry = new CarryOver(T0)
    carry.update({ seconds: 600, paused: false, muted: false, at: T0 })
    let now = T0 + 1_000
    for (let i = 0; i < CARRY_MAX_SEEKS; i++) {
      expect(carry.step(film(0 + i), now).kind).toBe('seek')
      now += CARRY_SEEK_SETTLE_MS
    }
    expect(carry.step(film(3), now)).toEqual({ kind: 'release', why: 'seeks-spent' })
  })

  it('stops standing in after the give-up time, whatever the film is doing', () => {
    const carry = new CarryOver(T0)
    carry.update({ seconds: 600, paused: false, muted: false, at: T0 })
    expect(carry.step(null, T0 + CARRY_GIVE_UP_MS)).toEqual({ kind: 'release', why: 'timed-out' })
  })

  it('lets the player be seen as soon as its film plays when the preview never said where it was', () => {
    const carry = new CarryOver(T0)
    expect(carry.step(film(12), T0 + 3_000)).toEqual({ kind: 'wait' })
    expect(carry.step(film(12.5), T0 + 3_500)).toEqual({ kind: 'release', why: 'playing' })
  })

  it('releases at most once, and keeps saying so', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ seconds: fc.double({ min: 0, max: 3_000, noNaN: true }), dt: fc.integer({ min: 0, max: 3_000 }) }), {
          maxLength: 40,
        }),
        (steps) => {
          const carry = new CarryOver(T0)
          carry.update({ seconds: 600, paused: false, muted: false, at: T0 })
          let now = T0
          let seeks = 0
          let released = false
          for (const step of steps) {
            now += step.dt
            const move = carry.step(film(step.seconds), now)
            if (released) {
              expect(move.kind).toBe('release')
              continue
            }
            if (move.kind === 'seek') seeks += 1
            if (move.kind === 'release') {
              released = true
              // Never shown far from the preview unless it had to be: seeks spent, or out of time.
              const hadTo = seeks >= CARRY_MAX_SEEKS || now - T0 >= CARRY_GIVE_UP_MS
              if (!hadTo) expect(Math.abs(step.seconds - carry.target(now)!)).toBeLessThanOrEqual(CARRY_TOLERANCE_S)
            }
          }
          expect(seeks).toBeLessThanOrEqual(CARRY_MAX_SEEKS)
        },
      ),
      { numRuns: 200 },
    )
  })
})
