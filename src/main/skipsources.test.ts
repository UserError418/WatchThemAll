/**
 * Driven against recorded answers rather than the live services.
 *
 * Every payload here was copied from a real response — the shapes are
 * awkward in ways nobody would invent, and the awkward parts are exactly what
 * breaks: IntroDB reports seconds *and* milliseconds, SkipDB nests under
 * `segments` and hides its refusals in a `match` field, AniSkip returns an
 * array that can contain an ending when an opening was asked for.
 */

import { describe, expect, it, vi } from 'vitest'

import { fromAniSkip, fromIntroDb, fromSkipDb, type FetchLike } from './skipsources'

/** A `fetch` that answers one body, and records what it was asked for. */
function stub(
  body: unknown,
  ok = true,
): { fetchImpl: FetchLike; urls: string[]; headers: Headers[] } {
  const urls: string[] = []
  const headers: Headers[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url))
    headers.push(new Headers(init?.headers))
    return { ok, status: ok ? 200 : 404, json: async () => body } as Response
  }) as FetchLike
  return { fetchImpl, urls, headers }
}

const REF = { imdbId: 'tt0944947', season: 1, episode: 1, streamSeconds: 3720 }

describe('IntroDB', () => {
  const gameOfThrones = {
    imdb_id: 'tt0944947',
    intro: { start_sec: 437, end_sec: 531, start_ms: 437000, end_ms: 531000, confidence: 1 },
    recap: null,
    outro: null,
  }

  it('reads the real Game of Thrones answer', async () => {
    const { fetchImpl } = stub(gameOfThrones)
    expect(await fromIntroDb(REF, fetchImpl)).toEqual({
      startSeconds: 437,
      endSeconds: 531,
      source: 'introdb',
    })
  })

  it('names the app, because the default agent is rejected with a 403', async () => {
    // An hour went into believing the service was down. Pinned so it cannot
    // regress into the same silence.
    const { fetchImpl, headers } = stub(gameOfThrones)
    await fromIntroDb(REF, fetchImpl)
    expect(headers[0]?.get('user-agent')).toContain('WatchThemAll')
  })

  it('returns nothing for an episode it has only an outro for', async () => {
    // Breaking Bad S01E01 on IntroDB, genuinely: outro but no intro.
    const { fetchImpl } = stub({
      intro: null,
      recap: null,
      outro: { start_sec: 3431, end_sec: 3500 },
    })
    expect(await fromIntroDb(REF, fetchImpl)).toBeNull()
  })

  it('does not ask at all without an IMDB id or an episode', async () => {
    const { fetchImpl, urls } = stub(gameOfThrones)
    expect(await fromIntroDb({ ...REF, imdbId: null }, fetchImpl)).toBeNull()
    expect(await fromIntroDb({ ...REF, episode: null }, fetchImpl)).toBeNull()
    expect(urls).toHaveLength(0)
  })

  it('treats an error status as no data rather than throwing', async () => {
    const { fetchImpl } = stub({ error: 'nope' }, false)
    expect(await fromIntroDb(REF, fetchImpl)).toBeNull()
  })

  it('survives a service that answers with something that is not JSON', async () => {
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('not json')
        },
      }) as unknown as Response) as FetchLike
    expect(await fromIntroDb(REF, fetchImpl)).toBeNull()
  })
})

describe('SkipDB', () => {
  const breakingBad = {
    segments: {
      intro: { start_ms: 229500, end_ms: 246500, match: 'agnostic', confidence: 0.75 },
      recap: null,
      outro: { start_ms: 3434000, end_ms: 3500000 },
    },
  }

  it('reads the real Breaking Bad answer, in milliseconds', async () => {
    const { fetchImpl } = stub(breakingBad)
    expect(await fromSkipDb(REF, fetchImpl)).toEqual({
      startSeconds: 229.5,
      endSeconds: 246.5,
      source: 'skipdb',
    })
  })

  it('sends the stream duration so it can shift for a different cut', async () => {
    const { fetchImpl, urls } = stub(breakingBad)
    await fromSkipDb({ ...REF, streamSeconds: 2703.4 }, fetchImpl)
    expect(urls[0]).toContain('duration=2703')
    expect(urls[0]).toContain('adjust=conservative')
  })

  it('omits the duration when the stream has not reported one', async () => {
    const { fetchImpl, urls } = stub(breakingBad)
    await fromSkipDb({ ...REF, streamSeconds: null }, fetchImpl)
    expect(urls[0]).not.toContain('duration=')
  })

  it('drops an answer the service itself says it could not reconcile', async () => {
    // Measured by passing a deliberately wrong duration: SkipDB reports
    // `out-of-range` rather than guessing, and taking the numbers anyway
    // would throw away the one safeguard it offers.
    const { fetchImpl } = stub({
      segments: { intro: { start_ms: 229500, end_ms: 246500, match: 'out-of-range' } },
    })
    expect(await fromSkipDb(REF, fetchImpl)).toBeNull()
  })

  it('asks about a film with no season or episode', async () => {
    const { fetchImpl, urls } = stub({ segments: { intro: null } })
    await fromSkipDb(
      { imdbId: 'tt0137523', season: null, episode: null, streamSeconds: null },
      fetchImpl,
    )
    expect(urls[0]).not.toContain('season=')
    expect(urls[0]).not.toContain('episode=')
  })
})

describe('AniSkip', () => {
  const attackOnTitan = {
    found: true,
    results: [
      { interval: { startTime: 1342.795, endTime: 1430.616 }, skipType: 'ed' },
      { interval: { startTime: 128.406, endTime: 218.406 }, skipType: 'op' },
    ],
  }

  it('takes the opening even when an ending comes first in the array', async () => {
    const { fetchImpl } = stub(attackOnTitan)
    expect(await fromAniSkip(16498, 1, 1440, fetchImpl)).toEqual({
      startSeconds: 128.406,
      endSeconds: 218.406,
      source: 'aniskip',
    })
  })

  it('passes the episode length it was given', async () => {
    const { fetchImpl, urls } = stub(attackOnTitan)
    await fromAniSkip(16498, 3, 1441.9, fetchImpl)
    expect(urls[0]).toContain('/skip-times/16498/3')
    expect(urls[0]).toContain('episodeLength=1442')
  })

  it('sends the documented zero when the length is unknown', async () => {
    const { fetchImpl, urls } = stub(attackOnTitan)
    await fromAniSkip(16498, 1, null, fetchImpl)
    expect(urls[0]).toContain('episodeLength=0')
  })

  it('honours found:false rather than reading an empty array', async () => {
    const { fetchImpl } = stub({ found: false, results: [], statusCode: 404 })
    expect(await fromAniSkip(16498, 1, 1440, fetchImpl)).toBeNull()
  })

  it('returns nothing when the only result is an ending', async () => {
    const { fetchImpl } = stub({
      found: true,
      results: [{ interval: { startTime: 1342, endTime: 1430 }, skipType: 'ed' }],
    })
    expect(await fromAniSkip(16498, 1, 1440, fetchImpl)).toBeNull()
  })
})

describe('all three', () => {
  it('give up rather than hang when a service does not answer', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ETIMEDOUT')
    }) as unknown as FetchLike
    expect(await fromIntroDb(REF, fetchImpl)).toBeNull()
    expect(await fromSkipDb(REF, fetchImpl)).toBeNull()
    expect(await fromAniSkip(1, 1, null, fetchImpl)).toBeNull()
  })
})
