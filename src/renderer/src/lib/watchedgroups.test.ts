import { describe, expect, it } from 'vitest'
import type { RatingValue, WatchedEntry } from '@shared/types'
import {
  bandOf,
  deepest,
  formatMean,
  groupWatched,
  leaning,
  ribbon,
  summarise,
  summaryLabel,
} from './watchedgroups'

let seq = 0
function entry(over: Partial<WatchedEntry> = {}): WatchedEntry {
  seq += 1
  return {
    id: `w${seq}`,
    tmdbId: 1396,
    type: 'tv',
    season: 1,
    title: 'Breaking Bad',
    posterPath: '/bb.jpg',
    imdbId: 'tt0903747',
    genreIds: [18],
    rating: 8.9,
    addedAt: 1000,
    source: 'user',
    malId: null,
    ...over,
  }
}

/** Ratings supplied by key `${tmdbId}:${season}`, matching the scope rule. */
function ratings(map: Record<string, RatingValue>) {
  return (e: WatchedEntry): RatingValue | null => map[`${e.tmdbId}:${e.season}`] ?? null
}

const none = () => null

describe('groupWatched', () => {
  it('folds the seasons of one series into a single group', () => {
    const groups = groupWatched(
      [entry({ season: 1 }), entry({ season: 2 }), entry({ season: 3 })],
      none,
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.seasons.map((s) => s.entry.season)).toEqual([3, 2, 1])
    expect(groups[0]?.flat).toBe(false)
  })

  it('keeps different titles apart', () => {
    const groups = groupWatched(
      [entry({ tmdbId: 1396 }), entry({ tmdbId: 2316, title: 'The Office' })],
      none,
    )
    expect(groups).toHaveLength(2)
  })

  /**
   * The case that would silently corrupt the view: every import that never
   * resolved carries tmdbId 0, so grouping on that field alone would claim
   * they are one series with a season each.
   */
  it('does not merge unresolved imports, which all share tmdbId 0', () => {
    const groups = groupWatched(
      [
        entry({ tmdbId: 0, title: 'Slime 2nd Season', season: null }),
        entry({ tmdbId: 0, title: 'Something Else', season: null }),
      ],
      none,
    )
    expect(groups).toHaveLength(2)
    expect(new Set(groups.map((g) => g.key)).size).toBe(2)
  })

  it('marks a film as flat, with nothing to expand', () => {
    const groups = groupWatched([entry({ type: 'movie', season: null })], none)
    expect(groups[0]?.flat).toBe(true)
  })

  it('marks a single-season series as flat too', () => {
    expect(groupWatched([entry({ season: 4 })], none)[0]?.flat).toBe(true)
  })

  /** A 1.5.8 survivor: no season TMDB could name. It sorts last of its group. */
  it('sorts a legacy whole-series entry after the numbered seasons', () => {
    const groups = groupWatched([entry({ season: null }), entry({ season: 2 })], none)
    expect(groups[0]?.seasons.map((s) => s.entry.season)).toEqual([2, null])
  })

  it('counts the seasons in each band', () => {
    const groups = groupWatched(
      [entry({ season: 1 }), entry({ season: 2 }), entry({ season: 3 }), entry({ season: 4 })],
      ratings({ '1396:1': 9, '1396:2': 8, '1396:3': 6, '1396:4': 2 }),
    )
    expect(groups[0]).toMatchObject({ liked: 2, mixed: 1, disliked: 1, unrated: 0 })
  })

  it('averages the rated seasons, leaving the unrated ones out', () => {
    const groups = groupWatched(
      [entry({ season: 1 }), entry({ season: 2 }), entry({ season: 3 })],
      ratings({ '1396:1': 9, '1396:2': 6 }),
    )
    // (9 + 6) / 2, not (9 + 6 + 0) / 3: an unrated season is not a zero.
    expect(groups[0]?.mean).toBe(7.5)
    expect(groups[0]?.unrated).toBe(1)
  })

  /** A zero would read as a verdict; nothing rated means no mean at all. */
  it('has no mean when nothing is rated', () => {
    expect(groupWatched([entry({ season: 1 })], none)[0]?.mean).toBeNull()
  })

  /**
   * The tally counts what is on screen. Under the "Unrated" filter a row
   * should say how many of its seasons still need an opinion, not how many it
   * has in total — so the caller filters first and this counts the remainder.
   */
  it('counts only the entries it was given', () => {
    const groups = groupWatched([entry({ season: 3 })], none)
    expect(groups[0]).toMatchObject({ unrated: 1, liked: 0 })
    expect(groups[0]?.seasons).toHaveLength(1)
  })

  it('takes artwork and score from whichever season carries them', () => {
    const groups = groupWatched(
      [entry({ season: 1, posterPath: null, rating: 0 }), entry({ season: 2, rating: 8.9 })],
      none,
    )
    expect(groups[0]?.posterPath).toBe('/bb.jpg')
    expect(groups[0]?.score).toBe(8.9)
  })

  it('flags a title any season of which was imported', () => {
    const groups = groupWatched(
      [entry({ season: 1, source: 'user' }), entry({ season: 2, source: 'mal' })],
      none,
    )
    expect(groups[0]?.imported).toBe(true)
  })

  it('takes the newest addedAt across the seasons', () => {
    const groups = groupWatched(
      [entry({ season: 1, addedAt: 10 }), entry({ season: 2, addedAt: 99 })],
      none,
    )
    expect(groups[0]?.addedAt).toBe(99)
  })
})

