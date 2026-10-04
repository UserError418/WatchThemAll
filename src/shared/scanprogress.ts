/**
 * Which surface a source test's progress belongs on.
 *
 * Main (and the phone's bridge) send every run to everything that draws dots,
 * and two kinds of run are going on at once: the one the viewer started, and
 * the automatic ones (a first watch, an addition to the watchlist). Drawn from
 * whichever run spoke last, a list showed another title's or another
 * episode's verdicts, timings and "Testing…" as its own.
 *
 * Plain logic, shared by both platforms, so the phone's chrome filters by the
 * same rule as the desktop's.
 */

import type { ProviderScanProgress } from './ipc'

/**
 * Whether a run's progress is about what a player is showing: the same
 * title, and the same episode where the progress names one.
 */
export function progressIsAbout(
  progress: Pick<ProviderScanProgress, 'titleKey' | 'episode'>,
  titleKey: string,
  episode: { season: number; episode: number } | null,
): boolean {
  if (progress.titleKey !== titleKey) return false
  if (progress.episode === undefined) return true
  return progress.episode?.season === episode?.season && progress.episode?.episode === episode?.episode
}
