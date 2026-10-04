import { describe, expect, it } from 'vitest'
import { canPlay } from './detailplay'

describe('canPlay', () => {
  it('plays a title TMDB does not carry, from its IMDB id', () => {
    expect(canPlay({ detailLoaded: false, degraded: true })).toBe(true)
  })

  it('plays once TMDB has answered', () => {
    expect(canPlay({ detailLoaded: true, degraded: false })).toBe(true)
  })

  it('waits while TMDB is still being asked', () => {
    expect(canPlay({ detailLoaded: false, degraded: false })).toBe(false)
  })
})
