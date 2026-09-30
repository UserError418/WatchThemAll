/**
 * How much of a stream preview was watched, and where it got to.
 *
 * The owner (2026-09-29): watching counts "no matter where and for how long
 * was watched and if it was in the preview or full player". Until 2.0.6 a
 * preview counted only after five seconds heard (`PreviewGrace`); now every
 * second it plays does, and the preview settles like a play: its place is kept,
 * its time goes into the history, and one that reaches the credits is
 * watched (`preview.keep`).
 *
 * Muted counts too (the owner, 2026-09-30, replacing the owner's own rule of
 * 2026-09-27 that only heard time counted). The known cost, stated at the time: a
 * preview left running while the page is read moves the place on past what
 * was looked at.
 *
 * Only playing time is added up, from the film's own clock between reports:
 * a jump (the seek to the saved place, or a source skipping) is not watching.
 */

import type { PreviewReport } from '@shared/ipc'

/** More than this between two reports is a jump, not playing: reports come every ~2 s. */
const MAX_STEP_SECONDS = 4

export class PreviewWatch {
  private watched = 0
  private last: number | null = null
  private place: { seconds: number; duration: number } | null = null

  feed(report: PreviewReport): void {
    const playing = report.started && report.playing
    if (playing && this.last !== null) {
      const step = report.seconds - this.last
      if (step > 0 && step <= MAX_STEP_SECONDS) this.watched += step
    }
    this.last = playing ? report.seconds : null
    if (playing) this.place = { seconds: report.seconds, duration: report.duration }
  }

  /** Where the preview last played, with how long it played in all; null if it never did. */
  kept(): { seconds: number; duration: number; playedMs: number } | null {
    return this.place && { ...this.place, playedMs: Math.round(this.watched * 1000) }
  }
}
