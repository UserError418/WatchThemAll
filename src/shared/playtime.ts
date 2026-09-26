import type { HistoryEntry } from './types'

/**
 * How long an entry counts for.
 *
 * `playedMs` when the settle recorded one. Entries written before 1.5.3 have
 * none, and neither does a play the app never saw the end of — those count as
 * zero minutes rather than being dropped, because they still happened and the
 * timeline should still show them. Anything absurd is discarded: a forgotten
 * player left open overnight would otherwise dominate every total on the
 * screen.
 */
export const MAX_CREDIBLE_PLAY_MS = 6 * 60 * 60 * 1000

export function playedMs(entry: HistoryEntry): number {
  const played = entry.playedMs
  if (typeof played !== 'number' || !Number.isFinite(played) || played <= 0) return 0
  return Math.min(played, MAX_CREDIBLE_PLAY_MS)
}
