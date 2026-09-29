/**
 * The sequencing, which is where the cost and the privacy live.
 *
 * What this pins down: both general databases are asked at once and every
 * kind they answer is kept, unvetted (vetting is `skipwatch.ts`'s, on every
 * reading); AniSkip is asked only for anime, and only for what the others
 * lacked.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { findSegments } from './skiplookup'
import { forgetAnswersForTests, type FetchLike } from './skipsources'

afterEach(() => forgetAnswersForTests())

const REQUEST = {
  tmdbId: 1399,
  imdbId: 'tt0944947',
  season: 1,
  episode: 1,
  streamSeconds: 3720,
}

/** A `fetch` that routes by host, and records every URL it was asked for. */
function router(routes: Record<string, unknown>): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = []
  const fetchImpl = (async (url: string | URL) => {
    const href = String(url)
    urls.push(href)
    const key = Object.keys(routes).find((k) => href.includes(k))
    if (key === undefined) return { ok: false, status: 404, json: async () => ({}) } as Response
    return { ok: true, status: 200, json: async () => routes[key] } as Response
  }) as FetchLike
  return { fetchImpl, urls }
}

const notAnime = async (): Promise<number | null> => null

describe('findSegments', () => {
  it('keeps every kind from both databases, unvetted', async () => {
    const { fetchImpl } = router({
      'introdb.app': { intro: { start_sec: 437, end_sec: 531 }, recap: null, outro: { start_sec: 3431, end_sec: 3500 } },
      // An answer no stream could fit: kept here, refused later by the vetting.
      'skipdb.tv': { segments: { intro: { start_ms: 9_000_000, end_ms: 9_100_000, match: 'agnostic' } } },
    })
    const found = await findSegments(REQUEST, { animeId: notAnime, fetchImpl })
    expect(found).toEqual([
      { kind: 'intro', startSeconds: 437, endSeconds: 531, source: 'introdb' },
      { kind: 'outro', startSeconds: 3431, endSeconds: 3500, source: 'introdb' },
      { kind: 'intro', startSeconds: 9000, endSeconds: 9100, source: 'skipdb' },
    ])
  })

  it('asks both databases at once rather than in turn', async () => {
    const { fetchImpl, urls } = router({
      'introdb.app': { intro: { start_sec: 437, end_sec: 531 }, outro: { start_sec: 3431, end_sec: 3500 } },
      'skipdb.tv': { segments: { intro: null } },
    })
    await findSegments(REQUEST, { animeId: notAnime, fetchImpl })
    expect(urls.filter((u) => u.includes('introdb.app'))).toHaveLength(1)
    expect(urls.filter((u) => u.includes('skipdb.tv'))).toHaveLength(1)
  })

  it('has nothing when neither database does', async () => {
    const { fetchImpl } = router({ 'introdb.app': { intro: null }, 'skipdb.tv': { segments: { intro: null } } })
    expect(await findSegments(REQUEST, { animeId: notAnime, fetchImpl })).toEqual([])
  })
})

describe('the anime branch', () => {
  const empty = { 'introdb.app': { intro: null }, 'skipdb.tv': { segments: { intro: null } } }

  it('is not asked for a series that is not anime', async () => {
    const { fetchImpl, urls } = router(empty)
    await findSegments(REQUEST, { animeId: notAnime, fetchImpl })
    expect(urls.some((u) => u.includes('aniskip'))).toBe(false)
  })

  it('asks AniSkip for anime the others miss, opening and ending', async () => {
    const { fetchImpl, urls } = router({
      ...empty,
      'aniskip.com': {
        found: true,
        results: [
          { interval: { startTime: 1338, endTime: 1428 }, skipType: 'ed' },
          { interval: { startTime: 128.406, endTime: 218.406 }, skipType: 'op' },
        ],
      },
    })
    const found = await findSegments(
      { ...REQUEST, tmdbId: 1429, streamSeconds: 1440 },
      { animeId: async () => 16498, fetchImpl },
    )
    expect(found).toEqual([
      { kind: 'outro', startSeconds: 1338, endSeconds: 1428, source: 'aniskip' },
      { kind: 'intro', startSeconds: 128.406, endSeconds: 218.406, source: 'aniskip' },
    ])
    expect(urls.some((u) => u.includes('/skip-times/16498/1'))).toBe(true)
  })

  it('does not ask for the anime id when the others had both the intro and the credits', async () => {
    const { fetchImpl } = router({
      'introdb.app': { intro: { start_sec: 90, end_sec: 180 }, outro: { start_sec: 1300, end_sec: 1400 } },
      'skipdb.tv': { segments: { intro: null } },
    })
    let asked = false
    await findSegments(REQUEST, {
      animeId: async () => {
        asked = true
        return 16498
      },
      fetchImpl,
    })
    expect(asked).toBe(false)
  })

  it('does not run for a film, which has no episode to ask about', async () => {
    const { fetchImpl } = router(empty)
    let asked = false
    await findSegments(
      { ...REQUEST, season: null, episode: null },
      {
        animeId: async () => {
          asked = true
          return 1
        },
        fetchImpl,
      },
    )
    expect(asked).toBe(false)
  })
})
