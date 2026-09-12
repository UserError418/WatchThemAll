/**
 * The cases a real CDN outage would take weeks to produce on demand.
 *
 * Weighted towards the false positives, because those are the expensive
 * mistake: a wrongly-raised stall pulls somebody out of a working episode,
 * while a missed one costs the seconds until they reach for the mouse
 * themselves.
 */

import { describe, expect, it } from 'vitest'

import {
  STALL_GRACE_MS,
  beginStallWatch,
  frozenSeconds,
  observeStall,
  type StallReading,
  type StallWatch,
} from './playbackstall'

const playing = (seconds: number): StallReading => ({ seconds, ended: false, paused: false })

/** Fold a series of readings four seconds apart and collect the verdicts. */
function run(
  readings: (StallReading | null)[],
  startAt = 0,
  stepMs = 4_000,
): { stalls: number[]; watch: StallWatch } {
  let watch = beginStallWatch(startAt)
  const stalls: number[] = []
  readings.forEach((reading, index) => {
    const now = startAt + (index + 1) * stepMs
    const observation = observeStall(watch, reading, now)
    watch = observation.watch
    if (observation.stalled) stalls.push(now)
  })
  return { stalls, watch }
}

describe('playback that is fine', () => {
  it('never complains while the position advances', () => {
    const { stalls } = run([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40].map(playing))
    expect(stalls).toEqual([])
  })

  it('leaves a paused video alone however long it is paused', () => {
    // Somebody answering the door for ten minutes is not a broken provider.
    const paused = { seconds: 120, ended: false, paused: true }
    const { stalls } = run(Array.from({ length: 150 }, () => paused))
    expect(stalls).toEqual([])
  })

  it('does not raise a stall at the end of the title', () => {
    // A finished film reports the same `currentTime` forever. Offering to
    // change provider at the closing credits would be absurd.
    const ended = { seconds: 5_400, ended: true, paused: false }
    const { stalls } = run(Array.from({ length: 40 }, () => ended))
    expect(stalls).toEqual([])
  })

  it('resumes cleanly from a long pause rather than firing immediately', () => {
    // The clock must be reset by the pause, not merely ignored during it —
    // otherwise the first poll after resuming is already past the grace period.
    const pausedFor = Array.from({ length: 100 }, () => ({
      seconds: 60,
      ended: false,
      paused: true,
    }))
    const { stalls } = run([...pausedFor, playing(60), playing(64), playing(68)])
    expect(stalls).toEqual([])
  })

  it('tolerates a buffer that is long by human standards but not by these hosts', () => {
    // Six polls frozen — twenty-four seconds — then it recovers. Common
    // enough on these embeds that firing here would make the prompt noise.
    const { stalls } = run([
      playing(30),
      playing(30),
      playing(30),
      playing(30),
      playing(30),
      playing(30),
      playing(34),
      playing(38),
    ])
    expect(stalls).toEqual([])
  })
})

describe('playback that has actually died', () => {
  it('raises once the freeze outlasts the grace period', () => {
    const frozen = Array.from({ length: 12 }, () => playing(300))
    const { stalls } = run([playing(296), ...frozen])
    expect(stalls).toHaveLength(1)
    // The last reading that *moved* is the second one, 8s in: it is frozen
    // relative to the ones after it but still an advance on the 296 before it.
    // The verdict then lands on the first poll at or after the grace period —
    // it can only be noticed when somebody looks.
    const deadline = 8_000 + STALL_GRACE_MS
    expect(stalls[0]).toBe(Math.ceil(deadline / 4_000) * 4_000)
  })

  it('raises only once, not on every poll for the rest of the film', () => {
    const { stalls } = run(Array.from({ length: 200 }, () => playing(300)))
    expect(stalls).toHaveLength(1)
  })

  it('treats the video vanishing as a freeze, not as no evidence', () => {
    // What a torn-down player or a killed renderer looks like from the poll:
    // readings were arriving, and then there is no video in any frame at all.
    const { stalls } = run([playing(100), playing(104), ...Array(12).fill(null)])
    expect(stalls).toHaveLength(1)
  })

  it('arms again after a recovery, so a second death is also caught', () => {
    const frozen = Array.from({ length: 10 }, () => playing(300))
    const { stalls } = run([
      playing(296),
      ...frozen,
      playing(304),
      playing(308),
      ...Array.from({ length: 10 }, () => playing(308)),
    ])
    expect(stalls).toHaveLength(2)
  })

  it('is not fooled by microsecond jitter in a frozen currentTime', () => {
    // Some players keep nudging `currentTime` by a rounding error while
    // stalled. An exact comparison would read that as progress forever.
    const jittering = Array.from({ length: 12 }, (_, i) => playing(300 + i * 0.0001))
    const { stalls } = run(jittering)
    expect(stalls).toHaveLength(1)
  })
})

describe('the message', () => {
  it('reports how long it has been frozen, in whole seconds', () => {
    const watch = beginStallWatch(1_000)
    expect(frozenSeconds(watch, 1_000 + 31_400)).toBe(31)
  })
})
