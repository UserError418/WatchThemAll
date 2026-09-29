/**
 * Ask the databases what they know about one episode.
 *
 * The split is deliberate: `skipsources.ts` knows how to talk to each service,
 * `skiptimes.ts` decides whether a segment is about the stream in front of us,
 * and `skipwatch.ts` does that deciding on every reading. This file only
 * gathers the answers, unvetted: until 2.0.6 it vetted them once, against the
 * length of the first reading, and a first reading is often an advert's, so
 * the episode was left with no button at all. Everything here is injectable,
 * so the sequencing — which is where the cost and the privacy sit — can be
 * tested without a network.
 *
 * ## The order, and why two of them run at once
 *
 * IntroDB and SkipDB are asked together. They are independent services, both
 * answers are cheap, and the button has to appear *during* the intro — which
 * for a show that opens cold on its titles means within a few seconds of
 * playback starting. Asking the second only after the first missed would cost
 * a round trip in the 28% of cases where it matters most.
 *
 * AniSkip comes after, alone, only for anime, and only when the other two
 * lack an intro or the credits. It needs a MyAnimeList id, the mapping for
 * that is a 5.8 MB download, and spending it on a live-action show that simply
 * has no data would be a waste every time.
 */

import { fromAniSkip, fromIntroDb, fromSkipDb, type FetchLike } from './skipsources'
import type { SkipSegment } from './skiptimes'

export interface SegmentRequest {
  tmdbId: number
  imdbId: string | null
  season: number | null
  episode: number | null
  /** Duration the embed's own `<video>` reports; SkipDB and AniSkip use it to match the cut. */
  streamSeconds: number
}

export interface SegmentDeps {
  /**
   * The series' MyAnimeList id, or null when it is not anime.
   *
   * The desktop's asks only for animation, which keeps the 5.8 MB mapping
   * (`animeids.ts`) away from the live-action shows that make up most of the
   * misses. The phone has no mapping and answers null, so it has no AniSkip.
   * Kept a dependency so this file needs no file system.
   */
  animeId: (tmdbId: number, season: number | null) => Promise<number | null>
  fetchImpl?: FetchLike
  signal?: AbortSignal
}

/**
 * Every segment the databases have for one episode, not yet checked against
 * the stream. Empty covers every kind of absence: no data, an unreachable
 * service, a film with nothing to ask about.
 */
export async function findSegments(request: SegmentRequest, deps: SegmentDeps): Promise<SkipSegment[]> {
  const { fetchImpl = fetch, signal } = deps
  const ref = {
    imdbId: request.imdbId,
    season: request.season,
    episode: request.episode,
    streamSeconds: request.streamSeconds,
  }

  const general = (
    await Promise.all([fromIntroDb(ref, fetchImpl, signal), fromSkipDb(ref, fetchImpl, signal)])
  ).flat()
  const has = (kind: SkipSegment['kind']): boolean => general.some((s) => s.kind === kind)
  if (has('intro') && has('outro')) return general

  // Anime only, and only for what the cheap sources did not have.
  if (request.episode === null) return general
  const malId = await deps.animeId(request.tmdbId, request.season).catch(() => null)
  if (malId === null) return general

  return [...general, ...(await fromAniSkip(malId, request.episode, request.streamSeconds, fetchImpl, signal))]
}
