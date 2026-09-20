import { describe, expect, it } from 'vitest'
import {
  nextEpisode,
  nudgeTarget,
  previousEpisode,
  progressFraction,
  seekTarget,
  volumePercent,
} from './castremote'

describe('nextEpisode', () => {
  it('steps forward within the season', () => {
    expect(nextEpisode({ season: 2, episode: 22 }, 24)).toEqual({ season: 2, episode: 23 })
  })

  it('rolls into the next season at the end of this one', () => {
    expect(nextEpisode({ season: 2, episode: 24 }, 24)).toEqual({ season: 3, episode: 1 })
  })

  /**
   * The episode list is loaded asynchronously and may not have arrived. Without
   * it there is no way to know the season has ended, and refusing to advance
   * would strand the user on the last episode they happened to be able to see.
   */
  it('keeps counting when the season length is not known yet', () => {
    expect(nextEpisode({ season: 2, episode: 99 }, 0)).toEqual({ season: 2, episode: 100 })
  })

  it('has nowhere to go for something with no episode', () => {
    expect(nextEpisode(null)).toBeNull()
  })
})

describe('previousEpisode', () => {
  it('steps back within the season', () => {
    expect(previousEpisode({ season: 2, episode: 22 })).toEqual({ season: 2, episode: 21 })
  })

  /**
   * Episode 1 of the earlier season, not its last: the length of a season we
   * are not in is not known without fetching it, and being wrong by a known
   * amount beats being wrong by a guessed one. Matches the player's own
   * keyboard shortcut rather than inventing a second rule.
   */
  it('steps back across a season boundary to episode 1', () => {
    expect(previousEpisode({ season: 3, episode: 1 })).toEqual({ season: 2, episode: 1 })
  })

  it('stops at the very beginning', () => {
    expect(previousEpisode({ season: 1, episode: 1 })).toBeNull()
  })

  it('has nowhere to go for something with no episode', () => {
    expect(previousEpisode(null)).toBeNull()
  })
})

describe('progressFraction', () => {
  it('reports how far through', () => {
    expect(progressFraction(30, 120)).toBe(0.25)
  })

  /** A receiver reports duration 0 until it has parsed the stream. */
  it('is zero rather than infinite when the duration is unknown', () => {
    expect(progressFraction(30, 0)).toBe(0)
    expect(progressFraction(30, Number.NaN)).toBe(0)
  })

  it('never leaves the bar', () => {
    expect(progressFraction(-5, 120)).toBe(0)
    expect(progressFraction(500, 120)).toBe(1)
  })
})

describe('volumePercent', () => {
  it('reads a level as a whole percentage', () => {
    expect(volumePercent(0.62)).toBe(62)
    expect(volumePercent(0)).toBe(0)
    expect(volumePercent(1)).toBe(100)
  })

  it('refuses to report more than all of it', () => {
    expect(volumePercent(1.4)).toBe(100)
    expect(volumePercent(-1)).toBe(0)
    expect(volumePercent(Number.NaN)).toBe(0)
  })
})

describe('seekTarget', () => {
  it('turns a dragged fraction into whole seconds', () => {
    expect(seekTarget(0.5, 3600)).toBe(1800)
  })

  /** Some receivers answer a seek past the end by stopping. */
  it('stops short of the very end', () => {
    expect(seekTarget(1, 3600)).toBe(3599)
  })

  it('has nowhere to seek in a stream of unknown length', () => {
    expect(seekTarget(0.5, 0)).toBe(0)
  })
})

describe('nudgeTarget', () => {
  it('moves by the step', () => {
    expect(nudgeTarget(100, 30, 3600)).toBe(130)
    expect(nudgeTarget(100, -30, 3600)).toBe(70)
  })

  it('does not go back past the start', () => {
    expect(nudgeTarget(10, -30, 3600)).toBe(0)
  })

  it('does not run off the end', () => {
    expect(nudgeTarget(3590, 30, 3600)).toBe(3599)
  })

  /** Before the receiver reports a duration, forward is still meaningful. */
  it('still moves when the duration is unknown', () => {
    expect(nudgeTarget(100, 30, 0)).toBe(130)
  })
})
