/**
 * Where the intro is, and whether we believe it enough to offer a skip.
 *
 * Three public databases carry crowdsourced intro timestamps, and none of them
 * is TMDB or IMDB — neither of those has the data in any form. Measured over
 * forty series from TMDB's top-rated list, probed at three episodes each so a
 * gap at S01E01 is not mistaken for a gap in the show:
 *
 *     IntroDB   29/40   72%
 *     SkipDB    14/40   35%
 *     either    32/40   80%
 *
 * The eight with nothing are documentaries and shorts, most of which have no
 * intro to skip, so the coverage that matters is higher than 80%. AniSkip
 * covers anime specifically and covered 18 of 18 mainstream series with
 * episode-exact, sub-second intervals, which is better than either general
 * database manages — so it is consulted for anime even though IntroDB often
 * has an answer too.
 *
 * ## The part that is actually hard
 *
 * Not finding a number. Trusting it. These timestamps are keyed to a reference
 * cut, and the providers serve whatever encode they happen to have — sometimes
 * with a distributor logo in front, sometimes a different regional edit,
 * sometimes (measured) an entirely different programme. A skip button that
 * seeks ninety seconds into the wrong place is worse than no button, because
 * the user cannot tell whether they lost the intro or the first scene.
 *
 * So every segment is vetted against the stream in front of us before it is
 * offered, and the vetting is deliberately strict: the cost of refusing a good
 * segment is one unpressed button, and the cost of accepting a bad one is
 * throwing somebody into the middle of their episode.
 */

import { checkRuntime } from './runtimecheck'

/** Which database an answer came from. Carried so a bad one can be traced. */
export type SkipSource = 'introdb' | 'skipdb' | 'aniskip'

export interface SkipSegment {
  startSeconds: number
  endSeconds: number
  source: SkipSource
}

/** Nothing shorter than this is an intro; it is a stinger or a bad submission. */
const MIN_INTRO_SECONDS = 5

/** Nothing longer is either. Both general databases cap their own at five minutes. */
const MAX_INTRO_SECONDS = 300

/**
 * An intro in the last third of an episode is a mislabelled outro.
 *
 * Generous rather than tight: cold opens run long on prestige drama — Game of
 * Thrones S01E01 does not reach its title sequence until 7:28 — so anything
 * stricter would reject correct data.
 */
const LATEST_START_FRACTION = 0.66

/**
 * The databases in the order they are believed.
 *
 * IntroDB first on measured accuracy, not just coverage: on every intro this
 * project could verify by hand it was right — Game of Thrones 437-531s, Rick
 * and Morty 128-160s, Stranger Things 505-555s — while SkipDB gave Game of
 * Thrones a thirteen-second intro, which is the right start and the wrong end.
 * AniSkip last because it only ever answers for anime, so reaching it costs a
 * MyAnimeList id lookup that the other two do not need.
 */
export const SOURCE_ORDER: readonly SkipSource[] = ['introdb', 'skipdb', 'aniskip']

/**
 * The first *vetted* answer, in the order above.
 *
 * Fed the results of `vetSegment` rather than raw responses, so a wrong
 * IntroDB answer does not occupy the slot and then lose it — it falls through
 * to SkipDB, which is the point of having a second source at all.
 */
export function chooseSegment(candidates: readonly (SkipSegment | null)[]): SkipSegment | null {
  for (const source of SOURCE_ORDER) {
    const found = candidates.find((c) => c !== null && c.source === source)
    if (found) return found
  }
  return null
}

export interface VetInput {
  segment: SkipSegment
  /** Duration the embed's own `<video>` reports, in seconds. */
  streamSeconds: number
  /** TMDB's runtime for this episode, or null when TMDB does not say. */
  expectedMinutes: number | null
}

export interface Vet {
  ok: boolean
  /** Why, in words a log line can carry unedited. */
  reason: string
}

/**
 * Is this segment about the thing currently playing?
 *
 * The checks run cheapest-first and each one has cost a real failure somewhere:
 * a segment that does not fit inside the stream is from a longer cut, a stream
 * whose length disagrees with TMDB is a different programme entirely (a
 * provider was measured serving a 71-minute film for a 49-minute episode), and
 * an intro in the back half of the runtime is a mislabelled outro.
 */
export function vetSegment(input: VetInput): Vet {
  const { segment, streamSeconds, expectedMinutes } = input
  const { startSeconds, endSeconds } = segment

  if (!Number.isFinite(streamSeconds) || streamSeconds <= 0) {
    return { ok: false, reason: 'the stream has not reported a duration yet' }
  }
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
    return { ok: false, reason: 'the timestamps are not numbers' }
  }
  if (startSeconds < 0 || endSeconds <= startSeconds) {
    return { ok: false, reason: `${startSeconds}s-${endSeconds}s is not an interval` }
  }

  const length = endSeconds - startSeconds
  if (length < MIN_INTRO_SECONDS) {
    return { ok: false, reason: `${length.toFixed(0)}s is too short to be an intro` }
  }
  if (length > MAX_INTRO_SECONDS) {
    return { ok: false, reason: `${length.toFixed(0)}s is too long to be an intro` }
  }

  if (endSeconds > streamSeconds) {
    // The reference cut is longer than what we are watching. Anything derived
    // from it is off by an unknown amount rather than merely late.
    return {
      ok: false,
      reason: `it ends at ${endSeconds.toFixed(0)}s but the stream is only ${streamSeconds.toFixed(0)}s`,
    }
  }
  if (startSeconds > streamSeconds * LATEST_START_FRACTION) {
    return { ok: false, reason: `an intro would not start ${startSeconds.toFixed(0)}s into this` }
  }

  /**
   * The strongest check, and the reason it is worth carrying TMDB's runtime
   * into the player at all: if the stream is not the right *length*, it is not
   * the right programme, and no timestamp about the right programme applies.
   * `unknown` is a pass — most of the time TMDB does have a runtime, and when
   * it does not, the checks above are what is left.
   */
  const runtime = checkRuntime({ deliveredSeconds: streamSeconds, expectedMinutes })
  if (runtime.verdict === 'implausible') {
    return { ok: false, reason: `the stream is the wrong length: ${runtime.reason}` }
  }

  return {
    ok: true,
    reason: `${startSeconds.toFixed(0)}s-${endSeconds.toFixed(0)}s via ${segment.source}`,
  }
}

/**
 * How early the button appears.
 *
 * Slightly before the intro rather than exactly on it: the databases disagree
 * with each other by a second or two on where an intro starts, and a button
 * that arrives a moment early reads as ready, while one that arrives a moment
 * late reads as broken.
 */
const LEAD_IN_SECONDS = 2

/**
 * Whether the button belongs on screen at this position.
 *
 * Only during the intro. Netflix keeps its button for a while afterwards; this
 * does not, because here the button is the *only* evidence the user has that
 * the app knows where the intro is — one that lingers past the intro invites a
 * press that jumps backwards.
 */
export function isWithinOffer(segment: SkipSegment, positionSeconds: number): boolean {
  return (
    positionSeconds >= Math.max(0, segment.startSeconds - LEAD_IN_SECONDS) &&
    positionSeconds < segment.endSeconds
  )
}

/**
 * Where pressing it lands.
 *
 * A hair after the end, because seeking to exactly the boundary leaves some
 * players showing the last frame of the title card before they move on.
 */
export function skipTarget(segment: SkipSegment): number {
  return segment.endSeconds + 0.5
}