describe('groupWatched sorting', () => {
  const library = () => [
    entry({ tmdbId: 1, title: 'Zulu', season: 1, addedAt: 300, rating: 6 }),
    entry({ tmdbId: 2, title: 'Alpha', season: 1, addedAt: 100, rating: 9 }),
    entry({ tmdbId: 2, title: 'Alpha', season: 2, addedAt: 200, rating: 9 }),
  ]

  it('sorts by most recent by default', () => {
    expect(groupWatched(library(), none, 'recent').map((g) => g.title)).toEqual(['Zulu', 'Alpha'])
  })

  it('sorts alphabetically', () => {
    expect(groupWatched(library(), none, 'title').map((g) => g.title)).toEqual(['Alpha', 'Zulu'])
  })

  it('sorts by season count', () => {
    expect(groupWatched(library(), none, 'seasons').map((g) => g.title)).toEqual(['Alpha', 'Zulu'])
  })

  it('sorts by score', () => {
    expect(groupWatched(library(), none, 'score').map((g) => g.title)).toEqual(['Alpha', 'Zulu'])
  })

  /**
   * A library whose long tail is all one-season titles would otherwise
   * reshuffle on every render, because the primary key ties for hundreds of
   * rows and nothing settles it.
   */
  it('breaks every tie on the title, so the order is stable', () => {
    const tied = [
      entry({ tmdbId: 1, title: 'Beta', season: 1, addedAt: 5, rating: 7 }),
      entry({ tmdbId: 2, title: 'Alpha', season: 1, addedAt: 5, rating: 7 }),
    ]
    for (const sort of ['recent', 'seasons', 'score'] as const) {
      expect(groupWatched(tied, none, sort).map((g) => g.title)).toEqual(['Alpha', 'Beta'])
    }
  })
})

describe('summaryLabel', () => {
  it('states the mean to one decimal and what is still unrated', () => {
    expect(summaryLabel({ mean: 7.75, unrated: 0 })).toBe('avg 7.8')
    expect(summaryLabel({ mean: 8, unrated: 2 })).toBe('avg 8.0 · 2 unrated')
    expect(summaryLabel({ mean: null, unrated: 3 })).toBe('3 unrated')
  })

  it('says nothing when there is nothing to say', () => {
    expect(summaryLabel({ mean: null, unrated: 0 })).toBe('')
  })
})

describe('formatMean', () => {
  /** One decimal always, so an 8 and a 7.5 are visibly different numbers. */
  it('prints one decimal', () => {
    expect(formatMean(8)).toBe('8.0')
    expect(formatMean(7.45)).toBe('7.5')
  })
})

describe('bandOf', () => {
  it('bands a rating and leaves an unrated season unbanded', () => {
    expect(bandOf(9)).toBe('liked')
    expect(bandOf(7)).toBe('mixed')
    expect(bandOf(5)).toBe('disliked')
    expect(bandOf(null)).toBeNull()
  })
})

