/**
 * When the player may offer to change source, and when that offer may act.
 *
 * Extracted from `playerview.ts` because these are the parts that *decide*,
 * and the decisions have been wrong in ways the user noticed, repeatedly:
 * ignoring the provider's own document once it was framed; treating a
 * rate-limited analytics beacon as a dead source; and, reported on
 * 2026-09-26, switching away from sources that were fine — VidLux cut off
 * seconds before it would have played, a video waiting for its play button
 * abandoned, a paused one treated as frozen.
 *
 * Pure functions, so `switchoffer.test.ts` can drive the cases that matter.
 * The alternative is waiting for a third party to misbehave at the right
 * moment, which is not a test.
 */

import { isSameOrigin } from './sameorigin'

export interface RequestVerdictInput {
  statusCode: number
  /** Electron's `details.resourceType`. */
  resourceType: string
  url: string
  /** The current provider's origin, or null when there is no current provider. */
  providerOrigin: string | null
  /** Whether the video has already started. */
  playing: boolean
}

/**
 * True when this response is the provider's own backend failing.
 *
 * It names the reason in an offer; it no longer raises one. It used to, 250 ms
 * after the failure, and that was wrong for the most common case: VidLux asks
 * two of its extractors first, both fail within a second on every title, and
 * then it plays from a third at 8.5–19 s. The offer came at two seconds and the
 * countdown switched at seven, so VidLux never got to play — which is why it
 * looked broken. A failed lookup is the provider trying its next source, not a
 * verdict; only silence past the grace period is (see `streamResolved`).
 */
export function isProviderFailure(input: RequestVerdictInput): boolean {
  const { statusCode, resourceType, url, providerOrigin, playing } = input

  if (statusCode < 400) return false

  /**
   * Rate limiting is not breakage.
   *
   * A 429 says the provider is being asked too often — by this address, across
   * every tab and app on it — not that it is broken. Changing provider because
   * of a throttle is precisely the wrong response: the source still works and
   * recovers within seconds, while the switch costs the user their place.
   *
   * Measured: Videasy rate-limits its own `/api/stats/hit` beacon, which has
   * nothing to do with the stream, and that alone put a countdown to leave over
   * a playing video.
   */
  if (statusCode === 429) return false

  /**
   * Already playing.
   *
   * Once the bytes are flowing, no HTTP status is evidence about *this*
   * playback. These pages keep making background calls for the whole episode,
   * and any one of them failing half an hour in used to raise a fresh offer.
   */
  if (playing) return false

  /**
   * The provider's own API call, or the provider's own document.
   *
   * `subFrame` is here because the provider is framed rather than navigated to.
   * That moved its document out of `did-navigate`, which is main-frame only and
   * now only ever sees the local shell's clean 200 — so without this a provider
   * answering 403 looked like a page that loaded fine and never played.
   */
  if (resourceType !== 'xhr' && resourceType !== 'subFrame') return false

  // Only the provider's own backend. A third-party analytics or ad call
  // failing says nothing about whether the stream will resolve.
  return isSameOrigin(url, providerOrigin)
}

/**
 * What the player has seen of the current load, for `streamResolved`.
 */
export interface LoadEvidence {
  /** A playlist answered. */
  playlistOk: boolean
  /** Video itself arrived: a segment or a whole file. */
  videoOk: boolean
  /** The status a video segment was refused with, or null if none was. */
  refusedStatus: number | null
  /** A `<video>` with a real duration exists in some frame. */
  videoElement: boolean
}

/**
 * Has this source found its stream, even though nothing is playing?
 *
 * The desktop player does not press play, and many providers do not autoplay:
 * they load the stream and wait for the user. Nothing plays, so the silence
 * detector used to conclude the source had failed and switch away from a video
 * that was ready — reported 2026-09-26. A source that has resolved its
 * stream is waiting for the user, and the user is not a failure.
 *
 * A refused segment overrides a playlist or an element: Videasy's playlists
 * load and its player builds a `<video>` with a duration, then every segment is
 * refused with 403 and nothing can ever play. That source is broken, and an
 * offer is exactly right.
 */
