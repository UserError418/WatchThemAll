/**
 * The pure half of the title-facts cache: what is kept from a TMDB detail,
 * when it goes stale, and that a damaged cache costs a refetch, not a crash.
 */

import { describe, expect, it } from 'vitest'
import type { MediaDetail } from '@shared/types'
import {
  FACTS_TTL_MS,
  factsFromDetail,
  isStale,
  parseFacts,
  serialiseFacts,
  type TitleFacts,
} from './titlefacts'

const NOW = 1_800_000_000_000

function detail(patch: Partial<MediaDetail>): MediaDetail {
  return {
    tmdbId: 1,
    type: 'tv',
    title: 'Silo',
    posterPath: '/p.jpg',
    backdropPath: '/b.jpg',
    overview: '',
    rating: 8,
    releaseDate: '2023-05-04',
    genreIds: [],
    imdbId: 'tt1',
    genres: ['Drama', 'Sci-Fi & Fantasy', 'Mystery', 'Thriller'],
    status: 'Returning Series',
    seasonCount: 3,
    episodeCount: 20,
    runtime: null,
    nextEpisode: null,
    lastEpisode: { season: 2, episode: 10, name: 'Into the Fire', airDate: '2025-01-17' },
    trailerKey: null,
    logoPath: '/logo.png',
    ...patch,
  }
}

describe('facts from a TMDB detail', () => {
  it('counts the seasons that have aired, not the ones announced', () => {
    // Renewed for a third season that has not started: two can have been watched.
    expect(factsFromDetail(detail({}), NOW)).toMatchObject({
      backdropPath: '/b.jpg',
      year: '2023',
      genres: ['Drama', 'Sci-Fi & Fantasy', 'Mystery'],
      airedSeasons: 2,
      runtime: null,
      at: NOW,
    })
  })

  it('falls back to the season count when TMDB gives no last episode', () => {
    expect(factsFromDetail(detail({ lastEpisode: null }), NOW).airedSeasons).toBe(3)
  })

  it('keeps a film its runtime and no seasons', () => {
    const film = factsFromDetail(detail({ type: 'movie', runtime: 155, lastEpisode: null }), NOW)
    expect(film).toMatchObject({ airedSeasons: null, runtime: 155 })
  })

  it('cuts a long synopsis at a word, with an ellipsis', () => {
    const long = 'word '.repeat(200)
    const overview = factsFromDetail(detail({ overview: long }), NOW).overview
    expect(overview.length).toBeLessThanOrEqual(321)
    expect(overview.endsWith('word…')).toBe(true)
  })

  it('keeps the logo, or its absence', () => {
    expect(factsFromDetail(detail({}), NOW).logoPath).toBe('/logo.png')
    expect(factsFromDetail(detail({ logoPath: null }), NOW).logoPath).toBeNull()
  })

  it('says nothing about a year it cannot read', () => {
    expect(factsFromDetail(detail({ releaseDate: null }), NOW).year).toBeNull()
    expect(factsFromDetail(detail({ releaseDate: '' }), NOW).year).toBeNull()
  })
})

describe('the stored cache', () => {
  const facts = (at: number): TitleFacts => ({
    backdropPath: null,
    logoPath: null,
    year: null,
    genres: [],
    status: '',
    airedSeasons: null,
    runtime: null,
    overview: '',
    at,
  })

  it('goes stale after a week', () => {
    expect(isStale(facts(NOW - FACTS_TTL_MS + 1), NOW)).toBe(false)
    expect(isStale(facts(NOW - FACTS_TTL_MS - 1), NOW)).toBe(true)
  })

  it('round-trips, keeping the most recently fetched when over the limit', () => {
    const map = new Map([
      ['tv:1', facts(NOW - 3)],
      ['tv:2', facts(NOW - 1)],
      ['tv:3', facts(NOW - 2)],
    ])
    const back = parseFacts(serialiseFacts(map, 2))
    expect([...back.keys()].sort()).toEqual(['tv:2', 'tv:3'])
  })

  it('reads a damaged or foreign value as empty', () => {
    expect(parseFacts('{not json').size).toBe(0)
    expect(parseFacts('[1,2]').size).toBe(0)
    expect(parseFacts(null).size).toBe(0)
    expect(parseFacts(JSON.stringify({ 'tv:1': { at: 'yesterday' } })).size).toBe(0)
  })

  it('drops a record from before logos, so its card fetches one', () => {
    const v1: Partial<TitleFacts> = facts(NOW)
    delete v1.logoPath
    expect(parseFacts(JSON.stringify({ 'tv:1': v1 })).size).toBe(0)
    expect(parseFacts(JSON.stringify({ 'tv:1': facts(NOW) })).size).toBe(1)
  })
})
