import { describe, expect, it } from 'vitest'
import {
  castabilities,
  deliveryCastability,
  isCastableFileType,
  liveCastability,
  piecesDelivery,
  sourceCastability,
  strongerDelivery,
  titleCastability,
  wholeFileDelivery,
} from './castability'
import { RESULT_TTL_MS } from './scanrow'
import type { ProviderScan } from './types'

const now = 1_800_000_000_000
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

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

  it('never casts DASH, which the cast path cannot send', () => {
    expect(deliveryCastability('dash')).toBe('no')
    expect(deliveryCastability('segmented')).toBe('yes')
  })

  it('counts pieces as DASH only when a DASH manifest was the only playlist seen', () => {
    expect(piecesDelivery({ hls: false, dash: true })).toBe('dash')
    expect(piecesDelivery({ hls: true, dash: true })).toBe('segmented')
    // No playlist in sight (one fed from a blob): HLS, as it always was.
    expect(piecesDelivery({ hls: false, dash: false })).toBe('segmented')
  })

  it('records the delivery a cast would send: a file, then HLS, then DASH', () => {
    expect(strongerDelivery('dash', 'segmented')).toBe('segmented')
    expect(strongerDelivery('segmented', 'dash')).toBe('segmented')
    expect(strongerDelivery('unknown', 'dash')).toBe('dash')
    expect(strongerDelivery('dash', 'progressive')).toBe('progressive')
  })
})

describe('titleCastability', () => {
  it('reads how the video arrived: a whole file or HLS casts, another container does not', () => {
    // HLS casts: measured 2026-09-26 on the owner's dongle through the proxy.
    const scan = row('tv:tt1', { delivery: { a: 'progressive', b: 'segmented', c: 'other', d: 'unknown' } })
    expect(titleCastability(scan, 'a')).toBe('yes')
    expect(titleCastability(scan, 'b')).toBe('yes')
    expect(titleCastability(scan, 'c')).toBe('no')
    expect(titleCastability(scan, 'd')).toBeNull()
    expect(titleCastability(scan, 'never-tested')).toBeNull()
    expect(titleCastability(null, 'a')).toBeNull()
  })

  it("puts the television's own answer above the prediction", () => {
    // A whole MP4 in a codec the dongle does not decode; an MKV that played.
    const scan = row('tv:tt1', { delivery: { a: 'progressive', b: 'other' }, casts: { a: 'refused', b: 'played' } })
    expect(titleCastability(scan, 'a')).toBe('no')
    expect(titleCastability(scan, 'b')).toBe('yes')
  })

  it('does not report a source that blocked the cast as one whose format the TV refused', () => {
    const scan = row('tv:tt1', { delivery: { a: 'segmented' }, casts: { a: 'blocked' } })
    expect(titleCastability(scan, 'a')).toBe('blocked')
  })

  it("reads the other kind of device's delivery as likely at most", () => {
    // The phone calls a playlist alone a stream: on the desktop that predicts, and proves nothing.
    const scan = row('tv:tt1', { delivery: { a: 'segmented', b: 'other' }, casts: { c: 'played' } })
    const sharedFrom = { a: 'phone', b: 'phone', c: 'phone' }
    expect(titleCastability(scan, 'a', sharedFrom)).toBe('likely')
    expect(titleCastability(scan, 'b', sharedFrom)).toBe('no')
    // A television's answer is the television's, whichever device handed it the stream.
    expect(titleCastability(scan, 'c', sharedFrom)).toBe('yes')
  })
})

