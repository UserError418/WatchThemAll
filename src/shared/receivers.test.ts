/**
 * Which television is which, and whether a stream fits what it decodes.
 *
 * Every limit here is Google's published specification (`receivers.ts`),
 * except one measurement: the owner's Chromecast refused H.264 at
 * 2160x1080. The cases pin the two mistakes that matter. A `no` that is
 * wrong hides a source that plays; a `yes` that is wrong is the false promise
 * this whole check exists to stop. Where the specification does not settle
 * it, the answer is `unknown`, with the reason.
 */

import { describe, expect, it } from 'vitest'
import { CONSERVATIVE, fitsProfile, RECEIVER_PROFILES, receiverProfile } from './receivers'
import type { StreamSignature, VideoSignature } from './streamsignature'

const signature = (video: Partial<VideoSignature> | null, more: Partial<StreamSignature> = {}): StreamSignature => ({
  container: 'ts',
  video:
    video === null
      ? null
      : { codec: 'h264', profile: 'high', level: 4, width: 1920, height: 1080, fps: 24, ...video },
  audio: ['aac'],
  encryption: 'none',
  ...more,
})

const chromecast = receiverProfile('Chromecast')

describe('receiverProfile', () => {
  it.each([
    ['Chromecast', 'chromecast'],
    ['chromecast', 'chromecast'],
    ['Chromecast Ultra', 'chromecast-ultra'],
    ['Chromecast HD', 'google-tv-hd'],
    ['Chromecast with Google TV', 'google-tv-hd'],
    ['Chromecast with Google TV 4K', 'google-tv-4k'],
    ['Google TV Streamer', 'google-tv-streamer'],
  ])('reads %s as %s', (model, id) => {
    expect(receiverProfile(model).id).toBe(id)
  })

  it('gives an unknown model, or none, the strictest profile', () => {
    for (const model of [undefined, null, '', 'BRAVIA 4K VH2', 'Google Nest Hub']) {
      expect(receiverProfile(model)).toBe(CONSERVATIVE)
    }
  })

  it('is never promised more than the strictest Chromecast: the fallback is that profile', () => {
    expect(CONSERVATIVE.video).toEqual(chromecast.video)
    expect(CONSERVATIVE.passthrough).toEqual(chromecast.passthrough)
  })

  it('marks every limit as the specification, not a measurement', () => {
    for (const profile of RECEIVER_PROFILES) {
      for (const limit of profile.video) {
        expect(limit.verified).toBe(false)
        expect(limit.spec).toMatch(/read 2026-10-09/)
      }
    }
  })

  it("keeps the owner's measurement with the model it was made on", () => {
    expect(chromecast.measured).toEqual([expect.objectContaining({ codec: 'h264', width: 2160, height: 1080, outcome: 'refused' })])
    expect(CONSERVATIVE.measured).toEqual([])
  })
})

