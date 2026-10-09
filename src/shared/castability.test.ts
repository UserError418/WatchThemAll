import { describe, expect, it } from 'vitest'
import {
  castabilities,
  castEvidence,
  castTier,
  deliveryCastability,
  isCastableFileType,
  liveCastability,
  piecesDelivery,
  sourceCastability,
  strongerDelivery,
  titleCastability,
  wholeFileDelivery,
  type CastAnswerFact,
  type CastEvidence,
  type Castability,
  type DatedCastCheck,
} from './castability'
import { receiverProfile } from './receivers'
import { RESULT_TTL_MS } from './scanrow'
import type { SourceResult } from './sourceresults'
import type { StreamSignature } from './streamsignature'
import type { ProviderScan } from './types'

const now = 1_800_000_000_000
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
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

/* ── The tiers, for the television chosen (2.0.19) ─────────────────────── */

describe('castTier', () => {
  const sig = (width: number, height: number, codec: 'h264' | 'hevc' = 'h264'): StreamSignature => ({
    container: 'ts',
    video: { codec, profile: codec === 'h264' ? 'high' : 'main', level: 4, width, height, fps: 24 },
    audio: ['aac'],
    encryption: 'none',
  })
  const VIDEASY = sig(2160, 1080)
  const FILM = sig(1920, 1080)
  const check = (extra: Partial<DatedCastCheck>): DatedCastCheck => ({ reach: 'ok', identity: 'film', signature: FILM, at: now - HOUR, ...extra })
  const answer = (extra: Partial<CastAnswerFact>): CastAnswerFact => ({
    providerId: 'a',
    titleKey: 'tv:tt1',
    outcome: 'played',
    at: now - 2 * HOUR,
    receiver: 'Chromecast',
    signature: FILM,
    ...extra,
  })
  const tier = (evidence: Partial<CastEvidence>, model: string | null = 'Chromecast', base: Castability = 'yes') =>
    castTier({
      providerId: 'a',
      titleKey: 'tv:tt1',
      evidence: { checks: {}, answers: [], ...evidence },
      base,
      model,
      profile: receiverProfile(model),
    })

  it("checks a 1080p H.264 stream the check reached for a plain Chromecast", () => {
    expect(tier({ checks: { a: check({}) } })).toEqual({ tier: 'checked', reason: null })
  })

  it("hides Videasy's 2160x1080 on a plain Chromecast by the measurement, on an unknown TV by the spec, and checks it for a 4K Google TV", () => {
    const evidence = { checks: { a: check({ signature: VIDEASY }) } }
    expect(tier(evidence)).toEqual({ tier: 'hidden', reason: 'a TV like this one refused H.264 2160×1080' })
    expect(tier(evidence, null)).toEqual({ tier: 'hidden', reason: "this TV can't play H.264 2160×1080" })
    // The Ultra's H.264 stops at 1080p too, by the spec; a 4K Google TV's does not.
    expect(tier(evidence, 'Chromecast Ultra')).toEqual({ tier: 'hidden', reason: "this TV can't play H.264 2160×1080" })
    expect(tier(evidence, 'Chromecast with Google TV 4K')).toEqual({ tier: 'checked', reason: null })
  })

  it('hides HEVC on a plain Chromecast, with the codec as the reason', () => {
    expect(tier({ checks: { a: check({ signature: sig(1920, 1080, 'hevc') }) } })).toEqual({ tier: 'hidden', reason: "this TV can't play HEVC" })
  })

  it('proves a source a TV of this model played on this title', () => {
    expect(tier({ answers: [answer({})], checks: { a: check({}) } })).toEqual({ tier: 'plays', reason: 'played on a TV like this one' })
    // An answer from before models were filed stands for any television, as it always did.
    expect(tier({ answers: [answer({ receiver: null, signature: null })] })).toEqual({ tier: 'plays', reason: 'played when cast' })
  })

  it("does not take another model's answer for this one's", () => {
    expect(tier({ answers: [answer({ receiver: 'Chromecast Ultra' })], checks: { a: check({}) } })).toEqual({ tier: 'checked', reason: null })
    expect(tier({ answers: [answer({ outcome: 'refused', receiver: 'Chromecast Ultra' })], checks: { a: check({}) } }).tier).toBe('checked')
  })

  it("lets a newer check of another class set a played answer aside: the source's stream has changed", () => {
    const evidence = { answers: [answer({})], checks: { a: check({ signature: VIDEASY }) } }
    expect(tier(evidence)).toEqual({ tier: 'hidden', reason: 'a TV like this one refused H.264 2160×1080' })
  })

  it('files a played source as blocked today when a newer check could not reach it', () => {
    const evidence = { answers: [answer({})], checks: { a: check({ reach: 'blocked', status: 403 }) } }
    expect(tier(evidence)).toEqual({ tier: 'blocked', reason: "the source refused the cast's request (403)" })
  })

  it("hides a source this model refused on this title, the TV's answer standing over a test", () => {
    const evidence = { answers: [answer({ outcome: 'refused', signature: VIDEASY })], checks: { a: check({ signature: VIDEASY, at: now }) } }
    expect(tier(evidence)).toEqual({ tier: 'hidden', reason: 'a TV like this one refused H.264 2160×1080' })
    expect(tier({ answers: [answer({ outcome: 'refused', receiver: null, signature: null })] })).toEqual({ tier: 'hidden', reason: 'a TV like this one refused it' })
  })

  it("applies a refusal to every source serving the same class to the same model", () => {
    // Another source, another title: refused a stream of exactly this class on this model.
    const elsewhere = answer({ providerId: 'b', titleKey: 'movie:tt9', outcome: 'refused', signature: FILM })
    const evidence = { answers: [elsewhere], checks: { a: check({}) } }
    expect(tier(evidence)).toEqual({ tier: 'hidden', reason: 'a TV like this one refused H.264 1920×1080' })
    // On another model it says nothing.
    expect(tier(evidence, 'Chromecast Ultra')).toEqual({ tier: 'checked', reason: null })
    // A newer play of the class on this model lifts it.
    const replayed = { ...evidence, answers: [answer({ providerId: 'c', titleKey: 'movie:tt8', at: now - 10 * MINUTE }), elsewhere] }
    expect(tier(replayed)).toEqual({ tier: 'checked', reason: 'a TV like this one played H.264 1920×1080 from another source' })
  })

  it("lets a television's play of a class outrank the spec that says it cannot", () => {
    // Outside a plain Chromecast's published 1920 wide, yet measured playing on one.
    const wide = sig(2048, 858)
    const played = answer({ providerId: 'b', titleKey: 'movie:tt9', signature: wide })
    expect(tier({ checks: { a: check({ signature: wide }) } }).tier).toBe('hidden')
    expect(tier({ answers: [played], checks: { a: check({ signature: wide }) } }).tier).toBe('checked')
    expect(tier({ answers: [{ ...played, providerId: 'a' }], checks: { a: check({ signature: wide }) } })).toEqual({
      tier: 'plays',
      reason: 'played H.264 2048×858 on a TV like this one',
    })
  })

  it('proves a source that played a stream of this class on this model on another title', () => {
    const before = answer({ titleKey: 'movie:tt9' })
    expect(tier({ answers: [before], checks: { a: check({}) } })).toEqual({ tier: 'plays', reason: 'played H.264 1920×1080 on a TV like this one' })
    // Another source's play proves nothing about this one.
    expect(tier({ answers: [{ ...before, providerId: 'b' }], checks: { a: check({}) } }).tier).toBe('checked')
  })

  it("lists what is blocked, slow, not media or not the title today, with why", () => {
    expect(tier({ checks: { a: check({ reach: 'blocked', status: 0 }) } })).toEqual({ tier: 'blocked', reason: 'the source did not answer the cast' })
    expect(tier({ checks: { a: check({ reach: 'not-media' }) } })).toEqual({ tier: 'blocked', reason: 'the source handed out nothing a TV can play' })
    expect(tier({ checks: { a: check({ reach: 'slow', pace: 1.62 }) } })).toEqual({
      tier: 'blocked',
      reason: 'too slow: a piece of the stream took 1.6× its length to arrive',
    })
    expect(tier({ checks: { a: check({ identity: 'wrong-length', seconds: 125 }) } })).toEqual({ tier: 'blocked', reason: 'it served a 2 min video, not the title' })
  })

  it('leaves unchecked, with the reason, what the profile cannot settle', () => {
    const ac3 = { ...FILM, audio: ['ac3' as const] }
    expect(tier({ checks: { a: check({ signature: ac3 }) } })).toEqual({
      tier: 'unchecked',
      reason: 'its AC-3 sound plays only through an amplifier connected to the TV',
    })
    expect(tier({ checks: { a: check({ signature: undefined }) } })).toEqual({ tier: 'unchecked', reason: 'reached, but what it holds could not be read' })
  })

  it('reads a check word from a newer build as no check', () => {
    expect(tier({ checks: { a: check({ reach: 'throttled' }) } })).toEqual({ tier: 'unchecked', reason: null })
  })

  it('lets a newer check that reached it lift a block', () => {
    expect(tier({ answers: [answer({ outcome: 'blocked' })], checks: { a: check({}) } })).toEqual({ tier: 'checked', reason: null })
    expect(tier({ answers: [answer({ outcome: 'blocked' })] })).toEqual({ tier: 'blocked', reason: 'the source blocked the TV when last cast' })
  })

  it('falls back to what the delivery predicts where nothing about casting was measured', () => {
    expect(tier({}, 'Chromecast', 'yes')).toEqual({ tier: 'unchecked', reason: null })
    expect(tier({}, 'Chromecast', 'likely')).toEqual({ tier: 'unchecked', reason: null })
    expect(tier({}, 'Chromecast', 'no')).toEqual({ tier: 'hidden', reason: 'it streams only in a form that cannot be cast' })
    expect(tier({}, 'Chromecast', 'blocked')).toEqual({ tier: 'blocked', reason: 'the source blocked the TV when last cast' })
  })
})

