/**
 * The provider scan, as the UI sees it.
 *
 * A scan is started from two places — the detail view's source picker and the
 * player's own source menu — and both draw its result. Neither can own the
 * state: the user starts a scan in the detail view, presses play while it runs,
 * and the player has to pick up a run it did not begin. So the live run lives
 * here, one subscription for the whole renderer, and both surfaces read it.
 *
 * ## Why this matches on `TitleRef` rather than on the key
 *
 * Main identifies a scan by `titleKey` — `tv:tt0903747` — and the renderer
 * cannot build one. `outcomes.ts` is a main-process module and the renderer has
 * no `@main` alias, deliberately: the business layer is not the renderer's to
 * import. Re-implementing the key here would be a second definition of identity
 * that agrees until the day someone changes the separator.
 *
 * So the comparison is done on the parts the renderer already holds. That is
 * not a weaker check — `titleKey` is derived from exactly these fields — it
 * just keeps the derivation in one process.
 */

import type { ProbeVerdict, ProviderScanProgress, ScanReason, TitleRef } from '@shared/ipc'

/** Whether two title references mean the same title. Mirrors `titleKey`'s inputs. */
function sameTitle(a: TitleRef | null, b: TitleRef | null): boolean {
  if (!a || !b) return false
  if (a.type !== b.type) return false
  // IMDB id wins when both carry one, for the same reason `titleKey` prefers
  // it: a title opened from an IMDB-sourced summary may not have a TMDB id yet.
  if (a.imdbId && b.imdbId) return a.imdbId === b.imdbId
  return a.tmdbId !== 0 && a.tmdbId === b.tmdbId
}

class ProviderScanState {
  /** The title the running scan is measuring, or the last one measured. */
  private subject = $state<TitleRef | null>(null)

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
  /** The provider being measured right now, for the status line. */
  current = $state<string | null>(null)
  /** Set when the last run was stopped by the user rather than finishing. */
  cancelled = $state(false)
  /** The run is re-checking a provider that looked dead. */
  confirming = $state(false)

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
      this.verdicts = progress.verdicts
      this.timings = progress.timings
      this.qualities = progress.qualities
      this.reasons = progress.reasons
      this.done = progress.done
      this.total = progress.total
      this.current = progress.providerName
      this.confirming = progress.confirming
      this.cancelled = progress.cancelled
      this.running = !progress.finished
    })
  }

  /** Whether the live run describes the title a surface is showing. */
  matches(media: TitleRef): boolean {
    return sameTitle(this.subject, media)
  }

  /**
   * Measure every enabled provider for this title.
   *
   * The episode is passed through because coverage is episode-level — a
   * provider routinely carries a series' first season and not its fourth — so
   * scanning "the show" without saying which episode would measure whichever
   * one the probe happened to build a URL for.
   */
  async start(media: TitleRef, episode: { season: number; episode: number } | null): Promise<void> {
    this.subject = media
    this.verdicts = {}
    this.timings = {}
    this.qualities = {}
    this.reasons = {}
    this.done = 0
    this.cancelled = false
    this.running = true
    this.current = null
    this.confirming = false

    try {
      await window.wta.providers.scan(media, episode)
    } finally {
      // The finished event normally clears this. Doing it here too means a
      // rejected call cannot leave the button spinning forever.
      this.running = false
    }
  }

  async cancel(): Promise<void> {
    await window.wta.providers.cancelScan()
    this.running = false
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
    this.current = null
    this.cancelled = false
  }
}

export const scan = new ProviderScanState()
