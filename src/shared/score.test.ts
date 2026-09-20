import { describe, expect, it } from 'vitest'
import { formatScore, hasScore, seasonScore } from './score'

describe('hasScore', () => {
  /**
   * The case this exists for. TMDB reports 0 for anything nobody has rated,
   * and drawing that as "0.0" reads as *rated, and terrible* rather than
   * *not rated* — which is a confident lie about every unaired episode.
   */
  it('treats zero as no score rather than a bad one', () => {
    expect(hasScore(0)).toBe(false)
  })

  it('accepts a real score', () => {
    expect(hasScore(0.1)).toBe(true)
    expect(hasScore(8.4)).toBe(true)
  })

  it('rejects absent and nonsense values', () => {
    expect(hasScore(null)).toBe(false)
    expect(hasScore(undefined)).toBe(false)
    expect(hasScore(Number.NaN)).toBe(false)
    expect(hasScore(Number.POSITIVE_INFINITY)).toBe(false)
    expect(hasScore(-3)).toBe(false)
  })
})

describe('formatScore', () => {
  it('always shows one decimal, so a column of scores lines up', () => {
    expect(formatScore(8)).toBe('8.0')
    expect(formatScore(7.25)).toBe('7.3')
    expect(formatScore(10)).toBe('10.0')
  })
})

describe('seasonScore', () => {
  it('averages the episodes', () => {
    expect(seasonScore([{ rating: 8 }, { rating: 9 }])).toBe(8.5)
  })

  /**
   * A currently-airing season accumulates unaired episodes at 0. Counting them
   * would drag its score down a little more every week, which looks like the
   * season getting worse as it airs.
   */
  it('ignores episodes nobody has rated instead of counting them as zero', () => {
    expect(seasonScore([{ rating: 8 }, { rating: 9 }, { rating: 0 }, { rating: 0 }])).toBe(8.5)
  })

  it('reports no score when nothing has been rated', () => {
    expect(seasonScore([{ rating: 0 }, { rating: 0 }])).toBe(0)
    expect(seasonScore([])).toBe(0)
  })
})
