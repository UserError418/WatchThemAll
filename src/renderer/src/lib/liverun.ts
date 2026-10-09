/**
 * When a test run's own results, rather than the stored ones, colour a source list.
 *
 * A run reports as each source settles (`ProviderScanProgress`), and a list
 * showing what the run measures draws those verdicts at once, so the dots
 * fill in one by one instead of all at the end. Until 2026-10 nothing ever
 * stopped a list doing so. The detail view's picker matched a run by title
 * alone and kept the last one it heard for the rest of the session, of any
 * episode and even a cancelled one; the player's list kept it until an
 * episode step. So a row Automatic puts first could show red because a run
 * of another episode found it dead, and an episode never tested could show
 * green.
 *
 * Two rules now, shared by the detail view's picker and the player's list:
 *
 * - **A run describes only what it measured**: its title, and its episode.
 *   A film has no episode.
 * - **Once a run is over, the stored results decide**, from the moment the
 *   list has read them again. They are what Automatic orders by
 *   (`providerRank` over `titleResults`), so from then on the dots and the
 *   order cannot disagree. Until that read lands the run's verdicts stay up,
 *   so the list does not fall back for a moment to the results from before
 *   the run.
 *
 * Plain functions over plain values, so the rules are tested here
 * (`liverun.test.ts`) and the components only hold the state.
 */

import type { ProviderScanProgress, TitleRef } from '@shared/ipc'
import { progressIsAbout } from '@shared/scanprogress'
import { titleKey } from '@shared/titlekey'

export interface EpisodeRef {
  season: number
  episode: number
}

/** The title and episode a run measures, as its progress names them. */
export type RunSubject = Pick<ProviderScanProgress, 'titleKey' | 'episode'>

/** What a list knows about the last run it heard. */
export interface LiveRun {
  /** What the run measures, or null when no run has spoken. */
  subject: RunSubject | null
  running: boolean
  /** Runs finished or cancelled so far, counted as each one's last progress arrives. */
  finished: number
}

/**
 * Whether a run measures this title and episode.
 *
 * By `titleKey`, the key the run's results are filed under and the list's
 * stored results read by, so a run that applies here is one whose results
 * the list will read back once it is over. The episode by the same rule as
 * main uses to choose which runs the player's list hears (`progressIsAbout`).
 */
export function runIsAbout(
  subject: RunSubject | null,
  media: TitleRef,
  episode: EpisodeRef | null,
): boolean {
  if (subject === null) return false
  const key = titleKey(media)
  // A film has no episode, whatever was put beside it.
  if (media.type === 'movie') return subject.titleKey === key
  return progressIsAbout(subject, key, episode)
}

/**
 * Whether a list draws the live run's verdicts rather than its stored results.
 *
 * `readAfter` is the run count (`LiveRun.finished`) as it stood when the list
 * *asked* for the stored results it holds now. A read asked for before a run
 * was over cannot contain that run's results, however late it lands.
 */
export function liveRunApplies(
  run: LiveRun,
  media: TitleRef,
  episode: EpisodeRef | null,
  readAfter: number,
): boolean {
  if (!runIsAbout(run.subject, media, episode)) return false
  return run.running || readAfter < run.finished
}
