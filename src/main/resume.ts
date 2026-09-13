/**
 * Remembering where a title was left, and deciding when to go back there.
 *
 * ## Where the numbers come from
 *
 * The provider embed is a cross-origin iframe inside a native view, so nothing
 * in the app's renderer can see it. The main process can: `executeJavaScript`
 * runs in any frame of a `WebContents` regardless of origin, which is a
 * privilege of the embedder rather than of a page. Measured against a real
 * provider, that reaches an ordinary `<video>` element and reads a
 * `currentTime` that advances and a `duration` that is correct.
 *
 * That is a genuine position, not an estimate. It replaces the elapsed-playing
 * -time approximation the watched threshold started with — which could not tell
 * seeking apart from watching — wherever a provider exposes a video element,
 * and falls back to elapsed time where one does not.
 *
 * Everything here is pure so the thresholds can be tested without a provider,
 * a network or a video.
 */

/** Below this, a position is a false start rather than progress worth keeping. */
const MIN_RESUME_SECONDS = 60

/**
 * How far in the provider may already be before we leave it alone.
 *
 * Some providers restore their own position. Seeking on top of that would fight
 * a feature the site already has, and would land the user somewhere neither of
 * us intended if the two disagree. More than half a minute in on a fresh load
 * means the provider has done the job itself.
 */
const SELF_RESUME_TOLERANCE_SECONDS = 30

/**
 * How much of the end may be missed and still count as finished.
 *
 * The old rule was a flat 50%: halfway through was "watched". That is wrong in
 * both directions. Abandoning a film after an hour marked it watched, and it
 * offered nothing for the ordinary case of stopping four minutes before the end
 * because the story was over and the credits were rolling.
 *
 * What a streaming service actually measures is the distance from the *end*,
 * because that is where the meaningful moment is. The tail scales with the
 * runtime — a 22-minute episode has about a minute of credits, a 150-minute
 * film has eight — and is clamped at both ends, so a very short extra does not
 * have to be watched to the last second and a very long one does not get its
 * final quarter-hour counted as seen.
 */
const CREDITS_FRACTION = 0.06
const MIN_CREDITS_SECONDS = 45
const MAX_CREDITS_SECONDS = 6 * 60

/**
 * A floor, so a mis-reported duration cannot mark something watched instantly.
 *
 * Providers routinely report a duration of a few seconds while the real stream
 * is still resolving. Without this, `duration - tail` is negative, every
 * position clears it, and opening a title for two seconds marks it watched.
 */
const MIN_CREDIBLE_DURATION_SECONDS = 60

/** Seconds of `duration` that may be left unwatched and still count. */
export function creditsTailSeconds(duration: number): number {
  return Math.min(MAX_CREDITS_SECONDS, Math.max(MIN_CREDITS_SECONDS, duration * CREDITS_FRACTION))
}

/**
 * The position at which something counts as watched.
 *
 * Exported because the renderer draws its progress bar against the same number.
 * A bar that reads "full" somewhere other than where the app ticks the title
 * off is the kind of inconsistency people notice and cannot explain.
 *
 * Infinity for an implausible duration, so nothing clears it by accident.
 */
export function watchedThresholdSeconds(duration: number): number {
  if (!Number.isFinite(duration) || duration < MIN_CREDIBLE_DURATION_SECONDS) {
    return Number.POSITIVE_INFINITY
  }
  return duration - creditsTailSeconds(duration)
}

// The key format is shared with the renderer, which draws a film's progress
// bar from a stored point. Re-exported here so this module still reads as the
// whole of resume behaviour.
export { resumeKey } from '@shared/types'
import { resumeKey } from '@shared/types'

/**
 * Is this position worth writing down?
 *
 * Not the first minute, and not past the point it counts as watched. Storing either produces a
 * resume offer that is worse than no offer: one throws away nothing, the other
 * drops the user into the credits.
 */
export function shouldStorePosition(seconds: number, duration: number): boolean {
  if (!Number.isFinite(seconds) || seconds < MIN_RESUME_SECONDS) return false
  if (!Number.isFinite(duration) || duration <= 0) return true
  // The same line that decides "watched", deliberately. A position past it has
  // nothing left to resume *into*, and storing one produces an offer to jump
  // into the credits of something the app has already ticked off.
  return seconds < watchedThresholdSeconds(duration)
}

/**
 * Where the user left this title, if anywhere — the thing a player is asked to
 * start from.
 *
 * `duration` is null when nothing ever read one. Plenty of providers never
 * report it, and the position is still usable in that case: only the "is this
 * past the credits" half of the check goes unanswered.
 */
export interface ResumeOffer {
  seconds: number
  duration: number | null
}

