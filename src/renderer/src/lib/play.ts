/**
 * Play a title straight from a card, where the detail view's Resume would.
 *
 * The Watchlist card's play button and a Browse card's ▶ both come here, so a
 * card starts what the detail view would: the episode the series picks up at
 * (`pickup.svelte.ts`), on the title's chosen source, listed and written to
 * History the way the detail view's Play does. A series not in the library
 * starts at its first episode, which is what its Resume would offer too.
 *
 * A play that cannot start says why in the toast. The Watchlist card's
 * button used to drop the answer, so a title no enabled source could play
 * did nothing at all when pressed.
 */

import type { MediaSummary } from '@shared/types'
import type { EpisodeRef } from '@shared/progress'
import { library } from './library.svelte'
import { peekListing, settlePickUp } from './pickup.svelte'
import { findEpisode } from './episodecache'
import { toast } from './toast.svelte'

export async function playFromCard(media: MediaSummary): Promise<void> {
  const entry = library.watchlistEntry(media)
  let at: EpisodeRef | null = null
  if (media.type === 'tv') at = entry ? await settlePickUp(entry) : { season: 1, episode: 1 }
  const listed = at ? findEpisode(peekListing(media.tmdbId, at.season) ?? [], at.season, at.episode) : null

  const result = await window.wta.play({
    tmdbId: media.tmdbId,
    imdbId: entry?.imdbId ?? media.imdbId ?? null,
    type: media.type,
    title: media.title,
    season: at?.season ?? null,
    episode: at?.episode ?? null,
    providerId: entry?.providerId ?? library.settings.defaultProviderId,
    // The episode's own runtime when its listing is in; main falls back on
    // the title's when this is null.
    runtimeMinutes: listed?.runtime ?? null,
  })
  if (!result.ok) {
    toast.show(result.error ?? `Could not play ${media.title}`)
    return
  }

  // Playing lists a title (decided 2026-09-26), and History starts its row now.
  library.addToWatchlist(media)
  library.recordWatch(media, at?.season ?? null, at?.episode ?? null)
}
