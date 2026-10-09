import { describe, expect, it } from 'vitest'
import { CaptureBuffer } from '@shared/capturebuffer'
import type { Candidate } from '../main/castcapture'

const request = (n: number, path = `seg/${n}`): Candidate => ({ url: `https://cdn.test/${path}`, headers: {}, atMs: n })

describe('the cast capture', () => {
  it("keeps a load's manifest through a flood of extensionless segments", () => {
    // Measured 2026-10-09 on MoviesAPI: the manifest, then hundreds of
    // segments named with no extension; the forty newest were all segments.
    const buffer = new CaptureBuffer<Candidate>()
    buffer.add(request(0, 'api/resolve'))
    buffer.add(request(1, 'hls/master'))
    for (let n = 2; n < 300; n++) buffer.add(request(n))
    const urls = buffer.candidates().map((c) => c.url)
    expect(urls).toContain('https://cdn.test/hls/master')
    // Within the first two dozen, which is all the cast's choice asks about.
    expect(urls.indexOf('https://cdn.test/hls/master')).toBeLessThan(24)
  })

  it('lists each request once, the first ones newest first, then the rest newest first', () => {
    const buffer = new CaptureBuffer<Candidate>()
    for (let n = 0; n < 25; n++) buffer.add(request(n))
    const order = buffer.candidates().map((c) => c.atMs)
    expect(order.slice(0, 20)).toEqual([19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
    expect(order.slice(20)).toEqual([24, 23, 22, 21, 20])
  })

  it('forgets everything on clear, the first requests included', () => {
    const buffer = new CaptureBuffer<Candidate>()
    buffer.add(request(0, 'hls/master'))
    buffer.clear()
    buffer.add(request(1))
    expect(buffer.candidates().map((c) => c.atMs)).toEqual([1])
  })
})
