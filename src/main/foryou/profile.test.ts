import { describe, expect, it } from 'vitest'
import { buildProfile, MIN_LANE_TITLES, tasteSources } from './profile'
import { library, NOW, rated, saved, seen, store, wideLibrary } from './testing'

const ids = (ts: ReadonlyArray<{ tmdbId: number }>) => ts.map((t) => t.tmdbId).sort((a, b) => a - b)

describe('buildProfile lanes', () => {
  it('gives each lane its own titles', () => {
    const { lanes } = buildProfile(wideLibrary(), NOW)
    expect(ids(lanes.anime.titles)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(ids(lanes.series.titles)).toEqual([11, 12, 13, 14, 15])
    expect(ids(lanes.films.titles)).toEqual([21, 22, 23, 24, 31, 32, 33])
  })

  it("scores a lane by its own genres, so anime's Drama is not live action's", () => {
    const { lanes } = buildProfile(wideLibrary(), NOW)
    expect(lanes.series.borrowed).toBe(false)
    // Crime is a series taste only; Animation an anime one.
    expect(lanes.series.fit.get(80)).toBeGreaterThan(0)
    expect(lanes.anime.fit.has(80)).toBe(false)
    expect(lanes.series.fit.has(16)).toBe(false)
  })

  it('shares the liking out across the lanes', () => {
    const { lanes } = buildProfile(wideLibrary(), NOW)
    expect(lanes.anime.share + lanes.series.share + lanes.films.share).toBeCloseTo(1)
    expect(lanes.anime.share).toBeGreaterThan(lanes.series.share)
    expect(lanes.series.share).toBeGreaterThan(lanes.films.share)
  })

  it(`borrows a thin lane's genre taste: fewer than ${MIN_LANE_TITLES} liked titles`, () => {
    // library(): two liked series, no films, three anime.
    const { lanes } = buildProfile(library(), NOW)
    expect(lanes.series.borrowed).toBe(true)
    expect(lanes.films.borrowed).toBe(true)
    expect(lanes.anime.borrowed).toBe(true)
    // Films borrow from series: Crime, from title 3.
    expect(lanes.films.fit.get(80)).toBeGreaterThan(0)
    // Anime borrows from everything, itself included.
    expect(lanes.anime.fit.get(10759)).toBeGreaterThan(0)
    expect(lanes.anime.fit.get(80)).toBeGreaterThan(0)
    // Its titles, and so its seeds, stay its own.
    expect(ids(lanes.films.titles)).toEqual([])
    expect(lanes.films.share).toBe(0)
  })

  it('keeps the film share of anime between a fifth and four-fifths', () => {
    const onlySeries = buildProfile(wideLibrary(), NOW).lanes.anime
    expect(onlySeries.filmShare).toBe(0.2)

    const onlyFilms = buildProfile(store({
      ratings: [1, 2, 3, 4].map((id) => rated(id, 9, [16], { type: 'movie' })),
      watched: [1, 2, 3, 4].map((id) => seen(id, [16], 'movie')),
    }), NOW).lanes.anime
    expect(onlyFilms.filmShare).toBe(0.8)

    expect(buildProfile(store(), NOW).lanes.anime.filmShare).toBe(0.5)
  })

  it('takes the looked-up lanes over the guess, and guesses the rest', () => {
    // Title 2 is animation added by hand, so a guess puts it in series.
    const s = store({
      ratings: [rated(1, 9, [16]), rated(2, 9, [16]), rated(3, 9, [18])],
      watched: [seen(1, [16]), seen(2, [16], 'tv', 'user'), seen(3, [18], 'tv', 'user')],
    })
    expect(buildProfile(s, NOW).laneOf.get('tv:2')).toBe('series')
    const looked = buildProfile(s, NOW, new Map([['tv:2', 'anime' as const]]))
    expect(looked.laneOf.get('tv:2')).toBe('anime')
    expect(looked.laneOf.get('tv:1')).toBe('anime')
    expect(looked.laneOf.get('tv:3')).toBe('series')
  })
})

describe('tasteSources', () => {
  it("is a lane's own titles when it has enough", () => {
    const profile = buildProfile(wideLibrary(), NOW)
    expect(ids(tasteSources(profile, 'series'))).toEqual([11, 12, 13, 14, 15])
  })

  it('is what a thin lane borrows from', () => {
    const profile = buildProfile(library(), NOW)
    expect(ids(tasteSources(profile, 'films'))).toEqual([3, 4, 6, 7])
  })

  it('is nothing for a thin anime lane: live action says nothing of anime themes', () => {
    expect(tasteSources(buildProfile(library(), NOW), 'anime')).toEqual([])
  })
})

describe('the watchlist', () => {
  it('is newest first, and leaves out entries without a TMDB id', () => {
    const profile = buildProfile(store({
      watchlist: [saved(1, [18], 100), saved(2, [18], 300), saved(0, [18], 400), saved(3, [18], 200, 'movie')],
    }), NOW)
    expect(profile.watchlist.map((w) => `${w.type}:${w.tmdbId}`)).toEqual(['tv:2', 'movie:3', 'tv:1'])
  })
})
