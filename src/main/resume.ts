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

/*
 * There is no "false start" floor any more. Until 2.0.6 a position under a
 * minute was never written, and the owner asked for the opposite
 * (2026-09-29): watching counts wherever and however briefly it happened.
 * What the floor also did is done by name instead: an advert's clip is told
 * apart by its length (`resumeAction`), and the film's own start before the
 * resume seek has taken is not saved (`ResumeSeek.pending`).
 */

/**
 * How close to the stored position counts as already there.
 *
 * A provider that restores its own position, or honours the start parameter
 * in its URL, lands within a few seconds of ours. Seeking again for that
 * would be a visible jump that gains nothing.
 */
const RESUMED_TOLERANCE_SECONDS = 30

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
 * Shorter than anything the viewer opened: an advert, a trailer, a provider's
 * intro clip, a placeholder length. Only a title TMDB itself calls shorter
 * than ten minutes may be this short.
 *
 * Deliberately not `lengthVerdict`, which also refuses a real stream whose
 * length strays from TMDB's (a long finale against the show's usual runtime):
 * that one is still where the viewer is, and its place is worth keeping.
 */
const ADVERT_SECONDS = 180

export function isAdvertLength(duration: number, runtimeMinutes: number | null): boolean {
  if (!Number.isFinite(duration) || duration <= 0) return false
  if (runtimeMinutes !== null && runtimeMinutes > 0 && runtimeMinutes < 10) return false
  return duration < ADVERT_SECONDS
}

/**
 * Is this position worth writing down, or resuming to?
 *
 * Anything past the very start, and not past the point it counts as watched:
 * a position there produces an offer to drop the user into the credits.
 */
