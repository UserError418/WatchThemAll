/**
 * The sequencing, which is where the cost and the privacy live.
 *
 * Two things this has to pin down and nothing else can: that a wrong answer
 * from the preferred database falls through to the other one rather than
 * losing the slot, and that a live-action show never triggers the 5.8 MB
 * anime id download.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resetForTests } from './animeids'
import { findIntro } from './skiplookup'
import type { FetchLike } from './skipsources'

afterEach(() => resetForTests())

const REQUEST = {
  tmdbId: 1399,
  imdbId: 'tt0944947',
  season: 1,
  episode: 1,
  streamSeconds: 3720,
  expectedMinutes: 62,
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

const introdbBody = (start: number, end: number) => ({
  intro: { start_sec: start, end_sec: end },
})
const skipdbBody = (start: number, end: number) => ({
  segments: { intro: { start_ms: start * 1000, end_ms: end * 1000, match: 'agnostic' } },
})

const neverAnime = async (): Promise<boolean> => false

describe('choosing an answer', () => {
  it('prefers IntroDB when both answer', async () => {
    const { fetchImpl } = router({
      'introdb.app': introdbBody(437, 531),
      'skipdb.tv': skipdbBody(448, 461),
    })
    const found = await findIntro(REQUEST, {
      dataDir: '/nonexistent',
      isAnimated: neverAnime,
      fetchImpl,
    })
    expect(found).toEqual({ startSeconds: 437, endSeconds: 531, source: 'introdb' })
  })

  it('falls through to SkipDB when IntroDB has nothing', async () => {
    // Breaking Bad, genuinely: IntroDB has only an outro, SkipDB has the intro.
    const { fetchImpl } = router({
      'introdb.app': { intro: null, outro: { start_sec: 3431, end_sec: 3500 } },
      'skipdb.tv': skipdbBody(229.5, 246.5),
    })
    const found = await findIntro(REQUEST, {
      dataDir: '/nonexistent',
      isAnimated: neverAnime,
      fetchImpl,
    })
    expect(found?.source).toBe('skipdb')
  })

  it('falls through when IntroDB answers but the answer does not survive vetting', async () => {
    // The case a post-hoc picker gets wrong: the preferred source answers,
    // its answer is nonsense for this stream, and the usable one is dropped
    // on the floor because the slot was already taken.
    const { fetchImpl } = router({
      'introdb.app': introdbBody(9000, 9100),
      'skipdb.tv': skipdbBody(229.5, 246.5),
    })
    const found = await findIntro(REQUEST, {
      dataDir: '/nonexistent',
      isAnimated: neverAnime,
      fetchImpl,
    })
    expect(found?.source).toBe('skipdb')
  })

  it('reports what it rejected and why', async () => {
    const judged: string[] = []
    const { fetchImpl } = router({
      'introdb.app': introdbBody(9000, 9100),
      'skipdb.tv': skipdbBody(229.5, 246.5),
    })
    await findIntro(REQUEST, {
      dataDir: '/nonexistent',
      isAnimated: neverAnime,
      fetchImpl,
      onJudged: (segment, ok, reason) => judged.push(`${segment.source} ${ok} ${reason}`),
    })
    expect(judged.some((j) => j.startsWith('introdb false'))).toBe(true)
    expect(judged.some((j) => j.startsWith('skipdb true'))).toBe(true)
  })

  it('asks both databases at once rather than in turn', async () => {
    const { fetchImpl, urls } = router({
      'introdb.app': introdbBody(437, 531),
      'skipdb.tv': skipdbBody(448, 461),
    })
    await findIntro(REQUEST, { dataDir: '/nonexistent', isAnimated: neverAnime, fetchImpl })
    // IntroDB answered and was accepted, and SkipDB was still asked: the
    // button has to arrive during the intro, so the round trips overlap.
    expect(urls.filter((u) => u.includes('skipdb.tv'))).toHaveLength(1)
  })

  it('has nothing when neither database does', async () => {
    const { fetchImpl } = router({
      'introdb.app': { intro: null },
      'skipdb.tv': { segments: { intro: null } },
    })
    expect(
      await findIntro(REQUEST, { dataDir: '/nonexistent', isAnimated: neverAnime, fetchImpl }),
    ).toBeNull()
  })
})

describe('the anime branch', () => {
  const empty = {
    'introdb.app': { intro: null },
    'skipdb.tv': { segments: { intro: null } },
  }

  it('is never reached for a live-action show, so the mapping is never downloaded', async () => {
    const { fetchImpl, urls } = router(empty)
    await findIntro(REQUEST, { dataDir: '/nonexistent', isAnimated: neverAnime, fetchImpl })
    expect(urls.some((u) => u.includes('anime-lists'))).toBe(false)
    expect(urls.some((u) => u.includes('aniskip'))).toBe(false)
  })

  it('resolves a MAL id and asks AniSkip for anime the others miss', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wta-skip-'))
    const { fetchImpl, urls } = router({
      ...empty,
      'anime-lists': [{ mal_id: 16498, themoviedb_id: { tv: 1429 }, season: { tmdb: 1 } }],
      'aniskip.com': {
        found: true,
        results: [{ interval: { startTime: 128.406, endTime: 218.406 }, skipType: 'op' }],
      },
    })

    const found = await findIntro(
      { ...REQUEST, tmdbId: 1429, streamSeconds: 1440, expectedMinutes: 24 },
      { dataDir: dir, isAnimated: async () => true, fetchImpl },
    )
    expect(found).toEqual({ startSeconds: 128.406, endSeconds: 218.406, source: 'aniskip' })
    expect(urls.some((u) => u.includes('/skip-times/16498/1'))).toBe(true)
  })

  it('stops at the mapping when the series is animated but not in it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wta-skip-'))
    const { fetchImpl, urls } = router({
      ...empty,
      'anime-lists': [{ mal_id: 16498, themoviedb_id: { tv: 1429 }, season: { tmdb: 1 } }],
    })
    // A Western cartoon: passes the animated gate, absent from the mapping.
    const found = await findIntro(
      { ...REQUEST, tmdbId: 1433 },
      { dataDir: dir, isAnimated: async () => true, fetchImpl },
    )
    expect(found).toBeNull()
    expect(urls.some((u) => u.includes('aniskip'))).toBe(false)
  })

  it('does not run for a film, which has no episode to ask about', async () => {
    const { fetchImpl, urls } = router(empty)
    await findIntro(
      { ...REQUEST, season: null, episode: null },
      { dataDir: '/nonexistent', isAnimated: async () => true, fetchImpl },
    )
    expect(urls.some((u) => u.includes('anime-lists'))).toBe(false)
  })
})
