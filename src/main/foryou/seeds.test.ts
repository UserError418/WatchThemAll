import { describe, expect, it } from 'vitest'
import { conceptAffinity, titleAffinity, titleNames } from '../taste'
import { becauseCandidates, becauseVerb, genreShelves, shelfSeeds, topPickSeeds } from './seeds'
import { DAY, library, NOW, played, rated, saved, seen, store } from './testing'

describe('topPickSeeds', () => {
  it('takes the strongest titles, but not several of the same kind first', () => {
    const titles = titleAffinity(store({
      ratings: [
        rated(1, 10, [16, 10759]),
        rated(2, 10, [16, 10759]),
        rated(3, 10, [16, 10759]),
        rated(4, 9, [80, 18]),
        rated(5, 4, [35]),
      ],
    }), NOW)
    expect(topPickSeeds(titles, 2).map((s) => s.tmdbId)).toContain(4)
  })

  it('is empty for a library with nothing positive in it', () => {
    expect(topPickSeeds(titleAffinity(store(), NOW))).toEqual([])
  })
})

describe('becauseCandidates', () => {
  const titles = titleAffinity(library(), NOW)
  const names = titleNames(library())
  const head = (seed: number) => becauseCandidates(titles, names, seed, NOW).slice(0, 3).map((t) => t.tmdbId).join()

  it('is stable for one session seed and rotates across sessions', () => {
    expect(head(42)).toBe(head(42))
    expect(new Set(Array.from({ length: 30 }, (_, s) => head(s))).size).toBeGreaterThan(3)
  })

  it('favours what the user watched recently', () => {
    // Two equal favourites; one was played yesterday, one a year ago.
    const s = store({
      ratings: [rated(1, 9, [16]), rated(2, 9, [80]), rated(3, 5, [35]), rated(4, 6, [35])],
      watched: [seen(1), seen(2)],
      history: [played(1, 60, NOW - DAY), played(2, 60, NOW - 365 * DAY)],
    })
    const recentTitles = titleAffinity(s, NOW)
    let recent = 0
    for (let seed = 0; seed < 200; seed += 1) {
      if (becauseCandidates(recentTitles, titleNames(s), seed, NOW)[0]?.tmdbId === 1) recent += 1
    }
    expect(recent).toBeGreaterThan(110)
  })

  it('never claims "because you watched" about something only saved', () => {
    const s = store({ watchlist: [saved(1)] })
    expect(becauseCandidates(titleAffinity(s, NOW), titleNames(s), 1, NOW)).toEqual([])
  })
})

describe('becauseVerb', () => {
  const at = (value: number, coarse: boolean) =>
    ({ verdict: { value, coarse } }) as Parameters<typeof becauseVerb>[0]

  it('says loved only for a 9 or 10 actually chosen on the scale', () => {
    expect(becauseVerb(at(10, false))).toBe('loved')
    expect(becauseVerb(at(8, true))).toBe('liked')
    expect(becauseVerb(at(8, false))).toBe('liked')
    expect(becauseVerb(at(7, false))).toBe('watched')
    expect(becauseVerb({ verdict: null } as Parameters<typeof becauseVerb>[0])).toBe('watched')
  })
})

describe('genreShelves', () => {
  const { singles, pairs } = conceptAffinity(titleAffinity(store({
    ratings: [
      ...Array.from({ length: 6 }, (_, i) => rated(i + 1, 10, [16, 10759])),
      ...Array.from({ length: 6 }, (_, i) => rated(i + 20, 10, [16, 10765])),
      ...Array.from({ length: 6 }, (_, i) => rated(i + 40, 10, [16, 35])),
      ...Array.from({ length: 3 }, (_, i) => rated(i + 60, 8, [80])),
      rated(99, 3, [10749]),
    ],
  }), NOW))

  it('does not let one genre take over every shelf', () => {
    const shelves = genreShelves(singles, pairs, 8)
    expect(shelves.filter((sh) => sh.concepts.includes(16)).length).toBeLessThanOrEqual(2)
    expect(shelves.filter((sh) => sh.concepts.length > 1).length).toBeLessThanOrEqual(2)
  })

  it('stops at the limit', () => {
    expect(genreShelves(singles, pairs, 2)).toHaveLength(2)
  })

  it('leaves out a concept the lane cannot show, alone or in a pair', () => {
    const shelves = genreShelves(singles, pairs, 8, (c) => c !== 16)
    expect(shelves.length).toBeGreaterThan(0)
    expect(shelves.some((sh) => sh.concepts.includes(16))).toBe(false)
  })
})

describe('shelfSeeds', () => {
  it('takes only favourites carrying every genre of the shelf', () => {
    const titles = titleAffinity(store({
      ratings: [rated(1, 10, [16, 10759]), rated(2, 10, [16]), rated(3, 9, [10759, 16, 18]), rated(4, 3, [16, 10759])],
    }), NOW)
    expect(shelfSeeds(titles, [16, 10759]).map((t) => t.tmdbId).sort()).toEqual([1, 3])
  })
})
