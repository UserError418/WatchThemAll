/**
 * When a failed request should, and should not, cost the user their provider.
 *
 * Every case here is one the app got wrong in front of somebody. The awkward
 * ones cannot be produced on demand — you cannot ask a third party to
 * rate-limit you at a chosen moment — which is exactly why the decision was
 * pulled out of the request handler and into something callable.
 */

import { describe, expect, it } from 'vitest'
import { isProviderFailure, type RequestVerdictInput } from './switchoffer'

const ORIGIN = 'https://player.videasy.to'

function request(over: Partial<RequestVerdictInput> = {}): RequestVerdictInput {
  return {
    statusCode: 500,
    resourceType: 'xhr',
    url: `${ORIGIN}/api/sources`,
    providerOrigin: ORIGIN,
    playing: false,
    offerPending: false,
    ...over,
  }
}

describe('what counts as the source failing', () => {
  it('a failed call to the provider\'s own API, before anything plays', () => {
    expect(isProviderFailure(request())).toBe(true)
  })

  it('the provider\'s own document answering 403', () => {
    // The case that made Videasy look dead: it is served in a frame, so its
    // status arrives as a subFrame response rather than through `did-navigate`.
    expect(isProviderFailure(request({ statusCode: 403, resourceType: 'subFrame' }))).toBe(true)
  })

  it('not a success', () => {
    expect(isProviderFailure(request({ statusCode: 204 }))).toBe(false)
  })
})

describe('rate limiting is not breakage', () => {
  it('ignores 429 on the provider\'s own API', () => {
    // Videasy throttles its own `/api/stats/hit` beacon per address. Switching
    // provider over that takes a working video away to fix nothing.
    expect(isProviderFailure(request({ statusCode: 429, url: `${ORIGIN}/api/stats/hit` }))).toBe(
      false,
    )
  })

  it('ignores 429 even on the document itself', () => {
    expect(isProviderFailure(request({ statusCode: 429, resourceType: 'subFrame' }))).toBe(false)
  })

  it('still reports the statuses either side of it', () => {
    // A guard written as `>= 429` or `<= 429` would swallow real failures.
    expect(isProviderFailure(request({ statusCode: 428 }))).toBe(true)
    expect(isProviderFailure(request({ statusCode: 430 }))).toBe(true)
  })
})

describe('once the video is playing', () => {
  it('ignores a failure of any kind', () => {
    // These pages keep making background calls for the whole episode. One of
    // them failing thirty minutes in put a five-second countdown to change
    // provider over a perfectly good stream.
    expect(isProviderFailure(request({ statusCode: 500, playing: true }))).toBe(false)
    expect(isProviderFailure(request({ statusCode: 403, resourceType: 'subFrame', playing: true }))).toBe(
      false,
    )
  })
})

describe('what is not evidence about this provider', () => {
  it('a third party failing', () => {
    expect(isProviderFailure(request({ url: 'https://ads.example.com/track' }))).toBe(false)
  })

  it('an image or a script, rather than an API call or the document', () => {
    // Providers routinely 404 an artwork variant. It says nothing about the
    // stream, and treating it as a failure made every provider look broken.
    expect(isProviderFailure(request({ resourceType: 'image' }))).toBe(false)
    expect(isProviderFailure(request({ resourceType: 'script' }))).toBe(false)
    expect(isProviderFailure(request({ resourceType: 'stylesheet' }))).toBe(false)
  })

  it('anything at all when there is no provider to blame', () => {
    expect(isProviderFailure(request({ providerOrigin: null }))).toBe(false)
  })

  it('a second failure while an offer is already counting down', () => {
    expect(isProviderFailure(request({ offerPending: true }))).toBe(false)
  })
})

describe('origin matching', () => {
  it('does not mistake a lookalike host for the provider', () => {
    // `startsWith` on an origin is safe; on a bare hostname it would not be.
    expect(
      isProviderFailure(request({ url: 'https://player.videasy.to.evil.example/api' })),
    ).toBe(false)
  })

  it('matches the provider on any path', () => {
    expect(isProviderFailure(request({ url: `${ORIGIN}/deep/nested/call?x=1` }))).toBe(true)
  })
})
