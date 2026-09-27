import { describe, expect, it } from 'vitest'

import { languagesOf, rankFiles, type SubtitleFile } from './subtitlesearch'

const file = (over: Partial<SubtitleFile>): SubtitleFile => ({
  language: 'eng',
  iso: 'en',
  languageName: 'English',
  format: 'srt',
  url: 'https://dl.opensubtitles.org/x',
  encoding: 'UTF-8',
  lastStamp: '00:47:53',
  downloads: 100,
  hearingImpaired: false,
  release: 'Breaking Bad S01E02',
  ...over,
})

describe('rankFiles', () => {
  /** A 48-minute episode: a file ending at 47:53 is its cut; one ending at 58:00 is not. */
  it('puts a file whose last line fits the film first, however popular the others', () => {
    const fits = file({ release: 'fits', downloads: 10 })
    const longer = file({ release: 'longer cut', lastStamp: '00:58:00', downloads: 90_000 })
    expect(rankFiles([longer, fits], 2_885).map((f) => f.release)).toEqual(['fits', 'longer cut'])
  })

  it('then prefers no hearing-impaired descriptions, then downloads', () => {
    const hi = file({ release: 'hi', hearingImpaired: true, downloads: 9_000 })
    const plain = file({ release: 'plain', downloads: 50 })
    const popular = file({ release: 'popular', downloads: 5_000 })
    expect(rankFiles([hi, plain, popular], 2_885).map((f) => f.release)).toEqual(['popular', 'plain', 'hi'])
  })

  it('leaves out formats timed in frames', () => {
    expect(rankFiles([file({ format: 'sub' }), file({ format: 'vtt', release: 'v' })], 2_885).map((f) => f.release)).toEqual(['v'])
  })
})

describe('languagesOf', () => {
  it('counts files per language, most first', () => {
    const languages = languagesOf([
      file({}),
      file({ language: 'ger', iso: 'de', languageName: 'German' }),
      file({ language: 'ger', iso: 'de', languageName: 'German' }),
    ])
    expect(languages).toEqual([
      { code: 'ger', iso: 'de', name: 'German', count: 2 },
      { code: 'eng', iso: 'en', name: 'English', count: 1 },
    ])
  })
})
