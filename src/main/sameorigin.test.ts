import { describe, expect, it } from 'vitest'
import { isSameOrigin } from './sameorigin'

const PROVIDER = 'https://player.videasy.to'

describe('isSameOrigin', () => {
  it('matches the same origin on any path or query', () => {
    expect(isSameOrigin(`${PROVIDER}/`, PROVIDER)).toBe(true)
    expect(isSameOrigin(`${PROVIDER}/api/sources?id=1`, PROVIDER)).toBe(true)
    expect(isSameOrigin(`${PROVIDER}/tv/1396/1/1#t=10`, PROVIDER)).toBe(true)
  })

  it('rejects a host registered under the provider\'s name', () => {
    // The bug this module exists for: an origin has no trailing delimiter, so
    // `startsWith` treated every one of these as the provider's own.
    expect(isSameOrigin('https://player.videasy.to.evil.example/collect', PROVIDER)).toBe(false)
    expect(isSameOrigin('https://player.videasy.tokyo/x', PROVIDER)).toBe(false)
    expect(isSameOrigin('https://player.videasy.to-cdn.net/x', PROVIDER)).toBe(false)
  })

  it('rejects a different scheme, port or subdomain', () => {
    expect(isSameOrigin('http://player.videasy.to/x', PROVIDER)).toBe(false)
    expect(isSameOrigin('https://player.videasy.to:8443/x', PROVIDER)).toBe(false)
    expect(isSameOrigin('https://cdn.player.videasy.to/x', PROVIDER)).toBe(false)
  })

  it('normalises what URL parsing normalises', () => {
    // The default port and a trailing slash on the origin are the same origin,
    // and a hand-rolled comparison is where that stops being true.
    expect(isSameOrigin(`${PROVIDER}:443/x`, PROVIDER)).toBe(true)
    expect(isSameOrigin(`${PROVIDER}/x`, `${PROVIDER}/`)).toBe(true)
    expect(isSameOrigin('https://PLAYER.VIDEASY.TO/x', PROVIDER)).toBe(true)
  })

  it('never matches when either side is missing or malformed', () => {
    expect(isSameOrigin(`${PROVIDER}/x`, null)).toBe(false)
    expect(isSameOrigin('not a url', PROVIDER)).toBe(false)
    expect(isSameOrigin(`${PROVIDER}/x`, 'not a url')).toBe(false)
    expect(isSameOrigin('', PROVIDER)).toBe(false)
  })
})