export function shouldStorePosition(seconds: number, duration: number): boolean {
  if (!Number.isFinite(seconds) || seconds <= 0) return false
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
 * - **An advert's clip.** Its reading is a real `<video>` with a real length,
 *   and the wrong one. Storing its second under the episode, or forgetting
 *   the episode at its end, would be believing the advert. Until 2.0.6 a
 *   minute's floor kept most of these out by accident; now their length does
 *   it by name (`isAdvertLength`).
 *
 * Only one case should forget: the title is finished. `keep` is the honest
 * answer to everything else — it says we know nothing new, not that what we
 * knew was wrong.
 */
export type ResumeAction = 'store' | 'forget' | 'keep'

export function resumeAction(reading: ResumeReading | null, runtimeMinutes: number | null = null): ResumeAction {
  // Nothing was read. That is a fact about the provider, not about the title.
  if (reading === null) return 'keep'

  const { seconds, duration } = reading
  // Not the film: an advert, or a placeholder length.
  if (isAdvertLength(duration, runtimeMinutes)) return 'keep'

  // Watched to the last frame by the element's own account. No threshold gets
  // to argue with that, and a stored position here resumes into the credits.
  if (reading.ended) return 'forget'

  if (!Number.isFinite(seconds) || seconds < 0) return 'keep'

  if (Number.isFinite(duration) && duration > 0 && seconds >= watchedThresholdSeconds(duration)) {
    return 'forget'
  }

  // The very start says nothing a stored point could use; see `resumeOfferFor`.
  if (seconds <= 0) return 'keep'

  return 'store'
}

/**
 * Should we move the video to the stored position?
 *
 * `current` is where the provider has already put itself. Only forward, and
 * only when it is not already there.
 *
 * Until 2026-09-27 any provider more than 30s in was left alone, on the
 * theory that it had restored the position itself. But a provider's own
 * memory is per device and per browser, while ours is saved every five
 * seconds and synced within ten. So a provider that resumed where this
 * phone left off yesterday overruled where the desktop left off tonight.
 * Ours wins when it is further along. Behind it, the provider knows
 * something newer and keeps its answer.
 */
export function shouldSeek(saved: number, current: number, duration: number): boolean {
  if (!shouldStorePosition(saved, duration)) return false
  if (!Number.isFinite(current)) return false
  // Already there: the provider resumed by itself, or its URL did it.
  if (Math.abs(saved - current) <= RESUMED_TOLERANCE_SECONDS) return false
  // Never seek backwards into something already further along than the memory.
  return saved > current
}

/** What the phone's relay reads off the film's own element; see `ResumeSeek`. */
export interface FilmTime {
  seconds: number
  duration: number
}

/**
 * One load's attempt to put the video back where it was left.
 *
 * Both platforms' second mechanism, after the provider's URL parameter: the
 * phone's relay (`mobile/src/bridge/mediarelay.ts`) and the desktop's
 * `WebFrameMain` reach the provider's `<video>` in every frame and set its
 * `currentTime`. The desktop sought once, unchecked, until 2.0.6.
 *
 * It checks and retries rather than seeking once, because a seek can simply
 * not take. A player attaching its stream after the first
 * `timeupdate` puts itself back at its own start, and a provider whose URL
 * start was ignored reports zero. Every relay report of the film's time is
 * fed in. The answer is where to seek now, or null for nothing to do yet.
 * It settles for good once the video is where it should be, or once the
 * attempts run out.
 */
export class ResumeSeek {
  /** Enough for a stream that attaches late; few enough not to fight a user who rewinds. */
  static readonly ATTEMPTS = 4
  /** The relay reports every two seconds; this leaves one report for a seek to show. */
  static readonly RETRY_MS = 2_500
  /**
   * How long positions wait for it. A source whose film cannot be reached
   * still posts its position (`playermessage.ts`), and that must not wait
   * for a seek that can never be sent.
   */
  static readonly WAIT_MS = 30_000

  private attempts = 0
  private sentAt = 0
  private settled: boolean

  private readonly startedAt: number

  constructor(
    private readonly target: number,
    /** TMDB's runtime, so an advert's clip is not taken for the film. */
    private readonly runtimeMinutes: number | null,
    now: number = Date.now(),
  ) {
    this.settled = !(target > 0)
    this.startedAt = now
  }

  /** Finished, one way or the other. */
  get done(): boolean {
    return this.settled
  }

  /**
   * The video has not yet been put where it should be, nor given up on.
   * Meanwhile its time is where the provider put it, not where the viewer
   * is, and saving it would write over the very position being restored.
   * Since there is no minute's floor (see the top of this file), this is
   * what keeps the film's first seconds from doing that. For `WAIT_MS` at most.
   */
  pending(now: number = Date.now()): boolean {
    return !this.settled && now - this.startedAt < ResumeSeek.WAIT_MS
  }

  next(time: FilmTime, now: number): number | null {
    if (this.settled) return null
    // No length yet (a seek would be ignored), or an advert or a trailer in
    // the film's place: wait for the episode itself.
    if (!(time.duration > 0) || isAdvertLength(time.duration, this.runtimeMinutes)) return null
    if (!shouldSeek(this.target, time.seconds, time.duration) || this.attempts >= ResumeSeek.ATTEMPTS) {
      this.settled = true
      return null
    }
    // Sent, and not yet had a report's time to show whether it took.
    if (this.attempts > 0 && now - this.sentAt < ResumeSeek.RETRY_MS) return null
    this.attempts += 1
    this.sentAt = now
    return this.target
  }
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

/**
 * What this device last wrote for each resume key, so an unchanged reading is
 * not written again.
 *
 * A paused video reports the same position every time it is asked, and the
 * desktop asks every thirty seconds. Writing it again changes nothing here,
 * but every write stamps the record as new, and resume points sync
 * last-write-wins. So a desktop left paused at 10:00 kept announcing 10:00 as
 * the latest word while the phone carried on to 25:00, and the phone's
 * progress lost. Each repeat was also a disk write, a library reload and a
 * sync.
 *
 * Compared against what *this device* wrote, not against the stored record,
 * because the stored record may be the other device's newer position, which
 * is exactly the one to leave alone.
 */
export class WrittenPositions {
  private readonly last = new Map<string, string>()

  /** True, and remembered, when this differs from what was last written for `key`. */
  isChange(key: string, seconds: number, duration: number): boolean {
    const reading = `${seconds}/${duration}`
    if (this.last.get(key) === reading) return false
    this.last.set(key, reading)
    return true
  }

  /** The point was removed, so the next reading for `key` is new again. */
  forget(key: string): void {
    this.last.delete(key)
  }
}
