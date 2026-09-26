/**
 * A source test only ever asks for something that has come out.
 */

import { describe, expect, it } from 'vitest'
import { airedEpisode, notOutYet } from './aired'

const NOW = Date.parse('2026-09-26T12:00:00Z')

describe('airedEpisode', () => {
  const lastAired = { season: 2, episode: 12 }

  it('moves a test past the latest episode back onto it', () => {
    // The reported case: the latest season finished, so "where the user is" is
    // the first episode of one still to come.
    expect(airedEpisode({ season: 3, episode: 1 }, lastAired)).toEqual({ season: 2, episode: 12 })
    expect(airedEpisode({ season: 2, episode: 13 }, lastAired)).toEqual({ season: 2, episode: 12 })
  })

  it('leaves an aired episode alone, including the latest itself', () => {
    expect(airedEpisode({ season: 1, episode: 7 }, lastAired)).toEqual({ season: 1, episode: 7 })
    expect(airedEpisode({ season: 2, episode: 12 }, lastAired)).toEqual({ season: 2, episode: 12 })
  })

  it('leaves the episode alone when there is nothing to go by', () => {
    expect(airedEpisode({ season: 3, episode: 1 }, null)).toEqual({ season: 3, episode: 1 })
    expect(airedEpisode({ season: 3, episode: 1 }, undefined)).toEqual({ season: 3, episode: 1 })
  })

  it('does not move a test onto a special', () => {
    expect(airedEpisode({ season: 3, episode: 1 }, { season: 0, episode: 4 })).toEqual({ season: 3, episode: 1 })
  })
})

describe('notOutYet', () => {
  it('holds back a title whose date is still to come', () => {
    expect(notOutYet('2026-10-20', NOW)).toBe(true)
  })

  it('lets through a title that is out, including one out today', () => {
    expect(notOutYet('1999-10-15', NOW)).toBe(false)
    expect(notOutYet('2026-09-26', NOW)).toBe(false)
  })

  it('does not treat an unknown date as a future one', () => {
    expect(notOutYet(null, NOW)).toBe(false)
    expect(notOutYet('', NOW)).toBe(false)
    expect(notOutYet('not a date', NOW)).toBe(false)
  })
})
