/**
 * Handing the next episode to the television, paced by the clock.
 *
 * When the television finishes an episode, the phone steps to the next one
 * and beams it. A beam can only succeed once the source has loaded on the
 * phone and its stream has been captured, so it is tried until it lands or
 * the remote's own budget runs out (the desktop's `TV_NEXT_WAIT_MS`).
 *
 * That loop used to sleep between tries. A backgrounded app's timers run
 * about once a minute (measured, see `progressTick` in `CastPlugin.java`), and
 * a phone casting is usually a phone in a pocket: the 25 s budget was spent by
 * the first sleep, so the next episode got one try, before its source could
 * have loaded.
 *
 * This holds no timers. It answers what to do now, given the time, and is
 * asked by whatever is running: a timer while the app is in front, the
 * television's progress events, which arrive every five seconds from native
 * code, while it is not. At least one try is always made, however late the
 * first question comes.
 */

export interface HandoverPacing {
  /** Nothing is captured for a beat after the source starts loading. */
  firstTryAfterMs: number
  retryEveryMs: number
  giveUpAfterMs: number
}

export const TV_HANDOVER: HandoverPacing = { firstTryAfterMs: 2_000, retryEveryMs: 1_200, giveUpAfterMs: 25_000 }

export type HandoverStep = 'wait' | 'try' | 'give-up'

/** How a try went: landed, worth trying again, or refused for good. */
export type HandoverOutcome = 'ok' | 'retry' | 'final'

export class TvHandover {
  private tries = 0
  private lastTryAt = Number.NEGATIVE_INFINITY
  private trying = false
  private over = false

  constructor(
    private readonly startedAt: number,
    private readonly pacing: HandoverPacing = TV_HANDOVER,
  ) {}

  /** Handed over, refused for good, or given up on. */
  get done(): boolean {
    return this.over
  }

  /** What to do at `now`. A `try` stays in flight until `settle`. */
  next(now: number): HandoverStep {
    if (this.over || this.trying) return 'wait'
    const elapsed = now - this.startedAt
    if (elapsed < this.pacing.firstTryAfterMs) return 'wait'
    if (this.tries > 0 && elapsed >= this.pacing.giveUpAfterMs) {
      this.over = true
      return 'give-up'
    }
    if (now - this.lastTryAt < this.pacing.retryEveryMs) return 'wait'
    this.tries += 1
    this.lastTryAt = now
    this.trying = true
    return 'try'
  }

  settle(outcome: HandoverOutcome): void {
    this.trying = false
    if (outcome !== 'retry') this.over = true
  }
}
