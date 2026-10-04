/**
 * Library changes that say what they did and offer to take it back.
 *
 * One place for the wording and the undo, so every surface that offers the
 * same action (the detail view, the cards, the Watchlist) says the same thing.
 */
import { library, type TitleRef } from './library.svelte'
import { toast } from './toast.svelte'

/** Take a title off the watchlist, with an Undo that puts it back where it stood. */
export function removeFromWatchlist(title: TitleRef & { title: string }): void {
  const undo = library.removeFromWatchlist(title)
  toast.show(`Removed ${title.title} from your watchlist`, { label: 'Undo', run: undo })
}
