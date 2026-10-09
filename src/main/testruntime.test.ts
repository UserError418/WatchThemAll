import { describe, expect, it } from 'vitest'
import type { Season } from '@shared/types'
import { testRuntime } from './testruntime'

/** A season listing as TMDB gives it, with each episode's runtime where it has one. */
const season = (runtimes: Array<number | null>): Season => ({
  season: 1,
  name: 'Season 1',
  episodes: runtimes.map((runtime, i) => ({
    season: 1,
    episode: i + 1,
    name: `E${i + 1}`,
    airDate: '2020-01-01',
    overview: '',
    stillPath: null,
    runtime,
    rating: 0,
  })),
})

describe('testRuntime', () => {
  const tmdb = (listing: Season | null) => ({
    season: async () => {
      if (listing === null) throw new Error('TMDB is down')
      return listing
    },
  })

  it("takes the episode's own runtime: a double-length finale is still the title", async () => {
    expect(await testRuntime(tmdb(season([45, 45, 90])), 1, 45, { season: 1, episode: 3 })).toBe(90)
  })

  it("falls back on the show's when TMDB has none for the episode, or cannot answer", async () => {
    expect(await testRuntime(tmdb(season([45, null])), 1, 44, { season: 1, episode: 2 })).toBe(44)
    expect(await testRuntime(tmdb(season([45])), 1, 44, { season: 1, episode: 7 })).toBe(44)
    expect(await testRuntime(tmdb(null), 1, 44, { season: 1, episode: 1 })).toBe(44)
  })

  it("is a film's own, and nothing when TMDB gives nothing", async () => {
    expect(await testRuntime(tmdb(null), 550, 139, null)).toBe(139)
    expect(await testRuntime(tmdb(season([0])), 1, null, { season: 1, episode: 1 })).toBeNull()
    expect(await testRuntime(tmdb(null), 550, 0, null)).toBeNull()
  })
})
