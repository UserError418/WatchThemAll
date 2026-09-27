import { describe, expect, it } from 'vitest'
import {
  nudgeTarget,
  parseRememberedDevice,
  preferredDevice,
  progressFraction,
  seekTarget,
  volumePercent,
} from './castremote'

describe('preferredDevice', () => {
  const bedroom = { id: 'a1', name: 'Schlafzimmer', selected: false }
  const lounge = { id: 'b2', name: 'Wohnzimmer', selected: false }

  it('selects the only television there is', () => {
    expect(preferredDevice([bedroom], null)).toBe('a1')
  })

  /** Two rooms and no history: picking one would be a guess. */
  it('selects nothing among several it has never used', () => {
    expect(preferredDevice([bedroom, lounge], null)).toBeNull()
  })

  it('selects the one used last', () => {
    expect(preferredDevice([bedroom, lounge], { id: 'b2', name: 'Wohnzimmer' })).toBe('b2')
  })

  /** The owner's name for it outlives the id the network hands out. */
  it('finds the one used last by name when its id has changed', () => {
    const renumbered = { ...lounge, id: 'c3' }
    expect(preferredDevice([bedroom, renumbered], { id: 'b2', name: 'Wohnzimmer' })).toBe('c3')
  })

  it('falls back to the only one when the one used last is not there', () => {
    expect(preferredDevice([bedroom], { id: 'b2', name: 'Wohnzimmer' })).toBe('a1')
  })

  it('selects nothing before any television is found', () => {
    expect(preferredDevice([], { id: 'b2', name: 'Wohnzimmer' })).toBeNull()
  })
})

describe('parseRememberedDevice', () => {
  it('reads back what was stored', () => {
    expect(parseRememberedDevice('{"id":"a1","name":"Schlafzimmer"}')).toEqual({
      id: 'a1',
      name: 'Schlafzimmer',
    })
  })

  it('answers null for nothing, and for anything malformed', () => {
    expect(parseRememberedDevice(null)).toBeNull()
    expect(parseRememberedDevice('not json')).toBeNull()
    expect(parseRememberedDevice('null')).toBeNull()
    expect(parseRememberedDevice('{"id":7,"name":"x"}')).toBeNull()
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
