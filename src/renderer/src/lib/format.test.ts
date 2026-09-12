import { describe, expect, it } from 'vitest'
import { airDate, countdown, episodeCode, hasAired, runtime, timeAgo, year } from './format'

/**
 * These are the strings the user actually reads. They are worth testing because
 * every one of them has an edge case that renders as visible nonsense — a
 * countdown that says "NaNd", a code that says "SundefinedE1" — rather than
 * failing anywhere a stack trace would appear.
 */

describe('episodeCode', () => {
  it('zero-pads so a column of codes aligns', () => {
    expect(episodeCode(1, 1)).toBe('S01E01')
    expect(episodeCode(12, 7)).toBe('S12E07')
  })

  it('does not truncate past two digits', () => {
    expect(episodeCode(2, 143)).toBe('S02E143')
  })
})

describe('year', () => {
  it('extracts the year from a TMDB date', () => {
    expect(year('2024-03-12')).toBe('2024')
  })

  it('returns an empty string for missing dates rather than "undefined"', () => {
    expect(year(null)).toBe('')
    expect(year(undefined)).toBe('')
  })
})

describe('airDate', () => {
  it('formats a real date', () => {
    // Locale-dependent, so assert the parts rather than an exact string.
    const formatted = airDate('2024-03-12')
    expect(formatted).toMatch(/2024/)
    expect(formatted).toMatch(/12/)
  })

  it('returns empty for null and for junk', () => {
    expect(airDate(null)).toBe('')
    expect(airDate('not a date')).toBe('')
  })
})

describe('runtime', () => {
  it('formats hours and minutes', () => {
    expect(runtime(82)).toBe('1h 22m')
    expect(runtime(120)).toBe('2h')
    expect(runtime(47)).toBe('47m')
  })

  it('returns empty rather than "0m" when TMDB has no runtime', () => {
    expect(runtime(null)).toBe('')
    expect(runtime(0)).toBe('')
  })
})

describe('countdown', () => {
  const now = new Date('2026-06-10T12:00:00Z').getTime()

  it('counts days and hours out', () => {
    // Air dates are midnight-local, so assert the shape rather than an exact
    // figure that would move with the runner's timezone.
    expect(countdown('2026-06-15', now)).toMatch(/^\d+d \d+h$/)
  })

  it('drops to hours and minutes inside a day', () => {
    expect(countdown('2026-06-11', now)).toMatch(/^\d+h \d+m$|^\d+m$/)
  })

  it('says it is airing once the date has passed', () => {
    expect(countdown('2026-06-01', now)).toBe('Airing now')
  })

  it('returns empty for a missing or unparseable date', () => {
    expect(countdown(null, now)).toBe('')
    expect(countdown('soon', now)).toBe('')
  })
})

describe('timeAgo', () => {
  const now = new Date('2026-06-10T12:00:00Z').getTime()

  it('describes recent times in words', () => {
    expect(timeAgo(now - 30_000, now)).toBe('just now')
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5m ago')
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(timeAgo(now - 4 * 86_400_000, now)).toBe('4d ago')
  })

  it('falls back to an absolute date beyond a week', () => {
    expect(timeAgo(now - 30 * 86_400_000, now)).toMatch(/\d/)
    expect(timeAgo(now - 30 * 86_400_000, now)).not.toMatch(/ago/)
  })
})

describe('hasAired', () => {
  const now = new Date('2026-06-10T12:00:00Z').getTime()

  it('is true for past dates and false for future ones', () => {
    expect(hasAired('2026-06-01', now)).toBe(true)
    expect(hasAired('2026-12-01', now)).toBe(false)
  })

  it('treats a missing date as not aired', () => {
    // TMDB leaves air_date null for announced-but-unscheduled episodes, and
    // those must not be clickable.
    expect(hasAired(null, now)).toBe(false)
  })
})