export function streamResolved(evidence: LoadEvidence): boolean {
  if (evidence.videoOk) return true
  if (evidence.refusedStatus !== null) return false
  return evidence.playlistOk || evidence.videoElement
}

/**
 * How long a page must have finished no request at all to count as idle.
 *
 * Longer than the gaps inside a load that is still working (a player walking
 * its backend's sources pauses a second or two between calls), far shorter
 * than a poster sits waiting. VidSrc on its poster finished its last request
 * 1.2 s after opening and nothing for the next nineteen.
 */
export const PAGE_IDLE_MS = 5_000

/** What the page's network was doing when the grace period ran out. */
export interface PageActivity {
  /** Since the page last finished a request. */
  idleForMs: number
  /**
   * Requests sent and not yet answered, sockets and media excluded. A page
   * waiting on its backend finishes nothing while it waits: CinemaOS sat on
   * "Fetching Prism" for nineteen seconds with its scrape call open, and
   * counting only finished requests read that as idle.
   */
  pendingRequests: number
}

/**
 * What nothing having played by the end of the grace period means.
 *
 * - `resolved` — the stream is there, waiting for the user. No offer.
 * - `failing` — the provider said it cannot: a refused segment, a failed
 *   backend call. Offer.
 * - `loading` — still busy at the deadline: slow at best. Offer.
 * - `waiting` — idle, with nothing wrong. No offer; look again once the page
 *   does something.
 *
 * `waiting` is the case the first fix missed. Several providers build no
 * player at all until their poster is clicked — VidSrc's frames hold no
 * `<video>`, fetch no playlist, and go quiet — so there is no stream to find,
 * and the old rule read "nothing arrived" as "nothing will". Measured
 * 2026-09-26: VidSrc was switched away from at 29 s while showing Fight Club's
 * poster with a play button on it, which is the report exactly. Videasy
 * is the same, and loads its stream the moment it is clicked.
 *
 * The cost is on the other side: a page that fails without saying so and then
 * goes quiet is also `waiting`, and gets no offer. That is the right way round
 * — the user sees a dead page and has the source menu, while a switch away
 * from a working source is what they could not undo by looking. So is a page
 * holding a long-poll open, which reads as `loading`; none of the ten
 * providers measured does.
 */
export type SilenceJudgement = 'resolved' | 'failing' | 'loading' | 'waiting'

export function judgeSilence(
  evidence: LoadEvidence,
  backendFailed: boolean,
  activity: PageActivity,
): SilenceJudgement {
  if (streamResolved(evidence)) return 'resolved'
  if (evidence.refusedStatus !== null || backendFailed) return 'failing'
  const idle = activity.pendingRequests === 0 && activity.idleForMs >= PAGE_IDLE_MS
  return idle ? 'waiting' : 'loading'
}

/**
 * Why an offer is being made.
 *
 * - `silence` — nothing has played within the grace period.
 * - `failure` — the page itself failed: its document, or its renderer.
 * - `stall` — it played, then froze.
 */
export type OfferKind = 'silence' | 'failure' | 'stall'

/**
 * May this offer switch by itself when its countdown runs out?
 *
 * Every automatic switch goes through the offer and its countdown, which the
 * user can refuse; nothing switches silently. Two kinds of offer do not count
 * down at all, and only offer:
 *
 * - **A stall.** The user is mid-episode, possibly having paused, and being
 *   moved somewhere else unasked is worse than the freeze. The watcher's own
 *   comment always said "offers rather than switches"; the countdown did not
 *   know that.
 * - **A source "Test all sources" found working.** Agreed 2026-09-26: never
 *   auto-switch away from a green source. A slow start there is far likelier
 *   than a dead one, and the user can still take the offer.
 */
export function mayAutoSwitch(kind: OfferKind, testedWorking: boolean): boolean {
  if (testedWorking) return false
  return kind !== 'stall'
}
