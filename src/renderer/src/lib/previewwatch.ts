/**
 * How much of a stream preview was watched, and where it got to.
 *
 * The owner (2026-09-29): watching counts "no matter where and for how long
 * was watched and if it was in the preview or full player". Until 2.0.6 a
 * preview counted only after five seconds heard (`PreviewGrace`); now every
 * heard second does, and the preview settles like a play: its place is kept,
 * its time goes into the history, and one that reaches the credits is
 * watched (`preview.keep`).
 *
 * Heard, still: playing with the sound on. A preview running muted while the
 * page is read is not the viewer watching (the owner's rule of 2026-09-27,
 * which this keeps), so it moves nothing.
 *
 * Only heard time is added up, from the film's own clock between reports: a
 * jump (the seek to the saved place, or a source skipping) is not listening.
 * And the place kept is the last one heard, so a stretch that ran on muted
 * afterwards is not skipped over on the way back.
 */

import type { PreviewReport } from '@shared/ipc'

/** More than this between two reports is a jump, not playing: reports come every ~2 s. */
const MAX_STEP_SECONDS = 4

export class PreviewWatch {
  private heard = 0
  private last: number | null = null
  private place: { seconds: number; duration: number } | null = null

  feed(report: PreviewReport): void {
    const audible = report.started && report.playing && !report.muted
    if (audible && this.last !== null) {
      const step = report.seconds - this.last
      if (step > 0 && step <= MAX_STEP_SECONDS) this.heard += step
    }
    this.last = audible ? report.seconds : null
    if (audible) this.place = { seconds: report.seconds, duration: report.duration }
  }

  /** Where the preview was last heard, with how long it was heard in all; null if never. */
  kept(): { seconds: number; duration: number; heardMs: number } | null {
    return this.place && { ...this.place, heardMs: Math.round(this.heard * 1000) }
  }
}
