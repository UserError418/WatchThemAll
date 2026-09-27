import { describe, expect, it } from 'vitest'

import { cuesAt, parseSubtitles } from './subtitles'

/** The start of the OpenSubtitles file for Breaking Bad S1E2, advert and all. */
const SRT = `\uFEFF1
00:00:03,037 --> 00:00:04,837
[MOANING AND HEAVY BREATHING]

2
00:00:06,000 --> 00:00:12,074
Watch Online Movies and Series for FREE
www.osdb.link/lm

3
00:00:13,647 --> 00:00:15,425
<i>[COUGHING]</i>

4
00:00:20,100 --> 00:00:22,500
Say my name.
{\\an8}Heisenberg.
`

const VTT = `WEBVTT

NOTE a comment

intro
00:05.000 --> 00:07.500 line:0 position:50%
Hello &amp; welcome

01:00:01.000 --> 01:00:02.000
Late line
`

describe('parseSubtitles', () => {
  it('reads SubRip, dropping markup and the service advert', () => {
    const cues = parseSubtitles(SRT)
    expect(cues.map((c) => c.lines)).toEqual([
      ['[MOANING AND HEAVY BREATHING]'],
      ['[COUGHING]'],
      ['Say my name.', 'Heisenberg.'],
    ])
    expect(cues[0]).toMatchObject({ start: 3.037, end: 4.837 })
  })

  it('reads WebVTT: short times, cue ids, settings, notes and entities', () => {
    const cues = parseSubtitles(VTT)
    expect(cues).toEqual([
      { start: 5, end: 7.5, lines: ['Hello & welcome'] },
      { start: 3601, end: 3602, lines: ['Late line'] },
    ])
  })

  it("drops the file maker's credits and release names, and keeps dialogue that is close", () => {
    const credits = `1
00:00:01,000 --> 00:00:05,000
Subs collected, corrected and if necessary adapted by TRONAR for
"Breaking Bad Season 1, 2, 3, 4 & 5 + Extras BDRip DVDRip HDTV TSV"

2
00:00:06,000 --> 00:00:08,000
Synced and corrected by someone

3
00:00:09,000 --> 00:00:11,000
I stand corrected.

4
00:00:12,000 --> 00:00:14,000
We synced the files by hand.
`
    expect(parseSubtitles(credits).map((c) => c.lines)).toEqual([['I stand corrected.'], ['We synced the files by hand.']])
  })

  it('takes Windows line endings', () => {
    expect(parseSubtitles(SRT.replace(/\n/g, '\r\n'))).toHaveLength(3)
  })
})

describe('cuesAt', () => {
  const cues = parseSubtitles(SRT)

  it('shows a cue while it lasts and nothing between cues', () => {
    expect(cuesAt(cues, 4)).toEqual(['[MOANING AND HEAVY BREATHING]'])
    expect(cuesAt(cues, 5)).toEqual([])
    expect(cuesAt(cues, 21)).toEqual(['Say my name.', 'Heisenberg.'])
    expect(cuesAt(cues, 0)).toEqual([])
    expect(cuesAt(cues, 9_999)).toEqual([])
  })

  it('shows overlapping cues together, in order', () => {
    const overlapping = [
      { start: 1, end: 10, lines: ['A'] },
      { start: 2, end: 3, lines: ['B'] },
    ]
    expect(cuesAt(overlapping, 2.5)).toEqual(['A', 'B'])
  })
})
