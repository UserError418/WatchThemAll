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

import type { SkipKind, SkipSegment } from './skiptimes'

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

/**
 * Clean answers already given this session, by URL.
 *
 * An episode is looked up on every load, and a load is also every provider
 * switch and every replay — the same three questions with the same answers.
 * Only a clean 200 is kept: a failure is asked again next time, as before.
 * The hours bound how long a newly submitted intro can go unseen.
 */
const answers = new Map<string, { body: unknown; at: number }>()
const ANSWER_TTL_MS = 6 * 60 * 60 * 1000
const MAX_ANSWERS = 200

/** Tests only: answers would otherwise carry over between cases. */
export function forgetAnswersForTests(): void {
  answers.clear()
}

/** A GET returning parsed JSON, or null for anything that is not a clean 200. */
async function getJson(
  url: string,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<unknown | null> {
  const known = answers.get(url)
  if (known && Date.now() - known.at < ANSWER_TTL_MS) return known.body

  const body = await fetchJson(url, fetchImpl, signal)
  if (body !== null) {
    // Oldest first out; a Map iterates in insertion order.
    if (answers.size >= MAX_ANSWERS) answers.delete(answers.keys().next().value!)
    answers.set(url, { body, at: Date.now() })
  }
  return body
}

async function fetchJson(
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
): Promise<SkipSegment[]> {
  if (!ref.imdbId || ref.season === null || ref.episode === null) return []

  const url =
    `https://api.introdb.app/segments?imdb_id=${encodeURIComponent(ref.imdbId)}` +
    `&season=${ref.season}&episode=${ref.episode}`
  const body = getRecord(await getJson(url, fetchImpl, signal))
  return KINDS.flatMap((kind) => {
    const part = getRecord(body?.[kind])
    if (!part) return []
    const start = seconds(part.start_sec) ?? fromMs(part.start_ms)
    const end = seconds(part.end_sec) ?? fromMs(part.end_ms)
    if (start === null || end === null) return []
    return [{ kind, startSeconds: start, endSeconds: end, source: 'introdb' as const }]
  })
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
): Promise<SkipSegment[]> {
  if (!ref.imdbId) return []

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
  const segments = getRecord(body?.segments)
  return KINDS.flatMap((kind) => {
    const part = getRecord(segments?.[kind])
    if (!part || part.match === 'out-of-range') return []
    const start = fromMs(part.start_ms)
    const end = fromMs(part.end_ms)
    if (start === null || end === null) return []
    return [{ kind, startSeconds: start, endSeconds: end, source: 'skipdb' as const }]
  })
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
 * documented "I do not know" and returns the best available answer. Its
 * opening is `op`, its ending `ed`; the first of each is taken.
 */
export async function fromAniSkip(
  malId: number,
  episode: number,
  streamSeconds: number | null,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<SkipSegment[]> {
  const length = streamSeconds !== null && streamSeconds > 0 ? Math.round(streamSeconds) : 0
  const url =
    `https://api.aniskip.com/v2/skip-times/${malId}/${episode}` +
    `?types=op&types=ed&types=recap&episodeLength=${length}`

  const body = getRecord(await getJson(url, fetchImpl, signal))
  if (!body || body.found !== true || !Array.isArray(body.results)) return []

  const found: SkipSegment[] = []
  for (const raw of body.results) {
    const result = getRecord(raw)
    const kind = ANISKIP_KINDS[String(result?.skipType)]
    if (kind === undefined || found.some((s) => s.kind === kind)) continue
    const interval = getRecord(result?.interval)
    const start = seconds(interval?.startTime)
    const end = seconds(interval?.endTime)
    if (start === null || end === null) continue
    found.push({ kind, startSeconds: start, endSeconds: end, source: 'aniskip' })
  }
  return found
}

/** What IntroDB and SkipDB call each kind: the same words as ours. */
const KINDS: readonly SkipKind[] = ['intro', 'recap', 'outro']

/** AniSkip's names for them. */
const ANISKIP_KINDS: Record<string, SkipKind | undefined> = { op: 'intro', ed: 'outro', recap: 'recap' }

/** Narrow an unknown JSON value to something with readable properties. */
function getRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}