describe('leaning', () => {
  it('tints by the band the mean rounds into', () => {
    expect(leaning({ mean: 8.4 })).toBe('liked')
    expect(leaning({ mean: 7.6 })).toBe('liked')
    expect(leaning({ mean: 7.4 })).toBe('mixed')
    expect(leaning({ mean: 3 })).toBe('disliked')
  })

  /**
   * The case the old majority vote could only answer with "no tint": a series
   * split between love and dislike. Its mean is in the middle, and the middle
   * is mixed.
   */
  it('reads a split series as mixed', () => {
    const groups = groupWatched(
      [entry({ season: 1 }), entry({ season: 2 })],
      ratings({ '1396:1': 9, '1396:2': 3 }),
    )
    expect(leaning(groups[0]!)).toBe('mixed')
  })

  it('reports nothing when nothing is rated', () => {
    expect(leaning({ mean: null })).toBeNull()
  })
})

describe('summarise', () => {
  it('counts titles and seasons separately, which is the point', () => {
    const groups = groupWatched(
      [entry({ tmdbId: 1, season: 1 }), entry({ tmdbId: 1, season: 2 }), entry({ tmdbId: 2 })],
      ratings({ '1:1': 8, '1:2': 6 }),
    )
    expect(summarise(groups)).toEqual({
      titles: 2,
      seasons: 3,
      liked: 1,
      mixed: 1,
      disliked: 0,
      unrated: 1,
    })
  })

  it('handles an empty library', () => {
    expect(summarise([])).toEqual({
      titles: 0, seasons: 0, liked: 0, mixed: 0, disliked: 0, unrated: 0,
    })
  })
})

describe('deepest', () => {
  it('finds the title with the most seasons', () => {
    const groups = groupWatched(
      [
        entry({ tmdbId: 1, title: 'Short', season: 1 }),
        entry({ tmdbId: 2, title: 'Long', season: 1 }),
        entry({ tmdbId: 2, title: 'Long', season: 2 }),
        entry({ tmdbId: 2, title: 'Long', season: 3 }),
      ],
      none,
    )
    expect(deepest(groups)?.title).toBe('Long')
  })

  /** A library of films and one-season shows has no such fact to report. */
  it('reports nothing when nothing has more than one season', () => {
    const groups = groupWatched([entry({ tmdbId: 1, season: 1 })], none)
    expect(deepest(groups)).toBeNull()
  })

  it('breaks a tie on the title, so the tile does not flicker', () => {
    const groups = groupWatched(
      [
        entry({ tmdbId: 1, title: 'Zulu', season: 1 }),
        entry({ tmdbId: 1, title: 'Zulu', season: 2 }),
        entry({ tmdbId: 2, title: 'Alpha', season: 1 }),
        entry({ tmdbId: 2, title: 'Alpha', season: 2 }),
      ],
      none,
    )
    expect(deepest(groups)?.title).toBe('Alpha')
  })

  it('handles an empty library', () => {
    expect(deepest([])).toBeNull()
  })
})

describe('ribbon', () => {
  /**
   * The expanded list runs newest first like every other list in the app; the
   * strip runs the other way, because a run of time that starts at the end is
   * a puzzle.
   */
  it('runs oldest first, the opposite way to the expanded list', () => {
    const groups = groupWatched(
      [entry({ season: 1 }), entry({ season: 2 }), entry({ season: 3 })],
      ratings({ '1396:1': 9, '1396:3': 4 }),
    )
    const strip = ribbon(groups[0]!)
    expect(strip.segments.map((s) => s.label)).toEqual(['Season 1', 'Season 2', 'Season 3'])
    expect(strip.segments.map((s) => s.rating)).toEqual([9, null, 4])
    expect(strip.hidden).toBe(0)
  })

  it('names a legacy whole-series entry rather than calling it a season', () => {
    const groups = groupWatched([entry({ season: null })], none)
    expect(ribbon(groups[0]!).segments[0]?.label).toBe('Whole series')
  })

  /** An opinion about season 19 says more than one about season 1. */
  it('keeps the recent seasons when there are more than fit', () => {
    const groups = groupWatched(
      Array.from({ length: 8 }, (_, i) => entry({ season: i + 1 })),
      none,
    )
    const strip = ribbon(groups[0]!, 3)
    expect(strip.segments.map((s) => s.label)).toEqual(['Season 6', 'Season 7', 'Season 8'])
    expect(strip.hidden).toBe(5)
  })
})