describe('sourceCastability', () => {
  it('calls a source likely once it has streamed any title in a form that casts', () => {
    const rows = [row('tv:tt1', { delivery: { a: 'other' } }), row('tv:tt2', { delivery: { a: 'segmented' } })]
    expect(sourceCastability(rows, 'a', now)).toBe('likely')
  })

  it('calls it no only when it was seen and never in a form that casts', () => {
    expect(sourceCastability([row('tv:tt1', { delivery: { a: 'other' } })], 'a', now)).toBe('no')
    expect(sourceCastability([row('tv:tt1', { delivery: { a: 'unknown' } })], 'a', now)).toBeNull()
    expect(sourceCastability([], 'a', now)).toBeNull()
  })

  /*
   * The rule across titles (2.0.18): `likely` only while the source's last
   * cast anywhere, if it was ever cast, played. Before, one castable stream
   * anywhere made it `likely` whatever any television had said since.
   */
  it('stops calling a source likely once its last cast anywhere was refused', () => {
    const tested = row('tv:tt1', { delivery: { a: 'segmented' } }, now - 3 * HOUR)
    const refused = row('tv:tt2', { delivery: { a: 'segmented' }, casts: { a: 'refused' }, castAt: { a: now - 2 * HOUR } })
    expect(sourceCastability([tested, refused], 'a', now)).toBeNull()
    // A test since says how the video arrives, which the refusal has shown is not enough.
    const retested = row('tv:tt3', { delivery: { a: 'segmented' } }, now - HOUR)
    expect(sourceCastability([tested, refused, retested], 'a', now)).toBeNull()
  })

  it('calls it likely again once a newer cast played, anywhere', () => {
    const refused = row('tv:tt2', { delivery: { a: 'segmented' }, casts: { a: 'refused' }, castAt: { a: now - 2 * HOUR } })
    const played = row('tv:tt3', { delivery: { a: 'segmented' }, casts: { a: 'played' }, castAt: { a: now - HOUR } })
    expect(sourceCastability([refused, played], 'a', now)).toBe('likely')
    // And an older play does not outrank a newer refusal.
    const playedEarlier = row('tv:tt3', { delivery: { a: 'segmented' }, casts: { a: 'played' }, castAt: { a: now - 3 * HOUR } })
    expect(sourceCastability([refused, playedEarlier], 'a', now)).toBeNull()
  })

  it('dates an answer by when the television gave it, not by the newer test beside it', () => {
    // The row's verdict is from a test an hour ago; the refusal was a day ago, the play elsewhere since.
    const refusedLongAgo = row('tv:tt2', { delivery: { a: 'segmented' }, casts: { a: 'refused' }, castAt: { a: now - DAY }, testedAt: { a: now - HOUR } })
    const played = row('tv:tt3', { delivery: { a: 'segmented' }, casts: { a: 'played' }, castAt: { a: now - 2 * HOUR } })
    expect(sourceCastability([refusedLongAgo, played], 'a', now)).toBe('likely')
  })

  it('treats a block as a failed cast but not as a format the TV cannot play', () => {
    const tested = row('tv:tt1', { delivery: { a: 'segmented' } }, now - 3 * HOUR)
    const blocked = row('tv:tt2', { delivery: { a: 'segmented' }, casts: { a: 'blocked' }, castAt: { a: now - HOUR } })
    expect(sourceCastability([tested, blocked], 'a', now)).toBeNull()
    // Blocked and nothing else: not known to cast, and not hidden either.
    expect(sourceCastability([blocked], 'a', now)).toBeNull()
    // Refused and nothing else is a source never seen castable, as before.
    const refused = row('tv:tt2', { delivery: { a: 'segmented' }, casts: { a: 'refused' }, castAt: { a: now - HOUR } })
    expect(sourceCastability([refused], 'a', now)).toBe('no')
  })

  it('forgets what a source did past the lifetime of a result', () => {
    // A castable stream long ago, only MKV since: the old one must not keep it "likely".
    const old = row('tv:tt1', { delivery: { a: 'progressive' } }, now - RESULT_TTL_MS - 1)
    const recent = row('tv:tt2', { delivery: { a: 'other' } })
    expect(sourceCastability([old, recent], 'a', now)).toBe('no')
  })
})

describe('castabilities', () => {
  it("uses the title's evidence where there is any and the source's record elsewhere", () => {
    const title = row('tv:tt1', { delivery: { a: 'other', b: 'segmented', f: 'segmented' }, casts: { g: 'blocked' } })
    const elsewhere = [row('tv:tt2', { delivery: { a: 'progressive', c: 'progressive', d: 'other' } })]
    expect(castabilities(['a', 'b', 'c', 'd', 'e', 'f', 'g'], { scan: title, sharedFrom: { f: 'phone' } }, [title, ...elsewhere], now)).toEqual({
      // Castable elsewhere, but MKV for this very title: the title decides.
      a: 'no',
      b: 'yes',
      c: 'likely',
      d: 'no',
      e: 'unknown',
      // Seen streaming HLS by the phone only.
      f: 'likely',
      // The source refused the proxy the last time it was cast: listed, not hidden.
      g: 'blocked',
    })
  })
})

describe('liveCastability', () => {
  it("never lets a test's delivery override what a television said", () => {
    // The test still running in the cast list sees the playlist the TV refused.
    expect(liveCastability('no', 'refused', 'segmented')).toBe('no')
    expect(liveCastability('blocked', 'blocked', 'segmented')).toBe('blocked')
    expect(liveCastability('yes', 'played', 'other')).toBe('yes')
  })

  it('lets it fill in, and correct, a prediction', () => {
    // MKV last time, HLS now: the source changed its form.
    expect(liveCastability('no', undefined, 'segmented')).toBe('yes')
    expect(liveCastability('likely', undefined, 'progressive')).toBe('yes')
    // A test that could not see the form says nothing.
    expect(liveCastability('likely', undefined, 'unknown')).toBe('likely')
    expect(liveCastability(undefined, undefined, undefined)).toBe('unknown')
  })
})
