import { describe, expect, it, vi } from 'vitest'
import { titleAffinity } from '../taste'
import { guessLanes, laneOf, laneQuery, libraryLanes } from './lanes'
import { NOW, rated, seen, store } from './testing'

describe('laneOf', () => {
  it('puts Japanese animation in anime, films included', () => {
    expect(laneOf({ type: 'tv', genreIds: [16, 18], originalLanguage: 'ja' })).toBe('anime')
    expect(laneOf({ type: 'movie', genreIds: [16], originalLanguage: 'ja' })).toBe('anime')
  })

  it('files other animation, and Japanese live action, by type', () => {
    // Arcane is a series like any other; Liar Game is a Japanese live-action drama.
    expect(laneOf({ type: 'tv', genreIds: [16, 10765], originalLanguage: 'en' })).toBe('series')
    expect(laneOf({ type: 'movie', genreIds: [16], originalLanguage: 'en' })).toBe('films')
    expect(laneOf({ type: 'tv', genreIds: [18], originalLanguage: 'ja' })).toBe('series')
  })

  it('does not call a title anime without knowing its language', () => {
    expect(laneOf({ type: 'tv', genreIds: [16] })).toBe('series')
  })
})

describe('libraryLanes', () => {
  const library = store({
    ratings: [
      rated(1, 9, [16, 10759]), // animated, from MAL
      rated(2, 9, [16, 10765]), // animated, added by hand
      rated(3, 8, [18]), // live action
      rated(4, 8, [28], { type: 'movie' }),
    ],
    watched: [seen(1, [16]), seen(2, [16], 'tv', 'user'), seen(3), seen(4, [28], 'movie')],
  })
  const titles = titleAffinity(library, NOW)

  it('asks TMDB only about animation that did not come from MyAnimeList', async () => {
    const language = vi.fn(async () => 'en')
    const lanes = await libraryLanes(titles, library, language, new Map())
    expect(language).toHaveBeenCalledTimes(1)
    expect(language).toHaveBeenCalledWith(2, 'tv')
    expect(lanes.get('tv:1')).toBe('anime')
    expect(lanes.get('tv:2')).toBe('series')
    expect(lanes.get('tv:3')).toBe('series')
    expect(lanes.get('movie:4')).toBe('films')
  })

  it('places a hand-added anime by its language', async () => {
    const lanes = await libraryLanes(titles, library, async () => 'ja', new Map())
    expect(lanes.get('tv:2')).toBe('anime')
  })

  it('falls back to the type when TMDB cannot say, and asks again next time', async () => {
    const cache = new Map<string, string>()
    const lanes = await libraryLanes(titles, library, async () => null, cache)
    expect(lanes.get('tv:2')).toBe('series')
    expect(cache.size).toBe(0)
  })

  it('remembers an answer, since a language never changes', async () => {
    const cache = new Map<string, string>()
    await libraryLanes(titles, library, async () => 'ja', cache)
    const language = vi.fn(async () => 'en')
    const lanes = await libraryLanes(titles, library, language, cache)
    expect(language).not.toHaveBeenCalled()
    expect(lanes.get('tv:2')).toBe('anime')
  })

  it('agrees with guessLanes on everything it did not look up', async () => {
    const guessed = guessLanes(titles, library)
    const looked = await libraryLanes(titles, library, async () => 'ja', new Map())
    for (const id of ['tv:1', 'tv:3', 'movie:4']) expect(looked.get(id)).toBe(guessed.get(id))
  })
})

describe('laneQuery', () => {
  it('asks for anime directly: Animation and the first genre alternative, in Japanese', () => {
    expect(laneQuery('anime', '878|14')).toEqual({ withGenres: '16,878', language: 'ja' })
    expect(laneQuery('anime', '')).toEqual({ withGenres: '16', language: 'ja' })
    // A pair shelf is already an AND, and stays one.
    expect(laneQuery('anime', '10759,10765', { minVotes: 5 })).toEqual({
      withGenres: '16,10759,10765',
      language: 'ja',
      minVotes: 5,
    })
  })

  it('leaves the other lanes to be filtered after', () => {
    expect(laneQuery('series', '10765')).toEqual({ withGenres: '10765' })
    expect(laneQuery('films', '', { withKeywords: '9' })).toEqual({ withKeywords: '9' })
  })
})
