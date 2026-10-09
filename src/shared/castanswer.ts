/**
 * When a television has answered a cast, and what that answer files.
 *
 * ## Why this exists (the owner, 2026-10-09)
 *
 * The cast list said "Casts to this TV" for sources that then failed on the
 * television. Every one of the 13 casts on record had been filed as castable,
 * and none carried what the television actually said: the phone resolved its
 * load before the receiver answered, and both platforms filed the delivery a
 * beam had seen whether or not anything played. A failed beam was filed as
 * proof that the source casts.
 *
 * So a cast files a result only once the television's answer is known, by
 * one rule on both platforms. The desktop applies it here (`castsender.ts`);
 * the phone's receiver is driven by the Cast SDK in Java, so
 * `CastPlugin.java` (`LoadAnswer`) carries a copy of `ReceiverWatch`, and the
 * window is handed to it from here so the two cannot drift on that.
 *
 * ## The rule
 *
 * - **Played**: the receiver reached PLAYING, or its position moved forward
 *   by `POSITION_MOVED_S`. BUFFERING alone is not playing: it is what a
 *   receiver says before it has decoded a frame, and until 2.0.18 the desktop
 *   counted it, which filed streams that went IDLE with an error a moment
 *   later as "played".
 * - **Refused**: the receiver failed the load, or went IDLE with reason
 *   ERROR. Filed only if the receiver had fetched from the proxy, and as
 *   `blocked` rather than `refused` when the source's servers refused the
 *   proxy something the receiver asked for (`castOutcomeOf`).
 * - **Unsettled**: still LOADING or BUFFERING when `CAST_ANSWER_WINDOW_MS`
 *   runs out. The user is told what they always were (the cast goes ahead),
 *   and nothing is filed.
 */

import type { CastOutcome } from './types'

/**
 * How long a beam follows the receiver for its answer.
 *
 * Measured starts on the owner's dongle took 1–4 s to PLAYING. Fifteen
 * seconds was the desktop's wait while BUFFERING still counted as an answer;
 * waiting for PLAYING needs a little more room, and the phone, which had not
 * waited at all, gets the same.
 */
export const CAST_ANSWER_WINDOW_MS = 20_000

/**
 * How often the receiver is asked for its state while waiting.
 *
 * A receiver announces its state changes on its own, but not its position:
 * that is only in an answer to a status request. Without asking, a position
 * moving under a state the sender never saw change would go unnoticed.
 */
export const CAST_STATUS_POLL_MS = 2_000

/** How far the receiver's position has to move, in seconds, to count as playing. */
export const POSITION_MOVED_S = 1

/** What the receiver said about one load, by the end of the window. */
export type ReceiverAnswer = 'played' | 'refused' | 'unsettled'

/** One reading of the receiver's media status: the fields the rule reads. */
export interface MediaReading {
  playerState?: string
  idleReason?: string
  currentTime?: number
}

/**
 * The rule above, fed one reading at a time.
 *
 * One per load: it remembers the first position the receiver reported once
 * it had the media (BUFFERING or PAUSED), and a reading that has moved past
 * it counts as played. LOADING is not a starting point: its position can be
 * 0 or the one requested, before the receiver has sought anywhere, and a
 * seek is not playback.
 */
export class ReceiverWatch {
  private from: number | null = null

  /** The answer this reading gives, or null while there is none yet. */
  read(reading: MediaReading): 'played' | 'refused' | null {
    if (reading.playerState === 'PLAYING') return 'played'
    if (reading.playerState === 'IDLE' && reading.idleReason === 'ERROR') return 'refused'
    const holding = reading.playerState === 'BUFFERING' || reading.playerState === 'PAUSED'
    if (!holding || typeof reading.currentTime !== 'number') return null
    if (this.from === null) {
      this.from = reading.currentTime
      return null
    }
    return reading.currentTime - this.from >= POSITION_MOVED_S ? 'played' : null
  }
}

/** What the proxy saw while the receiver had the stream. */
export interface ProxyCounts {
  /** Requests the receiver made for anything registered: proof it reached this device. */
  served: number
  /** Of those, the ones the source's servers answered with an error status, or not at all. */
  upstreamFailures: number
}

/**
 * What a beam files about its source, or null for nothing.
 *
 * A refusal says something about the source only if the receiver had
 * fetched from the proxy: it answers LOAD_FAILED the same way when it cannot
 * reach this device at all, and filing a Wi-Fi problem as "this source cannot
 * cast" would hide a source that can. And a refusal while the source was
 * refusing the proxy is the source's doing (`blocked`), not the format's.
 */
export function castOutcomeOf(answer: ReceiverAnswer, proxy: ProxyCounts): CastOutcome | null {
  switch (answer) {
    case 'played':
      return 'played'
    case 'refused':
      if (proxy.served === 0) return null
      return proxy.upstreamFailures > 0 ? 'blocked' : 'refused'
    case 'unsettled':
      return null
  }
}

/**
 * What the user is told when the source, not the television, stopped a
 * cast. Not "this TV cannot play it": that is what a `refused` says, and
 * until 2.0.18 a block was filed and worded as one.
 */
export function blockedCastMessage(providerName: string): string {
  return `${providerName} refused to serve the stream to the TV. Try another source, or this one again later.`
}

/**
 * What a beam learned about its source, for filing (`castResults` in
 * `providerscan.ts`). Exists only when the television answered.
 */
export interface CastLearned {
  delivery: 'progressive' | 'segmented'
  outcome: CastOutcome
}
