/**
 * At most once per interval, and never a request left behind.
 *
 * What the positions push needs, and what a debounce cannot give it: the
 * position is written every five seconds while something plays, and a
 * debounce waits for the writes to *stop* — so it would push nothing until
 * the episode ended. A throttle pushes the first change at once and then no
 * more than once per interval; a request arriving inside the interval is
 * carried out when the interval ends, so the last position always goes out.
 */

export interface Throttle {
  /** Ask for a run: now if the interval has passed, else when it does. */
  request(): void
  /** Run now, whatever the interval says — for a stop, an exit, a pause. */
  now(): void
  /** Drop a waiting run. */
  cancel(): void
}

export interface ThrottleClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: ThrottleClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function throttle(task: () => void, intervalMs: number, clock: ThrottleClock = realClock): Throttle {
  let lastRun = -Infinity
  let waiting: unknown = null

  const run = (): void => {
    if (waiting !== null) clock.clearTimeout(waiting)
    waiting = null
    lastRun = clock.now()
    task()
  }

  return {
    request() {
      const due = lastRun + intervalMs - clock.now()
      if (due <= 0) {
        run()
        return
      }
      waiting ??= clock.setTimeout(run, due)
    },
    now: run,
    cancel() {
      if (waiting !== null) clock.clearTimeout(waiting)
      waiting = null
    },
  }
}
