/**
 * The phone's reasons for a provider that did not stream.
 *
 * Each case is a behaviour measured on the emulator or the desktop, reduced to
 * what decided it. The costly mistake is a red on a provider that works, so
 * the cases that must *not* read as a plain failure come first.
 */

import { describe, expect, it } from 'vitest'
import { isScanCandidate, judgeMissedStream, missedStreamReason, STILL_LOADING_WINDOW_MS } from './scanjudge'

const END = 1_000_000

describe('missedStreamReason', () => {
  it('calls a page still making requests at the deadline a timeout, in whole seconds — CinemaOS', () => {
    const reason = missedStreamReason({ documentError: null, lastRequestAtMs: END - 800, endedAtMs: END, budgetMs: 20_000 })
    expect(reason).toEqual({ kind: 'timeout', seconds: 20 })
  })

  it('calls a page that went quiet with nothing to show "no stream"', () => {
    const reason = missedStreamReason({ documentError: null, lastRequestAtMs: END - 12_000, endedAtMs: END, budgetMs: 20_000 })
    expect(reason).toEqual({ kind: 'no-stream' })
  })

  it('draws the still-loading line where the desktop does', () => {
    const at = (gap: number) =>
      missedStreamReason({ documentError: null, lastRequestAtMs: END - gap, endedAtMs: END, budgetMs: 25_000 }).kind
    expect(at(STILL_LOADING_WINDOW_MS - 1)).toBe('timeout')
    expect(at(STILL_LOADING_WINDOW_MS)).toBe('no-stream')
  })

  it('calls a page that made no request at all "no stream"', () => {
    expect(missedStreamReason({ documentError: null, lastRequestAtMs: null, endedAtMs: END, budgetMs: 20_000 })).toEqual({
      kind: 'no-stream',
    })
  })

  it('names the status of a document the server failed — VidFast', () => {
    const documentError = { url: 'https://vidfast.vc/movie/tt1', status: 500, description: 'Internal Server Error' }
    expect(missedStreamReason({ documentError, lastRequestAtMs: END, endedAtMs: END, budgetMs: 20_000 })).toEqual({
      kind: 'error',
      status: 500,
    })
  })

  it('calls a document with no answer at all unreachable', () => {
    const documentError = { url: 'https://gone.test/', status: 0, description: 'net::ERR_NAME_NOT_RESOLVED' }
    expect(missedStreamReason({ documentError, lastRequestAtMs: null, endedAtMs: END, budgetMs: 20_000 })).toEqual({
      kind: 'unreachable',
    })
  })

  it('reads a 403 on the document as a bot check, not a dead source', () => {
    const documentError = { url: 'https://p.test/', status: 403, description: 'Forbidden' }
    expect(judgeMissedStream({ documentError, lastRequestAtMs: END, endedAtMs: END, budgetMs: 20_000 })).toEqual({
      verdict: 'unsure',
      reason: { kind: 'blocked' },
    })
  })

  it('lets a 404 document fall through to what the page did next', () => {
    // Several providers answer an unknown title with a 404 page that then
    // loads a player of its own; the status alone settles nothing.
    const documentError = { url: 'https://p.test/', status: 404, description: 'Not Found' }
    expect(missedStreamReason({ documentError, lastRequestAtMs: END - 500, endedAtMs: END, budgetMs: 20_000 }).kind).toBe(
      'timeout',
    )
  })
})

describe('judgeMissedStream', () => {
  it('puts a timeout with the reds, as the owner asked', () => {
    const judged = judgeMissedStream({ documentError: null, lastRequestAtMs: END, endedAtMs: END, budgetMs: 25_000 })
    expect(judged).toEqual({ verdict: 'dead', reason: { kind: 'timeout', seconds: 25 } })
  })
})

describe('isScanCandidate', () => {
  const request = (url: string, over: { method?: string; mainFrame?: boolean } = {}) => ({
    url,
    method: over.method ?? 'GET',
    mainFrame: over.mainFrame ?? false,
  })

  it('keeps an opaque request that may answer as a playlist — 111Movies', () => {
    expect(isScanCandidate(request('https://a2.whysosigmabro.cfd/api?d=O6Sd8k&v=0'))).toBe(true)
  })

  it('keeps segments, which are evidence here rather than noise', () => {
    expect(isScanCandidate(request('https://cdn.test/v/chunk-00001.m4s'))).toBe(true)
    expect(isScanCandidate(request('https://cdn.test/v/seg-1.ts'))).toBe(true)
  })

  it("drops the page's own code, styling, imagery and subtitles", () => {
    for (const url of [
      'https://p.test/assets/index.js',
      'https://p.test/s.css?v=2',
      'https://image.tmdb.org/t/p/w1280/x.jpg',
      'https://p.test/fonts/a.woff2',
      'https://p.test/subs/en.vtt',
    ]) {
      expect(isScanCandidate(request(url))).toBe(false)
    }
  })

  it('drops the shell the probe frames the provider in, and anything but a GET', () => {
    expect(isScanCandidate(request('https://localhost/', { mainFrame: true }))).toBe(false)
    expect(isScanCandidate(request('https://p.test/api/source', { method: 'POST' }))).toBe(false)
  })

  it('drops what is not http(s), or not a URL at all', () => {
    expect(isScanCandidate(request('blob:https://p.test/236035e1'))).toBe(false)
    expect(isScanCandidate(request('not a url'))).toBe(false)
  })
})
