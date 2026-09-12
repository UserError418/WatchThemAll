/**
 * The video stopped moving. Did the provider break, or is this normal?
 *
 * Every other watchdog in `playerview.ts` asks "has anything played *yet*", and
 * each one is deliberately void the moment something has. That leaves the
 * failure these hosts produce most often entirely uncovered: the stream dies
 * *during* playback. A segment 404s, the CDN drops the socket, the page's own
 * player throws, the renderer is killed outright — the picture freezes on the
 * last decoded frame, no navigation fails, no status code comes back, and the
 * app sits there looking perfectly healthy. The user is the error handler.
 *
 * The one fact available is the position, which is already polled every four
 * seconds for other reasons. All of the work is in not crying wolf, because
 * three entirely ordinary things also stop the position dead:
 *
 * - The user pressed pause.
 * - The title reached its end.
 * - It is buffering — which on these hosts routinely takes ten seconds or more
 *   and is not a failure at all.
 *
 * The first two are separable with one flag each off the element. The third is
 * separable only by waiting, exactly as the pre-playback silence detector
 * waits, so this waits too.
 *
 * Kept as a pure reducer so `playbackstall.test.ts` can drive a stream of
 * readings directly. Waiting for a third party's CDN to drop a segment at the
 * right moment is not a test.
 */

/**
 * What the poll saw. Structurally compatible with `VideoPosition`, declared
 * here rather than imported so the decision does not depend on the player.
 */
export interface StallReading {
  seconds: number
  /** The element reached its own end. */
  ended: boolean
  /** The element is paused — which on these players means the user paused it. */
  paused: boolean
}

/**
 * How long a frozen position is tolerated before it counts as a failure.
 *
 * Set against buffering rather than against impatience. These embeds stall for
 * five to fifteen seconds routinely while they resolve the next segment, and a
 * prompt during one of those is the exact behaviour the switching logic has
 * already been criticised for once. Thirty seconds is seven polls: long enough
 * that no ordinary buffer reaches it, short enough that a dead stream does not
 * become the user's problem to diagnose.
 */
export const STALL_GRACE_MS = 30_000

/**
 * The smallest advance that counts as progress.
 *
 * Not zero. A player that is genuinely playing moves about four seconds per
 * poll, so any sane floor is invisible to it — but a frozen element that still
 * reports microsecond jitter in `currentTime` would defeat an exact comparison
 * and the watchdog would never fire at all.
 */
const PROGRESS_EPSILON_SECONDS = 0.25

export interface StallWatch {
  /** The position at the last poll that showed movement. */
  lastSeconds: number | null
  /** When that was. */
  movedAt: number
  /** Whether this freeze has already been reported, so it is reported once. */
  reported: boolean
}

export function beginStallWatch(now: number): StallWatch {
  return { lastSeconds: null, movedAt: now, reported: false }
}

export interface StallObservation {
  watch: StallWatch
  /**
   * True on the single poll where the freeze crosses the grace period. Stays
   * false afterwards until the position moves again, because a stalled video
   * polled every four seconds would otherwise raise the same prompt forever.
   */
  stalled: boolean
}

/**
 * Fold one poll into the watch.
 *
 * `reading` is null when no frame held a video with a real duration. While
 * playback is under way that is not "no video yet" — it is the element having
 * disappeared, which is what a torn-down player or a dead renderer looks like
 * from here. So it counts as frozen rather than as an absence of evidence.
 *
 * The caller is responsible for only folding readings once playback has
 * started; before that, silence is the other detector's business.
 */
export function observeStall(
  watch: StallWatch,
  reading: StallReading | null,
  now: number,
): StallObservation {
  // Finished, or deliberately paused. Both are the user's world working as
  // intended, and both reset the clock — resuming from a long pause must not
  // arrive already stalled.
  if (reading !== null && (reading.ended || reading.paused)) {
    return {
      watch: { lastSeconds: reading.seconds, movedAt: now, reported: false },
      stalled: false,
    }
  }

  const moved =
    reading !== null &&
    (watch.lastSeconds === null ||
      Math.abs(reading.seconds - watch.lastSeconds) >= PROGRESS_EPSILON_SECONDS)

  if (moved) {
    return {
      watch: { lastSeconds: reading.seconds, movedAt: now, reported: false },
      stalled: false,
    }
  }

  const frozenFor = now - watch.movedAt
  if (watch.reported || frozenFor < STALL_GRACE_MS) {
    return { watch, stalled: false }
  }

  return { watch: { ...watch, reported: true }, stalled: true }
}

/** How long the position has been frozen, for the message the user reads. */
export function frozenSeconds(watch: StallWatch, now: number): number {
  return Math.round((now - watch.movedAt) / 1000)
}