describe('fitsProfile', () => {
  it('fits a 1080p H.264 High film with AAC on a plain Chromecast', () => {
    expect(fitsProfile(signature({}), chromecast)).toEqual({ fit: 'yes', reason: null, measured: false })
  })

  it("refuses Videasy's 2160x1080 on a plain Chromecast by the measurement, and by the spec elsewhere", () => {
    const videasy = signature({ width: 2160, height: 1080, level: 5 })
    expect(fitsProfile(videasy, chromecast)).toEqual({ fit: 'no', reason: 'a TV like this one refused H.264 2160×1080', measured: true })
    expect(fitsProfile(videasy, CONSERVATIVE)).toEqual({ fit: 'no', reason: "this TV can't play H.264 2160×1080", measured: false })
  })

  it('fits a letterboxed film, and a 1080 declared uncropped as 1088', () => {
    expect(fitsProfile(signature({ width: 1920, height: 800 }), chromecast).fit).toBe('yes')
    expect(fitsProfile(signature({ width: 1920, height: 1088 }), chromecast).fit).toBe('yes')
  })

  it('refuses a frame wider than 1080p on a plain Chromecast, and plays it on a 4K one', () => {
    const wide = signature({ width: 2048, height: 858, level: 4 })
    expect(fitsProfile(wide, chromecast)).toMatchObject({ fit: 'no', reason: "this TV can't play H.264 2048×858" })
    expect(fitsProfile(wide, receiverProfile('Chromecast with Google TV 4K')).fit).toBe('yes')
  })

  it('refuses 1080p at 60 fps on the first Chromecasts, and takes 720p at 60', () => {
    expect(fitsProfile(signature({ fps: 60, level: 4.2 }), chromecast)).toMatchObject({
      fit: 'no',
      reason: "this TV can't play H.264 1920×1080 at 60 fps",
    })
    expect(fitsProfile(signature({ width: 1280, height: 720, fps: 60, level: 3.2 }), chromecast).fit).toBe('yes')
    expect(fitsProfile(signature({ fps: 59.94, level: 4.2 }), receiverProfile('Chromecast Ultra')).fit).toBe('yes')
  })

  it('treats 29.97 as 30 frames a second', () => {
    expect(fitsProfile(signature({ fps: 29.97 }), chromecast).fit).toBe('yes')
  })

  it('refuses HEVC on a plain Chromecast, and plays Main 10 on an Ultra', () => {
    const hevc = signature({ codec: 'hevc', profile: 'main10', level: 5.1, width: 3840, height: 2160 })
    expect(fitsProfile(hevc, chromecast)).toMatchObject({ fit: 'no', reason: "this TV can't play HEVC" })
    expect(fitsProfile(hevc, receiverProfile('Chromecast Ultra')).fit).toBe('yes')
  })

  it('refuses H.264 High 10, which no Cast device lists', () => {
    expect(fitsProfile(signature({ profile: 'high10' }), receiverProfile('Google TV Streamer'))).toMatchObject({
      fit: 'no',
      reason: "this TV can't play H.264 High 10",
    })
  })

  it('refuses AV1 everywhere but the Streamer', () => {
    const av1 = signature({ codec: 'av1', profile: 'main', level: 4 })
    expect(fitsProfile(av1, receiverProfile('Chromecast Ultra')).fit).toBe('no')
    expect(fitsProfile(av1, receiverProfile('Google TV Streamer')).fit).toBe('yes')
  })

  it('leaves AC-3 and E-AC-3 unknown, not refused: they play through an amplifier', () => {
    expect(fitsProfile(signature({}, { audio: ['ac3'] }), chromecast)).toEqual({
      fit: 'unknown',
      reason: 'its AC-3 sound plays only through an amplifier connected to the TV',
      measured: false,
    })
    expect(fitsProfile(signature({}, { audio: ['aac', 'eac3'] }), chromecast).fit).toBe('unknown')
  })

  it('leaves a level above the spec unknown when the frame itself fits: encoders over-declare', () => {
    expect(fitsProfile(signature({ level: 5.1 }), chromecast)).toMatchObject({
      fit: 'unknown',
      reason: 'it declares H.264 level 5.1, above the 4.1 a plain Chromecast is specified for',
    })
  })

  it('leaves unknown what it cannot read, and DRM-shaped encryption', () => {
    expect(fitsProfile(signature(null), chromecast).fit).toBe('unknown')
    expect(fitsProfile(signature({ width: null, height: null }), chromecast).fit).toBe('unknown')
    expect(fitsProfile(signature({ codec: 'other', profile: null }), chromecast).fit).toBe('unknown')
    expect(fitsProfile(signature({}, { encryption: 'sample-aes' }), chromecast).fit).toBe('unknown')
    expect(fitsProfile(signature({}, { audio: ['other'] }), chromecast).fit).toBe('unknown')
  })

  it('plays AES-128, which the proxy fetches the key for like any segment', () => {
    expect(fitsProfile(signature({}, { encryption: 'aes-128' }), chromecast).fit).toBe('yes')
  })

  it('judges a frame rate it does not know by the size alone', () => {
    expect(fitsProfile(signature({ fps: null }), chromecast).fit).toBe('yes')
  })
})
