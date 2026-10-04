/**
 * Library changes that say what they did and offer to take it back.
 *
 * One place for the wording and the undo, so every surface that offers the
 * same action (the detail view, the cards, the Watchlist) says the same thing.
 */
import type { Episode, MediaDetail, MediaSummary } from '@shared/types'
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

/** Take a title off the watchlist, with an Undo that puts it back where it stood. */
export function removeFromWatchlist(title: TitleRef & { title: string }): void {
  const undo = library.removeFromWatchlist(title)
  toast.show(`Removed ${title.title} from your watchlist`, { label: 'Undo', run: undo })
}
