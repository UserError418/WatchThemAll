import { describe, expect, it } from 'vitest'
import { judgeFilmLength, minutesText, somethingElse, wrongVideoReason } from './rightfilm'

describe('judgeFilmLength', () => {
  /** Measured 2026-10-04: VidRock's clips for the 139-minute Fight Club. */
  it('calls a clip in the place of the film something else, by its longest length', () => {
    expect(judgeFilmLength([167, 272], 139)).toEqual({ kind: 'other', seconds: 272 })
  })

  it('calls a programme of the wrong length something else, longer as well as shorter', () => {
    // A feature film where a 22-minute episode was asked for.
    expect(judgeFilmLength([6_600], 22)).toEqual({ kind: 'other', seconds: 6_600 })
  })

  it('needs only one length that fits: an advert beside the film changes nothing', () => {
    expect(judgeFilmLength([30, 8_340], 139)).toEqual({ kind: 'film' })
    // An audio or subtitle playlist of the film counts like its video.
    expect(judgeFilmLength([15, 8_301], 139)).toEqual({ kind: 'film' })
  })

  it('changes nothing when no length is known', () => {
    expect(judgeFilmLength([], 139)).toEqual({ kind: 'unknown' })
    // Not loaded yet (0, NaN) and live (Infinity) are not lengths.
    expect(judgeFilmLength([0, Number.NaN, Number.POSITIVE_INFINITY], 139)).toEqual({ kind: 'unknown' })
  })

  it("holds a length to the ten-minute floor when TMDB gives no runtime", () => {
    expect(judgeFilmLength([167], null)).toEqual({ kind: 'other', seconds: 167 })
    expect(judgeFilmLength([1_320], null)).toEqual({ kind: 'film' })
  })

  it("is as generous as the runtime check: a different cut of the film is still the film", () => {
    // 139 minutes on TMDB; a 151-minute cut is inside the band.
    expect(judgeFilmLength([151 * 60], 139)).toEqual({ kind: 'film' })
  })
})

describe('the words', () => {
  it('say what played, against what was asked for', () => {
    expect(somethingElse(167, 139, 'film')).toBe('plays something else here (a 3 min video for a 139 min film)')
    expect(somethingElse(20, 24, 'episode')).toBe('plays something else here (a 1 min video for a 24 min episode)')
    expect(minutesText(10)).toBe('1 min')
  })

  it('carry everything the label needs in the reason', () => {
    expect(wrongVideoReason({ kind: 'other', seconds: 272.4 }, 139, 'film')).toEqual({
      kind: 'wrong-video',
      seconds: 272,
      expectedMinutes: 139,
      title: 'film',
    })
  })
})