describe('castEvidence', () => {
  const base: SourceResult = {
    titleKey: 'tv:tt1',
    season: 1,
    episode: 1,
    providerId: 'a',
    at: now - HOUR,
    deviceId: 'pc-1',
    deviceKind: 'desktop',
    origin: 'test',
    verdict: 'stream',
  }

  it("takes each source's newest check on the title, and every answer on record, newest first", () => {
    const older = { ...base, at: now - 2 * HOUR, castCheck: { reach: 'blocked', identity: 'unknown', status: 403 } }
    const newer = { ...base, castCheck: { reach: 'ok', identity: 'film' } }
    const otherTitle = { ...base, titleKey: 'movie:tt9', at: now, castCheck: { reach: 'slow', identity: 'film' } }
    const cast = { ...base, titleKey: 'movie:tt9', origin: 'play' as const, at: now - 3 * HOUR, cast: 'refused' as const, castReceiver: 'Chromecast' }
    const legacyCast = { ...base, origin: 'play' as const, at: now - 4 * HOUR, cast: 'played' as const }
    const evidence = castEvidence([older, newer, otherTitle, cast, legacyCast], 'tv:tt1', now)
    expect(evidence.checks).toEqual({ a: { reach: 'ok', identity: 'film', at: now - HOUR } })
    expect(evidence.answers).toEqual([
      { providerId: 'a', titleKey: 'movie:tt9', outcome: 'refused', at: now - 3 * HOUR, receiver: 'Chromecast', signature: null },
      { providerId: 'a', titleKey: 'tv:tt1', outcome: 'played', at: now - 4 * HOUR, receiver: null, signature: null },
    ])
  })

  it('ignores what is past its lifetime', () => {
    const old = { ...base, at: now - RESULT_TTL_MS - 1, cast: 'refused' as const, castCheck: { reach: 'ok', identity: 'film' } }
    expect(castEvidence([old], 'tv:tt1', now)).toEqual({ checks: {}, answers: [] })
  })
})
