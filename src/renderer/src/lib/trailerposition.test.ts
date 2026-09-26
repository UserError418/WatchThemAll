import { describe, expect, it } from 'vitest'
import { RESUME_WINDOW_MS, TrailerPositions, positionNow, startParameter } from './trailerposition'

/**
 * The resume cache behind trailer previews.
 *
 * The failure modes are all quiet: a trailer that restarts from zero looks
 * like "the feature does nothing", and one that resumes from a stale position
 * minutes later looks like a glitch. The clock is injected so the one-minute
 * window can be walked across without waiting for it.
 */

function withClock(start = 1_000_000): { positions: TrailerPositions; advance: (ms: number) => void } {
  let now = start
  return {
    positions: new TrailerPositions(RESUME_WINDOW_MS, () => now),
    advance: (ms) => {
      now += ms
    },
  }
}

describe('remembering where a trailer was left', () => {
  it('knows nothing about a video it has never seen, so it starts from the top', () => {
    const { positions } = withClock()
    expect(positions.lookup('abc')).toBeNull()
  })

  it('returns the recorded position to the next preview of the same video', () => {
    const { positions, advance } = withClock()
    positions.record('abc', 12.4)
    advance(5_000)
    expect(positions.lookup('abc')).toBe(12.4)
  })

  it('keeps videos apart, so one trailer never resumes from another', () => {
    const { positions } = withClock()
    positions.record('abc', 12)
    positions.record('xyz', 40)
    expect(positions.lookup('abc')).toBe(12)
    expect(positions.lookup('xyz')).toBe(40)
  })

  it('takes the newest report, which is what a still-playing preview sends', () => {
    const { positions, advance } = withClock()
    positions.record('abc', 3)
    advance(250)
    positions.record('abc', 3.25)
    expect(positions.lookup('abc')).toBe(3.25)
  })

  it('ignores reports that are not a position', () => {
    const { positions } = withClock()
    positions.record('abc', 8)
    positions.record('abc', Number.NaN)
    positions.record('abc', -1)
    expect(positions.lookup('abc')).toBe(8)
  })
})

describe('the one-minute window', () => {
  it('still resumes right at the edge of the window', () => {
    const { positions, advance } = withClock()
    positions.record('abc', 30)
    advance(RESUME_WINDOW_MS)
    expect(positions.lookup('abc')).toBe(30)
  })

  it('forgets the position once the window has passed, so the trailer plays from 0 again', () => {
    const { positions, advance } = withClock()
    positions.record('abc', 30)
    advance(RESUME_WINDOW_MS + 1)
    expect(positions.lookup('abc')).toBeNull()
  })

  it('stays forgotten rather than coming back on a later lookup', () => {
    const { positions, advance } = withClock()
    positions.record('abc', 30)
    advance(RESUME_WINDOW_MS + 1)
    positions.lookup('abc')
    expect(positions.lookup('abc')).toBeNull()
  })

  it('runs the window from the last report, not the first', () => {
    // A preview that played for two minutes was *left* just now; its position
    // must not expire because playback began long ago.
    const { positions, advance } = withClock()
    positions.record('abc', 0)
    advance(RESUME_WINDOW_MS - 1)
    positions.record('abc', 59)
    advance(RESUME_WINDOW_MS - 1)
    expect(positions.lookup('abc')).toBe(59)
  })

  it('expires one video without touching another that was left more recently', () => {
    const { positions, advance } = withClock()
    positions.record('old', 10)
    advance(RESUME_WINDOW_MS / 2)
    positions.record('new', 20)
    advance(RESUME_WINDOW_MS / 2 + 1)
    expect(positions.lookup('old')).toBeNull()
    expect(positions.lookup('new')).toBe(20)
  })
})

describe('positionNow', () => {
  it('adds the time since the last report while the video was playing', () => {
    expect(positionNow({ seconds: 10, at: 1_000 }, true, 1_250)).toBeCloseTo(10.25)
  })

  it('does not move a paused or buffering video', () => {
    expect(positionNow({ seconds: 10, at: 1_000 }, false, 1_250)).toBe(10)
  })

  it('never goes backwards if the clock reads earlier than the report', () => {
    expect(positionNow({ seconds: 10, at: 1_000 }, true, 900)).toBe(10)
  })
})

describe('startParameter', () => {
  it('starts from the top when nothing is remembered', () => {
    expect(startParameter(null)).toBeNull()
  })

  it('rounds to whole seconds, the only form YouTube accepts', () => {
    expect(startParameter(37.4)).toBe(37)
    expect(startParameter(37.6)).toBe(38)
  })

  it('treats a position under half a second as the top, so no parameter is sent', () => {
    expect(startParameter(0.3)).toBeNull()
    expect(startParameter(0)).toBeNull()
  })
})
