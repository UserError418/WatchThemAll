/**
 * Where each trailer preview got to, remembered for about a minute.
 *
 * A trailer is the same thirty seconds of footage every time it starts from
 * zero. Hovering a card and then opening it used to show those seconds twice
 * in a row — once in the card, once more in the detail overlay — and hovering
 * the same card again a moment later showed them a third time. Every preview
 * surface now starts a video from wherever the last preview of that video was
 * left, as long as that was recent.
 *
 * ## Why a minute, and why only in memory
 *
 * The point is continuity within one gesture: card, then detail, then back to
 * the row. After a minute the user has moved on, and starting a trailer they
 * return to from somewhere in the middle would look like a bug rather than a
 * feature — so the entry simply expires and the trailer plays from the top
 * again. Nothing here is worth persisting or syncing for the same reason.
 *
 * ## Why this is keyed by video, not by title or surface
 *
 * A card and the detail overlay for the same title get their trailer from the
 * same TMDB pick, so they share a YouTube id; keying on the id is what lets a
 * position recorded by one surface be picked up by the other without either
 * knowing the other exists.
 *
 * Pure on purpose — no Svelte, no DOM, an injectable clock — so the expiry
 * rule can be tested without waiting a minute. `TrailerEmbed.svelte` is the
 * only writer and reader.
 */

/** How long a remembered position stays usable after the last report. */
export const RESUME_WINDOW_MS = 60_000

interface Entry {
  /** Seconds into the video. */
  seconds: number
  /** Clock reading (ms) when this was recorded; the window runs from here. */
  at: number
}

export class TrailerPositions {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly windowMs: number = RESUME_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Remember that `videoKey` was at `seconds`, as of now.
   *
   * Called repeatedly while a preview plays, not only when it stops: a card's
   * preview can still be running when the detail overlay for the same title
   * mounts its own, and the overlay must pick up where the card is, not where
   * it was when it last stopped.
   */
  record(videoKey: string, seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return
    this.forgetExpired()
    this.entries.set(videoKey, { seconds, at: this.now() })
  }

  /** Where to resume `videoKey`, or null if nothing recent is known. */
  lookup(videoKey: string): number | null {
    const entry = this.entries.get(videoKey)
    if (!entry) return null
    if (this.expired(entry)) {
      this.entries.delete(videoKey)
      return null
    }
    return entry.seconds
  }

  private expired(entry: Entry): boolean {
    return this.now() - entry.at > this.windowMs
  }

  /** Keeps the map to what a lookup could still return; a session hovers hundreds of cards. */
  private forgetExpired(): void {
    for (const [key, entry] of this.entries) {
      if (this.expired(entry)) this.entries.delete(key)
    }
  }
}

/**
 * The position a player has reached by now, from its last report.
 *
 * YouTube reports `currentTime` about four times a second, so the last report
 * can be a quarter of a second old by the time a preview is torn down. While
 * it was playing, the video kept moving in that gap; while paused or
 * buffering, it did not.
 */
export function positionNow(
  report: { seconds: number; at: number },
  playing: boolean,
  now: number,
): number {
  if (!playing) return report.seconds
  return report.seconds + Math.max(0, now - report.at) / 1000
}

/**
 * The embed URL's `start` value for a remembered position, or null for "from
 * the top".
 *
 * Whole seconds because that is all the parameter accepts — measured, a
 * fractional `start=37.6` is ignored outright and the video plays from 0.
 * Rounded rather than floored so the error is at most half a second either
 * way, instead of up to a full second of footage shown twice.
 */
export function startParameter(seconds: number | null): number | null {
  if (seconds === null) return null
  const whole = Math.round(seconds)
  return whole > 0 ? whole : null
}

/** Shared by every preview surface; see the module comment. */
export const trailerPositions = new TrailerPositions()