/**
 * The stored position for one episode or film, or null.
 *
 * A separate function from the raw lookup because two things have to be true
 * before a position is worth offering, and only one of them is "a row exists":
 * a zero-second point is written by providers that report a position the
 * instant they load, and resuming into it is indistinguishable from not
 * resuming while costing a query parameter that some providers reject.
 */
export function resumeOfferFor(
  points: readonly { key: string; seconds: number; duration: number }[],
  context: { tmdbId: number; season: number | null; episode: number | null },
): ResumeOffer | null {
  const point = points.find((p) => p.key === resumeKey(context))
  if (point === undefined || !Number.isFinite(point.seconds) || point.seconds <= 0) return null
  return { seconds: point.seconds, duration: point.duration > 0 ? point.duration : null }
}

/** One reading, or as much of one as is available. */
export interface ResumeReading {
  seconds: number
  duration: number
  /** The provider's own `<video>` reached its end. */
  ended?: boolean
}

/**
 * What to do with the stored position, given the latest reading.
 *
 * Three answers, and collapsing two of them into one is the bug this exists to
 * fix. `shouldStorePosition` answers "is this worth writing down", and the
 * caller used to treat every `false` as "delete what you had" — so the memory
 * was thrown away in two cases where nothing had been learned at all:
 *
 * - **No reading.** Plenty of providers nest their player deep enough that no
 *   `<video>` with a duration is ever found. Those providers did not merely
 *   fail to save a position, they erased the one a *working* provider had
 *   stored. Switching source mid-episode and back lost the place entirely,
 *   which is exactly how this was reported.
 * - **A position inside the first minute.** The normal state of a stream that
 *   has just loaded. Leaving a provider two seconds in deleted ten minutes of
 *   remembered progress.
 *
 * Only one case should forget: the title is finished. `keep` is the honest
 * answer to everything else — it says we know nothing new, not that what we
 * knew was wrong.
 */
export type ResumeAction = 'store' | 'forget' | 'keep'

export function resumeAction(reading: ResumeReading | null): ResumeAction {
  // Nothing was read. That is a fact about the provider, not about the title.
  if (reading === null) return 'keep'

  // Watched to the last frame by the element's own account. No threshold gets
  // to argue with that, and a stored position here resumes into the credits.
  if (reading.ended) return 'forget'

  const { seconds, duration } = reading
  if (!Number.isFinite(seconds) || seconds < 0) return 'keep'

  if (Number.isFinite(duration) && duration > 0 && seconds >= watchedThresholdSeconds(duration)) {
    return 'forget'
  }

  // A false start. Says nothing about where the title was really left.
  if (seconds < MIN_RESUME_SECONDS) return 'keep'

  return 'store'
}

/**
 * Should we move the video to the stored position?
 *
 * `current` is where the provider has already put itself. The check against it
 * is the whole point of the tolerance: this only steps in when the provider has
 * *not* restored the position on its own.
 */
export function shouldSeek(saved: number, current: number, duration: number): boolean {
  if (!shouldStorePosition(saved, duration)) return false
  if (!Number.isFinite(current)) return false
  // The provider already resumed; leave its answer alone.
  if (current > SELF_RESUME_TOLERANCE_SECONDS) return false
  // Never seek backwards into something already further along than the memory.
  return saved > current
}

/**
 * Has enough been seen for this to count as watched?
 *
 * Prefers real position over elapsed playing time, because they disagree in
 * exactly the case that matters: skipping ten minutes forward advances the
 * position and not the elapsed time, and leaving a paused tab open advances
 * neither. `playedMs` is the fallback for providers that expose no video
 * element, where elapsed time is the only thing left to go on. It is measured
 * against the same end-relative rule rather than a fraction, using TMDB's
 * runtime — which is why that argument exists at all.
 */
export function isWatchedEnough(args: {
  seconds: number | null
  duration: number | null
  playedMs: number
  runtimeMinutes: number | null
  fallbackMs: number
  /** The provider's own `<video>` reached its end. */
  ended?: boolean
}): boolean {
  const { seconds, duration, playedMs, runtimeMinutes, fallbackMs, ended } = args

  // A video that fired its own `ended` was watched to the last frame by
  // definition; no threshold should get to argue with that.
  if (ended) return true

  if (seconds !== null && duration !== null && duration > 0) {
    return seconds >= watchedThresholdSeconds(duration)
  }

  const runtimeSeconds = (runtimeMinutes ?? 0) * 60
  if (runtimeSeconds >= MIN_CREDIBLE_DURATION_SECONDS) {
    return playedMs / 1000 >= watchedThresholdSeconds(runtimeSeconds)
  }

  // Nothing known about how long it is, so a fixed floor is all that is left.
  return playedMs >= fallbackMs
}
