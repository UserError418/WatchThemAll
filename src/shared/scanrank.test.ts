/**
 * The two helpers the source pickers use to present a scan.
 *
 * `providerRank` and `providerDot` are covered in `providerscan.test.ts`
 * alongside the order they produce. These two are presentation, but each has a
 * way of being wrong that renders as quiet nonsense rather than an error: a
 * provider missing from the list, or a time that reads "10.0 s".
 */

import { describe, expect, it } from 'vitest'
import { formatStreamTime, inScanOrder, normalizeSourceOrder, ordinal, resumeNote } from './scanrank'

const rows = (...ids: string[]): Array<{ id: string }> => ids.map((id) => ({ id }))
const ids = (items: Array<{ id: string }>): string[] => items.map((item) => item.id)

describe('inScanOrder', () => {
  it('lists the rows in the order given', () => {
    expect(ids(inScanOrder(rows('a', 'b', 'c'), ['c', 'a', 'b']))).toEqual(['c', 'a', 'b'])
  })

  it('keeps rows the order does not mention, after the rest, in their own order', () => {
    // A provider enabled a moment ago, before the next state arrives, must still
    // be listed rather than vanish from the menu.
    expect(ids(inScanOrder(rows('new1', 'a', 'new2', 'b'), ['b', 'a']))).toEqual([
      'b',
      'a',
      'new1',
      'new2',
    ])
  })

  it('ignores ids in the order that are not rows', () => {
    // Automatic's order covers every enabled provider; the player's menu lists
    // only the candidates that could serve this title.
    expect(ids(inScanOrder(rows('a', 'b'), ['gone', 'b', 'a']))).toEqual(['b', 'a'])
  })

  it('leaves the rows alone when there is no order yet', () => {
    expect(ids(inScanOrder(rows('a', 'b', 'c'), []))).toEqual(['a', 'b', 'c'])
  })

  it('does not reorder the array it was given', () => {
    const original = rows('a', 'b')
    inScanOrder(original, ['b', 'a'])
    expect(ids(original)).toEqual(['a', 'b'])
  })
})

describe('formatStreamTime', () => {
  it.each([
    [2_300, '2.3 s'],
    [3_840, '3.8 s'],
    [14_800, '15 s'],
    [18_000, '18 s'],
  ])('%i ms reads as %s', (ms, text) => {
    expect(formatStreamTime(ms)).toBe(text)
  })

  it('rounds before choosing a format, so nothing reads "10.0 s"', () => {
    expect(formatStreamTime(9_960)).toBe('10 s')
    expect(formatStreamTime(9_940)).toBe('9.9 s')
  })

  it('never claims a measured stream took no time', () => {
    expect(formatStreamTime(0)).toBe('0.1 s')
    expect(formatStreamTime(20)).toBe('0.1 s')
  })
})

describe('normalizeSourceOrder', () => {
  it('keeps a valid order as it is', () => {
    expect(normalizeSourceOrder(['speed', 'quality', 'list'])).toEqual(['speed', 'quality', 'list'])
  })

  it('completes a partial order in the default priority', () => {
    expect(normalizeSourceOrder(['quality'])).toEqual(['quality', 'list', 'speed'])
  })

  it('drops keys it does not know and keeps each known key once', () => {
    // A newer version's key, a typo, a duplicate: none may leave a gap.
    expect(normalizeSourceOrder(['bitrate', 'speed', 'speed', 3])).toEqual(['speed', 'list', 'quality'])
  })

  it('falls back to the default for anything that is not a list', () => {
    expect(normalizeSourceOrder(undefined)).toEqual(['list', 'speed', 'quality'])
    expect(normalizeSourceOrder('speed')).toEqual(['list', 'speed', 'quality'])
  })
})

describe('resumeNote', () => {
  it('says where the resume source moved up from, 1-based as people count', () => {
    expect(resumeNote({ providerId: 'c', movedFrom: 2 }).label).toBe('resume · was 3rd')
  })

  it('says only "resume" when it was first anyway', () => {
    expect(resumeNote({ providerId: 'a', movedFrom: null }).label).toBe('resume')
  })
})

describe('ordinal', () => {
  it('handles the endings, teens included', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th',
    ])
  })
})
