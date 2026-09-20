import { describe, expect, it } from 'vitest'
import type { Rating, WatchedEntry } from '@shared/types'
import { groupWatched, leaning, summarise, tallyLabel } from './watchedgroups'

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
function ratings(map: Record<string, Rating>) {
  return (e: WatchedEntry): Rating | null => map[`${e.tmdbId}:${e.season}`] ?? null
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

  it('tallies the ratings across seasons', () => {
    const groups = groupWatched(
      [entry({ season: 1 }), entry({ season: 2 }), entry({ season: 3 })],
      ratings({ '1396:1': 'like', '1396:2': 'like', '1396:3': 'dislike' }),
    )
    expect(groups[0]).toMatchObject({ likes: 2, dislikes: 1, unrated: 0 })
  })

  /**
   * The tally counts what is on screen. Under the "Unrated" filter a row
   * should say how many of its seasons still need an opinion, not how many it
   * has in total — so the caller filters first and this counts the remainder.
   */
  it('counts only the entries it was given', () => {
    const groups = groupWatched([entry({ season: 3 })], none)
    expect(groups[0]).toMatchObject({ unrated: 1, likes: 0 })
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

describe('tallyLabel', () => {
  it('states what is known and omits what is zero', () => {
    expect(tallyLabel({ likes: 18, dislikes: 2, unrated: 0 })).toBe('18 liked · 2 disliked')
    expect(tallyLabel({ likes: 0, dislikes: 0, unrated: 3 })).toBe('3 unrated')
  })

  it('says nothing when there is nothing to say', () => {
    expect(tallyLabel({ likes: 0, dislikes: 0, unrated: 0 })).toBe('')
  })
})

describe('leaning', () => {
  it('reports the majority opinion', () => {
    expect(leaning({ likes: 5, dislikes: 1 })).toBe('like')
    expect(leaning({ likes: 1, dislikes: 5 })).toBe('dislike')
  })

  /**
   * A split series is not "liked". Tinting it either colour would assert
   * something the tally printed beside it contradicts.
   */
  it('reports nothing on a tie', () => {
    expect(leaning({ likes: 3, dislikes: 3 })).toBeNull()
    expect(leaning({ likes: 0, dislikes: 0 })).toBeNull()
  })
})

describe('summarise', () => {
  it('counts titles and seasons separately, which is the point', () => {
    const groups = groupWatched(
      [entry({ tmdbId: 1, season: 1 }), entry({ tmdbId: 1, season: 2 }), entry({ tmdbId: 2 })],
      ratings({ '1:1': 'like' }),
    )
    expect(summarise(groups)).toEqual({ titles: 2, seasons: 3, likes: 1, dislikes: 0 })
  })

  it('handles an empty library', () => {
    expect(summarise([])).toEqual({ titles: 0, seasons: 0, likes: 0, dislikes: 0 })
  })
})
