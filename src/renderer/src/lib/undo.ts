/**
 * Library changes that say what they did and offer to take it back.
 *
 * One place for the wording and the undo, so every surface that offers the
 * same action (the detail view, the cards, the Watchlist) says the same thing.
 */
import type { Episode, HistoryEntry, MediaDetail, MediaSummary } from '@shared/types'
import { library, type TitleRef } from './library.svelte'
import { toast } from './toast.svelte'

/** "The Office season 3", or the film's title: what a Watched toast is about. */
function seenScope(title: string, season: number | null): string {
  return season === null ? title : `${title} season ${season}`
}

/** File a season (or a film) as watched, with an Undo; returns the undo too. */
export function markSeen(
  media: MediaSummary | MediaDetail,
  season: number | null,
  episodes: ReadonlyArray<Pick<Episode, 'episode' | 'airDate'>> = [],
): () => void {
  const undo = library.markSeen(media, season, episodes)
  toast.show(`Marked ${seenScope(media.title, season)} watched`, { label: 'Undo', run: undo })
  return undo
}

/** Take a season (or a film) out of Watched, with an Undo. */
export function unmarkSeen(media: MediaSummary | MediaDetail, season: number | null): void {
  const undo = library.unmarkSeen(media, season)
  toast.show(`Took ${seenScope(media.title, season)} out of Watched`, { label: 'Undo', run: undo })
}

/** Remove Watched records (a title's row, or a season's), with an Undo. */
export function removeWatched(ids: readonly string[], what: string): void {
  const undo = library.removeWatchedEntries(ids)
  toast.show(`Removed ${what} from Watched`, { label: 'Undo', run: undo })
}

/**
 * The detail view's "Mark season watched" and "Clear season", with an Undo.
 *
 * Marking ticks the aired episodes (`library.markSeasonWatched`); clearing
 * takes every tick off. Either can wipe a season's worth of ticks in one
 * press, so each says so and offers to put back exactly the episodes it
 * changed.
 */
export function setSeasonTicks(
  media: MediaSummary | MediaDetail,
  season: number,
  episodes: ReadonlyArray<Pick<Episode, 'episode' | 'airDate'>>,
  watched: boolean,
): void {
  const before = new Set(episodes.filter((e) => library.isWatched(media, season, e.episode)).map((e) => e.episode))
  if (watched) library.markSeasonWatched(media, season, episodes)
  else library.setSeasonWatched(media, season, episodes.map((e) => e.episode), false)

  const changed = episodes
    .map((e) => e.episode)
    .filter((episode) => library.isWatched(media, season, episode) !== before.has(episode))
  if (changed.length === 0) return
  toast.show(`${watched ? 'Ticked' : 'Cleared'} ${seenScope(media.title, season)}`, {
    label: 'Undo',
    run: () => library.setSeasonWatched(media, season, changed, !watched),
  })
}

/** Empty History, with an Undo; the confirmation before it stays. */
export function clearHistory(): void {
  const undo = library.clearHistory()
  toast.show('Cleared your history', { label: 'Undo', run: undo })
}

/** Remove one row from History, with an Undo. */
export function removeHistoryEntry(entry: Pick<HistoryEntry, 'id' | 'title'>): void {
  const undo = library.removeHistoryEntry(entry.id)
  toast.show(`Removed ${entry.title} from your history`, { label: 'Undo', run: undo })
}

/** Take a title off the watchlist, with an Undo that puts it back where it stood. */
export function removeFromWatchlist(title: TitleRef & { title: string }): void {
  const undo = library.removeFromWatchlist(title)
  toast.show(`Removed ${title.title} from your watchlist`, { label: 'Undo', run: undo })
}
