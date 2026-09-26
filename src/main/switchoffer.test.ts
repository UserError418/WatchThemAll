/**
 * When a failed request should, and should not, cost the user their provider.
 *
 * Every case here is one the app got wrong in front of somebody. The awkward
 * ones cannot be produced on demand — you cannot ask a third party to
 * rate-limit you at a chosen moment — which is exactly why the decision was
 * pulled out of the request handler and into something callable.
 */

import { describe, expect, it } from 'vitest'
import {
  PAGE_IDLE_MS,
  isProviderFailure,
  judgeSilence,
  mayAutoSwitch,
  streamResolved,
  type LoadEvidence,
  type PageActivity,
  type RequestVerdictInput,
} from './switchoffer'

const ORIGIN = 'https://player.videasy.to'

function request(over: Partial<RequestVerdictInput> = {}): RequestVerdictInput {
  return {
    statusCode: 500,
    resourceType: 'xhr',
    url: `${ORIGIN}/api/sources`,
    providerOrigin: ORIGIN,
    playing: false,
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

describe('whether a source that is not playing has found its stream', () => {
  const nothing: LoadEvidence = { playlistOk: false, videoOk: false, refusedStatus: null, videoElement: false }

  it('has not, when nothing arrived at all — the silence offer is right', () => {
    expect(streamResolved(nothing)).toBe(false)
  })

  it('has, once video arrived, even with nothing playing (waiting for its play button)', () => {
    expect(streamResolved({ ...nothing, videoOk: true })).toBe(true)
  })

  it('has, with a playlist loaded and nothing refused', () => {
    expect(streamResolved({ ...nothing, playlistOk: true })).toBe(true)
  })

  it('has, when a <video> with a duration is sitting there paused', () => {
    expect(streamResolved({ ...nothing, videoElement: true })).toBe(true)
  })

  it('has not, when its segments were refused — Videasy on Game of Thrones', () => {
    // Playlist loaded, element built with a duration, every segment 403.
    expect(streamResolved({ playlistOk: true, videoOk: false, refusedStatus: 403, videoElement: true })).toBe(false)
  })

  it('has, when some video arrived despite a refused segment', () => {
    expect(streamResolved({ playlistOk: true, videoOk: true, refusedStatus: 403, videoElement: true })).toBe(true)
  })
})

describe('what nothing having played means at the deadline', () => {
  const nothing: LoadEvidence = { playlistOk: false, videoOk: false, refusedStatus: null, videoElement: false }
  const idle = (idleForMs: number, pendingRequests = 0): PageActivity => ({ idleForMs, pendingRequests })

  it('is waiting when the page went idle with nothing wrong — VidSrc on its poster', () => {
    // Last request 1.2 s after opening, nothing for the next nineteen, no
    // <video> in any frame until the poster is clicked.
    expect(judgeSilence(nothing, false, idle(23_000))).toBe('waiting')
  })

  it('is loading when the page is still busy at the deadline — CinemaOS collecting streams', () => {
    expect(judgeSilence(nothing, false, idle(800))).toBe('loading')
  })

  it('is loading while a request is unanswered, however long since one finished — CinemaOS on "Fetching Prism"', () => {
    expect(judgeSilence(nothing, false, idle(19_000, 1))).toBe('loading')
  })

  it('is failing when the backend said it could not, however quiet the page is since — VidFast', () => {
    expect(judgeSilence(nothing, true, idle(20_000))).toBe('failing')
  })

  it('is failing when a segment was refused', () => {
    expect(judgeSilence({ ...nothing, playlistOk: true, refusedStatus: 403 }, false, idle(20_000))).toBe('failing')
  })

  it('is resolved when the stream is there, busy or not, and whatever failed on the way', () => {
    expect(judgeSilence({ ...nothing, playlistOk: true }, false, idle(0, 3))).toBe('resolved')
    expect(judgeSilence({ ...nothing, videoOk: true }, true, idle(0))).toBe('resolved')
  })

  it('draws the idle line at PAGE_IDLE_MS', () => {
    expect(judgeSilence(nothing, false, idle(PAGE_IDLE_MS - 1))).toBe('loading')
    expect(judgeSilence(nothing, false, idle(PAGE_IDLE_MS))).toBe('waiting')
  })
})

describe('whether an offer may switch by itself', () => {
  it('counts down for silence and for a failed page, on an untested source', () => {
    expect(mayAutoSwitch('silence', false)).toBe(true)
    expect(mayAutoSwitch('failure', false)).toBe(true)
  })

  it('never counts down for a stall — the user may simply have paused', () => {
    expect(mayAutoSwitch('stall', false)).toBe(false)
  })

  it('never counts down away from a source the tests found working', () => {
    expect(mayAutoSwitch('silence', true)).toBe(false)
    expect(mayAutoSwitch('failure', true)).toBe(false)
    expect(mayAutoSwitch('stall', true)).toBe(false)
  })
})
