import { describe, expect, it } from 'vitest'
import { castabilities, isCastableFileType, sourceCastability, titleCastability, wholeFileDelivery } from './castability'
import { RESULT_TTL_MS } from './scanrow'
import type { ProviderScan } from './types'

const now = 1_800_000_000_000

const row = (titleKey: string, extra: Partial<ProviderScan>, at = now): ProviderScan => ({
  titleKey,
  at,
  verdicts: Object.fromEntries(Object.keys({ ...extra.delivery, ...extra.casts }).map((id) => [id, 'stream'])),
  ...extra,
})

describe('the receiver rule', () => {
  it('takes MP4 and WebM, with or without parameters, and nothing else', () => {
    expect(isCastableFileType('video/mp4')).toBe(true)
    expect(isCastableFileType('Video/WebM; codecs="vp9"')).toBe(true)
    expect(isCastableFileType('video/x-matroska')).toBe(false)
    expect(isCastableFileType('application/octet-stream')).toBe(false)
    expect(wholeFileDelivery('video/mp4')).toBe('progressive')
    expect(wholeFileDelivery('video/x-matroska')).toBe('other')
  })
})

describe('titleCastability', () => {
  it('reads how the video arrived', () => {
    const scan = row('tv:tt1', { delivery: { a: 'progressive', b: 'segmented', c: 'other', d: 'unknown' } })
    expect(titleCastability(scan, 'a')).toBe('yes')
    expect(titleCastability(scan, 'b')).toBe('no')
    expect(titleCastability(scan, 'c')).toBe('no')
    expect(titleCastability(scan, 'd')).toBeNull()
    expect(titleCastability(scan, 'never-tested')).toBeNull()
    expect(titleCastability(null, 'a')).toBeNull()
  })

  it("puts the television's own answer above the prediction", () => {
    // A whole MP4 in a codec the dongle does not decode.
    const scan = row('tv:tt1', { delivery: { a: 'progressive', b: 'segmented' }, casts: { a: 'refused', b: 'played' } })
    expect(titleCastability(scan, 'a')).toBe('no')
    expect(titleCastability(scan, 'b')).toBe('yes')
  })
})

describe('sourceCastability', () => {
  it('calls a source likely once it has handed out a whole file for any title', () => {
    const rows = [row('tv:tt1', { delivery: { a: 'segmented' } }), row('tv:tt2', { delivery: { a: 'progressive' } })]
    expect(sourceCastability(rows, 'a', now)).toBe('likely')
  })

  it('calls it no only when it was seen and never with a file', () => {
    expect(sourceCastability([row('tv:tt1', { delivery: { a: 'segmented' } })], 'a', now)).toBe('no')
    expect(sourceCastability([row('tv:tt1', { delivery: { a: 'unknown' } })], 'a', now)).toBeNull()
    expect(sourceCastability([], 'a', now)).toBeNull()
  })

  it('forgets what a source did past the lifetime of a result', () => {
    // VidSrc gave a file once and playlists since; the old file must not keep it "likely".
    const old = row('tv:tt1', { delivery: { a: 'progressive' } }, now - RESULT_TTL_MS - 1)
    const recent = row('tv:tt2', { delivery: { a: 'segmented' } })
    expect(sourceCastability([old, recent], 'a', now)).toBe('no')
  })
})

describe('castabilities', () => {
  it("uses the title's evidence where there is any and the source's record elsewhere", () => {
    const title = row('tv:tt1', { delivery: { a: 'segmented', b: 'progressive' } })
    const elsewhere = [row('tv:tt2', { delivery: { a: 'progressive', c: 'progressive', d: 'segmented' } })]
    expect(castabilities(['a', 'b', 'c', 'd', 'e'], title, [title, ...elsewhere], now)).toEqual({
      // A file elsewhere, but a playlist for this very title: the title decides.
      a: 'no',
      b: 'yes',
      c: 'likely',
      d: 'no',
      e: 'unknown',
    })
  })
})
