/**
 * When a stream preview has been watched rather than glimpsed.
 *
 * The owner's rule (2026-09-27): once a preview has played five seconds
 * with the sound on, it counts. Resume then carries on from where the
 * preview got to, and closing the detail view keeps that place. Muted
 * playing never counts, so a preview left running muted while the page is
 * read changes nothing about where the viewer is.
 *
 * Only heard time is added up, from the film's own clock between reports: a
 * jump (the seek to the saved place, or a source skipping) is not listening.
 * And the place kept is the last one heard, so a stretch that ran on muted
 * after the grace period is not skipped over on the way back.
 */

import type { PreviewReport } from '@shared/ipc'

export const GRACE_SECONDS = 5
/** More than this between two reports is a jump, not playing: reports come every ~2 s. */
const MAX_STEP_SECONDS = 4

export class PreviewGrace {
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
    if (audible && this.heard >= GRACE_SECONDS) {
      this.place = { seconds: report.seconds, duration: report.duration }
    }
  }

  /** Where the preview got to, once past the grace period; null before. */
  kept(): { seconds: number; duration: number } | null {
    return this.place
  }
}
