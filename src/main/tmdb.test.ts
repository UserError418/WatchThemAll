/**
 * The choices `tmdb.ts` makes among what TMDB offers. The requests themselves
 * are not tested here; these are the rules that decide what the user sees.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { detail, detailOrNull, genres, keywords, pickLogo, search, trailer, type TmdbLogo } from './tmdb'

const logo = (file_path: string, iso_639_1: string | null, vote_average: number): TmdbLogo => ({
  file_path,
  iso_639_1,
  vote_average,
})

describe('pickLogo', () => {
  it('takes the best-voted English logo', () => {
    expect(
      pickLogo([logo('/fan.png', 'en', 2.1), logo('/official.png', 'en', 5.4), logo('/alt.png', 'en', 3.3)]),
    ).toBe('/official.png')
  })

  it('never takes a logo the user may not be able to read, however well voted', () => {
    expect(pickLogo([logo('/ja.png', 'ja', 9.9), logo('/en.png', 'en', 1)])).toBe('/en.png')
    expect(pickLogo([logo('/ja.png', 'ja', 9.9), logo('/none.png', null, 5)])).toBeNull()
  })

  it('says null rather than guessing when there is nothing', () => {
    expect(pickLogo([])).toBeNull()
    expect(pickLogo(undefined)).toBeNull()
  })
})

describe('the request cache', () => {
  // The cache is module state, so each test asks for something no other test does.
  const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)

  afterEach(() => {
    fetchMock.mockReset()
    vi.useRealTimers()
  })

  it('lets callers asking at once share one request', async () => {
    fetchMock.mockResolvedValue(answer({ genres: [{ id: 1, name: 'Drama' }] }))

    const [first, second] = await Promise.all([genres('movie'), genres('movie')])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
  })

  it('shares a failure, and does not keep it', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })

    const results = await Promise.allSettled([genres('tv'), genres('tv')])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockResolvedValueOnce(answer({ genres: [] }))
    await genres('tv')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("keeps a title's keywords for a day", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    fetchMock.mockResolvedValue(answer({ results: [{ id: 7, name: 'dystopia' }] }))

    await keywords(125988, 'tv')
    vi.setSystemTime(Date.now() + 11 * 60 * 1000)
    await keywords(125988, 'tv')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000)
    await keywords(125988, 'tv')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('still asks again after ten minutes for everything else', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    fetchMock.mockResolvedValue(answer({ results: [], page: 1, total_pages: 1, total_results: 0 }))

    await search('silo')
    vi.setSystemTime(Date.now() + 9 * 60 * 1000)
    await search('silo')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 2 * 60 * 1000)
    await search('silo')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  /** The detail answer carries the videos; a detailed card's preview needs no second request. */
  it('takes a trailer from a cached detail answer', async () => {
    const video = { key: 'abc', site: 'YouTube', type: 'Trailer', official: true }
    fetchMock.mockResolvedValue(answer({ id: 4242, name: 'Series', videos: { results: [video] } }))

    await detail(4242, 'tv')
    expect(await trailer(4242, 'tv')).toBe('abc')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('asks for the videos when the title was never detailed', async () => {
    fetchMock.mockResolvedValue(answer({ results: [{ key: 'xyz', site: 'YouTube', type: 'Teaser' }] }))

    expect(await trailer(4343, 'movie')).toBe('xyz')
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/movie/4343/videos')
  })

  it('answers null for a title TMDB does not know, and throws when it cannot ask', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
    expect(await detailOrNull(4444, 'tv')).toBeNull()

    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
    await expect(detailOrNull(4545, 'tv')).rejects.toThrow('503')
  })
})

