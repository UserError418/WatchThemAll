import { describe, expect, it } from 'vitest'
import { logoUrl } from './images'

describe('logoUrl', () => {
  it('asks for every logo as a PNG, including the SVG-only ones', () => {
    expect(logoUrl('/abc.png')).toBe('https://image.tmdb.org/t/p/w500/abc.png')
    expect(logoUrl('/abc.svg')).toBe('https://image.tmdb.org/t/p/w500/abc.png')
    expect(logoUrl('/abc.SVG')).toBe('https://image.tmdb.org/t/p/w500/abc.png')
  })

  it('is null without a logo', () => {
    expect(logoUrl(null)).toBeNull()
  })
})
