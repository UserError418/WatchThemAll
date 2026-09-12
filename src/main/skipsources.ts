/**
 * The three databases, one function each.
 *
 * Kept apart from `skiptimes.ts` so the decision about *whether to believe an
 * answer* has no network in it and can be tested directly. What lives here is
 * only the shape of each request and how each service says "I have nothing".
 *
 * None needs a key, an account, or a sign-up to read. All three are
 * crowdsourced and all three can be wrong, which is why nothing they return is
 * acted on before `vetSegment` has looked at it.
 *
 * One shared gotcha, learned the expensive way: **both IntroDB and SkipDB
 * reject the default Node/urllib user agent with a 403.** An hour went into
 * believing the services were down. Every request here names the app.
 */

import type { SkipSegment } from './skiptimes'

/** Identifies this app to services that refuse anonymous agents. */
const USER_AGENT = 'WatchThemAll (+https://github.com/UserError418/WatchThemAll)'

/** Long enough for a cold service, short enough not to delay the button. */
const TIMEOUT_MS = 6_000

export type FetchLike = typeof fetch

export interface EpisodeRef {
  imdbId: string | null
  season: number | null
  episode: number | null
  /** Duration the embed reports, in seconds. Only SkipDB can use it. */
  streamSeconds: number | null
}

/** A GET returning parsed JSON, or null for anything that is not a clean 200. */
async function getJson(
  url: string,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<unknown | null> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: combined,
    })
    if (!response.ok) return null
    return (await response.json()) as unknown
  } catch {
    // A missing intro and an unreachable database are the same thing to the
    // caller: no button. Neither is worth interrupting playback over.
    return null
  }
}

function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Milliseconds as both databases report them, in seconds. */
function fromMs(value: unknown): number | null {
  const ms = seconds(value)
  return ms === null ? null : ms / 1000
}

/**
 * IntroDB — the primary source.
 *
 * Keyed by IMDB id plus season and episode, no key to read, and it returns a
 * `submission_count` so an answer backed by one person can be told from one
 * backed by several. Measured at 72% of TMDB's top-rated series and correct on
 * every intro this project checked by hand.
 */
export async function fromIntroDb(
  ref: EpisodeRef,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<SkipSegment | null> {
  if (!ref.imdbId || ref.season === null || ref.episode === null) return null

  const url =
    `https://api.introdb.app/segments?imdb_id=${encodeURIComponent(ref.imdbId)}` +
    `&season=${ref.season}&episode=${ref.episode}`
  const body = getRecord(await getJson(url, fetchImpl, signal))
  const intro = getRecord(body?.intro)
  if (!intro) return null

  const start = seconds(intro.start_sec) ?? fromMs(intro.start_ms)
  const end = seconds(intro.end_sec) ?? fromMs(intro.end_ms)
  if (start === null || end === null) return null
  return { startSeconds: start, endSeconds: end, source: 'introdb' }
}

/**
 * SkipDB — the fallback, and the only one that knows about cuts.
 *
 * Passing the stream's duration lets it shift its answer for a copy that
 * carries an extra logo at the front, or refuse when the lengths are too far
 * apart to reconcile. It reports which it did: a `match` of `out-of-range`
 * means it could not, and that answer is dropped rather than shifted blindly.
 */
export async function fromSkipDb(
  ref: EpisodeRef,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<SkipSegment | null> {
  if (!ref.imdbId) return null

  const params = new URLSearchParams({ imdb_id: ref.imdbId })
  if (ref.season !== null) params.set('season', String(ref.season))
  if (ref.episode !== null) params.set('episode', String(ref.episode))
  if (ref.streamSeconds !== null && ref.streamSeconds > 0) {
    params.set('duration', String(Math.round(ref.streamSeconds)))
    // Conservative: shift only when the evidence supports it. The alternative
    // ("greedy") guesses, and a guessed offset is exactly the failure this
    // whole feature has to avoid.
    params.set('adjust', 'conservative')
  }

  const body = getRecord(
    await getJson(`https://api.skipdb.tv/api/segments?${params}`, fetchImpl, signal),
  )
  const intro = getRecord(getRecord(body?.segments)?.intro)
  if (!intro) return null
  if (intro.match === 'out-of-range') return null

  const start = fromMs(intro.start_ms)
  const end = fromMs(intro.end_ms)
  if (start === null || end === null) return null
  return { startSeconds: start, endSeconds: end, source: 'skipdb' }
}

/**
 * AniSkip — anime only, and the most precise of the three.
 *
 * Keyed by MyAnimeList id rather than IMDB, which is why it needs the id
 * mapping in `animeids.ts` and why it is consulted last. What it gives back is
 * episode-exact to the millisecond rather than a series-level estimate:
 * measured at 18 of 18 mainstream series, every episode probed.
 *
 * `episodeLength` is how it disambiguates between releases. Zero is the
 * documented "I do not know" and returns the best available answer.
 */
export async function fromAniSkip(
  malId: number,
  episode: number,
  streamSeconds: number | null,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<SkipSegment | null> {
  const length = streamSeconds !== null && streamSeconds > 0 ? Math.round(streamSeconds) : 0
  const url =
    `https://api.aniskip.com/v2/skip-times/${malId}/${episode}` +
    `?types=op&episodeLength=${length}`

  const body = getRecord(await getJson(url, fetchImpl, signal))
  if (!body || body.found !== true || !Array.isArray(body.results)) return null

  for (const raw of body.results) {
    const result = getRecord(raw)
    if (result?.skipType !== 'op') continue
    const interval = getRecord(result.interval)
    const start = seconds(interval?.startTime)
    const end = seconds(interval?.endTime)
    if (start === null || end === null) continue
    return { startSeconds: start, endSeconds: end, source: 'aniskip' }
  }
  return null
}

/** Narrow an unknown JSON value to something with readable properties. */
function getRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}
