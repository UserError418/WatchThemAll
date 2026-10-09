/**
 * The provider scan, as the UI sees it.
 *
 * A scan is started from two places — the detail view's source picker and the
 * player's own source menu — and both draw its result. Neither can own the
 * state: the user starts a scan in the detail view, presses play while it runs,
 * and the player has to pick up a run it did not begin. So the live run lives
 * here, one subscription for the whole renderer, and both surfaces read it.
 *
 * ## Which run a list draws, and for how long
 *
 * Only a run of the title *and episode* the list shows, and once that run is
 * over only until the list has read its stored results again: see
 * `liverun.ts`. Matched by `titleKey`, the key the run's results are filed
 * under (`@shared/titlekey`). This used to compare the title's parts, while
 * the renderer could not build a key; that also matched a run filed under a
 * different key from the one the list reads, so its verdicts would vanish
 * from the list once it was over.
 */

import type { ProbeVerdict, ProviderScanProgress, ScanInFlight, ScanReason, TitleRef } from '@shared/ipc'
import { titleKey } from '@shared/titlekey'
import { liveRunApplies, runIsAbout, type EpisodeRef, type RunSubject } from './liverun'

class ProviderScanState {
  /** The title and episode the running scan is measuring, or the last ones measured. */
  private subject = $state.raw<RunSubject | null>(null)

  /** Verdicts settled so far. Replaced wholesale, never mutated in place. */
  verdicts = $state<Record<string, ProbeVerdict>>({})
  /** Milliseconds to the first media request, for each provider that streamed. */
  timings = $state<Record<string, number>>({})
  /** Best quality class offered, for each provider whose stream says. */
  qualities = $state<Record<string, number>>({})
  /** Why each settled source that did not stream failed. */
  reasons = $state<Record<string, ScanReason>>({})

  running = $state(false)
  done = $state(0)
  total = $state(0)
  /** Every provider under test right now — several at once, see `ProviderScanProgress.testing`. */
  testing = $state<ScanInFlight[]>([])
  /** Set when the last run was stopped by the user rather than finishing. */
  cancelled = $state(false)
  /**
   * Runs finished or cancelled since the renderer started. A list notes it
   * when it asks for its stored results, so it knows whether they can hold
   * the last run's (`liveRunApplies`).
   */
  finished = $state(0)

  /**
   * Start listening once, for the life of the renderer.
   *
   * Called from `main.ts` rather than from a component `$effect`, because both
   * surfaces that show a scan can be unmounted while one is still running —
   * that is the whole case this class exists for — and a subscription tied to
   * either would miss the rest of the run.
   */
  listen(): void {
    window.wta.on.providerScan((progress: ProviderScanProgress) => {
      // Follow the run that is speaking. Runs the viewer did not start (a
      // first watch's, an addition's) speak here too, and with the subject
      // left at the title last tested by hand, their verdicts showed as
      // that title's.
      this.subject = { titleKey: progress.titleKey, episode: progress.episode }
      this.verdicts = progress.verdicts
      this.timings = progress.timings
      this.qualities = progress.qualities
      this.reasons = progress.reasons
      this.done = progress.done
      this.total = progress.total
      this.testing = progress.testing
      this.cancelled = progress.cancelled
      if (progress.finished) this.end()
      else this.running = true
    })
  }

  /**
   * The run is over: finished, cancelled here, or its call failed. Counted
   * once, whichever of those comes first. Stop sets this before main's last
   * report arrives, and counting that report again would put the run's
   * verdicts back up over results the list had already read afresh.
   */
  private end(): void {
    if (!this.running) return
    this.running = false
    this.finished += 1
  }

  /** The provider's test in progress, if it is under test right now. */
  inFlight(providerId: string): ScanInFlight | undefined {
    return this.testing.find((test) => test.providerId === providerId)
  }

  /** Whether the live run measures (or last measured) this title and episode. */
  isAbout(media: TitleRef, episode: EpisodeRef | null): boolean {
    return runIsAbout(this.subject, media, episode)
  }

  /**
   * Whether a list draws the live run rather than its stored results:
   * `readAfter` is `finished` as it was when the list asked for them. See
   * `liveRunApplies`.
   */
  overrides(media: TitleRef, episode: EpisodeRef | null, readAfter: number): boolean {
    return liveRunApplies(
      { subject: this.subject, running: this.running, finished: this.finished },
      media,
      episode,
      readAfter,
    )
  }

  /**
   * Measure every enabled provider for this title.
   *
   * The episode is passed through because coverage is episode-level — a
   * provider routinely carries a series' first season and not its fourth — so
   * scanning "the show" without saying which episode would measure whichever
   * one the probe happened to build a URL for.
   */
  async start(media: TitleRef, episode: EpisodeRef | null): Promise<void> {
    this.subject = { titleKey: titleKey(media), episode: media.type === 'tv' ? episode : null }
    this.verdicts = {}
    this.timings = {}
    this.qualities = {}
    this.reasons = {}
    this.done = 0
    this.cancelled = false
    this.running = true
    this.testing = []

    try {
      await window.wta.providers.scan(media, episode)
    } finally {
      // The finished event normally clears this. Doing it here too means a
      // rejected call cannot leave the button spinning forever.
      this.end()
    }
  }

  async cancel(): Promise<void> {
    await window.wta.providers.cancelScan()
    this.end()
  }

  /** Forget the last run, so a surface for another title starts blank. */
  reset(): void {
    this.subject = null
    this.verdicts = {}
    this.timings = {}
    this.qualities = {}
    this.reasons = {}
    this.done = 0
    this.total = 0
    this.testing = []
    this.cancelled = false
  }
}

export const scan = new ProviderScanState()
