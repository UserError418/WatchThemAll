/**
 * Verdicts and reasons from a probe's observations.
 *
 * Each case below is a provider measured on 2026-09-26, reduced to the fields
 * that decided it. The expensive mistake is a false red — a working source the
 * user stops trying — so most cases pin what must *not* be red.
 */

import { describe, expect, it } from 'vitest'
import type { StreamProbeResult } from './streamprobe'
import { classify, streamReason } from './streamverdict'

function observed(over: Partial<StreamProbeResult> = {}): StreamProbeResult {
  return {
    providerId: 'p',
    providerName: 'P',
    url: 'https://p.test/embed',
    verdict: 'no-media',
    documentStatus: 200,
    redirectedTo: null,
    timeToMediaMs: null,
    requestCount: 40,
    mediaSamples: [],
    videoArrived: false,
    refusedSegments: [],
    stillLoading: false,
    apiErrors: [],
    error: null,
    ...over,
  }
}

describe('classify', () => {
  it('calls video that arrived a stream, whatever else failed alongside it', () => {
    // VidLux on Fight Club: two extractors 404/500 first, then plays.
    const result = observed({
      videoArrived: true,
      apiErrors: [{ url: 'https://vidlux.xyz/api/extract/spider', status: 500 }],
      refusedSegments: [503],
    })
    expect(classify(result, '')).toBe('stream')
  })

  it('does not call a playlist alone a stream — Videasy on Game of Thrones', () => {
    const result = observed({ mediaSamples: ['https://cdn.test/index.m3u8'], refusedSegments: [403, 403] })
    expect(classify(result, '')).toBe('refused')
  })

  it('calls a page still busy at the deadline a timeout — CinemaOS', () => {
    expect(classify(observed({ stillLoading: true, requestCount: 170 }), '')).toBe('timeout')
  })

  it('prefers timeout to a backend error while the page is still trying its next source', () => {
    const result = observed({
      stillLoading: true,
      apiErrors: [{ url: 'https://vidlux.xyz/api/extract/vidfast', status: 404 }],
    })
    expect(classify(result, '')).toBe('timeout')
  })

  it('calls a backend error on a page that fell silent an api error — VidFast', () => {
    const result = observed({ apiErrors: [{ url: 'https://vidfast.vc/x', status: 500 }], requestCount: 38 })
    expect(classify(result, '')).toBe('api-error')
  })

  it('recognises a challenge page by its title', () => {
    expect(classify(observed(), 'Just a moment...')).toBe('blocked')
  })

  it('tells a shell with nothing behind it from a page that found nothing', () => {
    expect(classify(observed({ requestCount: 2 }), '')).toBe('empty')
    expect(classify(observed({ requestCount: 40 }), '')).toBe('no-media')
  })
})

describe('streamReason', () => {
  const reasonFor = (over: Partial<StreamProbeResult>, timeoutMs = 20_000) => {
    const result = observed(over)
    return streamReason({ ...result, verdict: classify(result, '') }, timeoutMs)
  }

  it('has nothing to explain for a stream', () => {
    expect(reasonFor({ videoArrived: true })).toBeNull()
  })

  it('reports a refused segment by its status', () => {
    expect(reasonFor({ refusedSegments: [403] })).toEqual({ kind: 'refused', status: 403 })
  })

  it("calls a segment server's 5xx an error, not a refusal — VidSrc PM's 503 bursts", () => {
    expect(reasonFor({ refusedSegments: [503, 503, 503] })).toEqual({ kind: 'error', status: 503 })
  })

  it('names a refusal over a server error when both happened', () => {
    expect(reasonFor({ refusedSegments: [503, 403] })).toEqual({ kind: 'refused', status: 403 })
  })

  it('reports the budget a timeout ran out of, in whole seconds', () => {
    expect(reasonFor({ stillLoading: true }, 25_000)).toEqual({ kind: 'timeout', seconds: 25 })
  })

  it('names a server error over a client one when the backend failed several ways', () => {
    const apiErrors = [
      { url: 'https://vidlux.xyz/api/extract/vidstuck', status: 404 },
      { url: 'https://vidlux.xyz/api/extract/spider', status: 500 },
    ]
    expect(reasonFor({ apiErrors })).toEqual({ kind: 'error', status: 500 })
  })

  it('reports a document that answered 5xx as an error with its status, not as unreachable', () => {
    expect(reasonFor({ documentStatus: 502 })).toEqual({ kind: 'error', status: 502 })
    expect(reasonFor({ documentStatus: null, error: '-105 ERR_NAME_NOT_RESOLVED' })).toEqual({ kind: 'unreachable' })
  })
})
