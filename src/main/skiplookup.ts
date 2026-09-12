/**
 * Ask the databases, and hand back only an answer worth acting on.
 *
 * The split is deliberate: `skipsources.ts` knows how to talk to each service,
 * `skiptimes.ts` decides whether a segment is about the stream in front of us,
 * and this file is the only place that knows both. Everything here is
 * injectable, so the sequencing — which is where the cost and the privacy sit
 * — can be tested without a network.
 *
 * ## The order, and why two of them run at once
 *
 * IntroDB and SkipDB are asked together. They are independent services, both
 * answers are cheap, and the button has to appear *during* the intro — which
 * for a show that opens cold on its titles means within a few seconds of
 * playback starting. Asking the second only after the first missed would cost
 * a round trip in the 28% of cases where it matters most.
 *
 * AniSkip comes after, alone, and only for anime. It needs a MyAnimeList id,
 * the mapping for that is a 5.8 MB download, and spending it on a live-action
 * show that simply has no data would be a waste every time.
 */

import { malIdFor } from './animeids'
import { fromAniSkip, fromIntroDb, fromSkipDb, type FetchLike } from './skipsources'
import { chooseSegment, vetSegment, type SkipSegment } from './skiptimes'

export interface IntroRequest {
  tmdbId: number
  imdbId: string | null
  season: number | null
  episode: number | null
  /** Duration the embed's own `<video>` reports. The whole vetting rests on it. */
  streamSeconds: number
  /** TMDB's runtime for this episode, or null when TMDB does not say. */
  expectedMinutes: number | null
}

export interface IntroDeps {
  /** Where the anime id mapping is cached. Never inside the app bundle. */
  dataDir: string
  /**
   * Whether this title is animation.
   *
   * A gate on the AniSkip branch, not a claim about the title: it exists only
   * to keep a 5.8 MB download away from the live-action shows that make up
   * most of the misses. Over-inclusive on purpose — Western animation passes
   * it, finds nothing in the mapping, and that costs one lookup.
   */
  isAnimated: (tmdbId: number) => Promise<boolean>
  fetchImpl?: FetchLike
  signal?: AbortSignal
  /** Called for every answer considered, accepted or not. */
  onJudged?: (segment: SkipSegment, ok: boolean, reason: string) => void
}

/**
 * The intro for one episode, already checked against the stream, or null.
 *
 * Null is the ordinary answer and covers every kind of absence there is — no
 * data, an unreachable service, an answer that did not survive vetting. The
 * caller does not need to tell them apart: all of them mean no button.
 */
export async function findIntro(
  request: IntroRequest,
  deps: IntroDeps,
): Promise<SkipSegment | null> {
  const { fetchImpl = fetch, signal } = deps
  const ref = {
    imdbId: request.imdbId,
    season: request.season,
    episode: request.episode,
    streamSeconds: request.streamSeconds,
  }

  const accept = (segment: SkipSegment | null): SkipSegment | null => {
    if (!segment) return null
    const vet = vetSegment({
      segment,
      streamSeconds: request.streamSeconds,
      expectedMinutes: request.expectedMinutes,
    })
    deps.onJudged?.(segment, vet.ok, vet.reason)
    return vet.ok ? segment : null
  }

  const general = await Promise.all([
    fromIntroDb(ref, fetchImpl, signal),
    fromSkipDb(ref, fetchImpl, signal),
  ])
  const chosen = chooseSegment(general.map(accept))
  if (chosen) return chosen

  // Anime only, and only once the cheap sources have both come up empty.
  if (request.episode === null) return null
  if (!(await deps.isAnimated(request.tmdbId))) return null

  const malId = await malIdFor(deps.dataDir, request.tmdbId, request.season, fetchImpl)
  if (malId === null) return null

  return accept(await fromAniSkip(malId, request.episode, request.streamSeconds, fetchImpl, signal))
}
