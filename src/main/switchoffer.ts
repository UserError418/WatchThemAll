/**
 * Whether a failed request is worth offering to change provider over.
 *
 * Extracted from the player's `onCompleted` handler because it is the part that
 * *decides*, and because that decision has now been wrong twice in ways the
 * user noticed: once by ignoring the provider's own document when it started
 * being framed, and once by treating a rate-limited analytics beacon as a dead
 * source and offering to leave a provider that was playing perfectly.
 *
 * A pure function over one request, so `switchoffer.test.ts` can drive the
 * cases that matter. The alternative is waiting for a third party to rate-limit
 * you at the right moment, which is not a test.
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
  /** Whether an offer is already counting down for this load. */
  offerPending: boolean
}

/**
 * True when this response is evidence that the source will not play.
 *
 * Deliberately conservative. A false positive takes a working video away from
 * somebody mid-episode; a false negative costs a few seconds of black screen
 * before the silence detector notices, and that detector waits for *media*
 * rather than for an HTTP status — which is the evidence that actually answers
 * the user's question.
 */
export function isProviderFailure(input: RequestVerdictInput): boolean {
  const { statusCode, resourceType, url, providerOrigin, playing, offerPending } = input

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

  /** One countdown at a time; a second would race the first. */
  if (offerPending) return false

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
