<script lang="ts">
  /**
   * "Continue Watching" — the only row sourced from the user's own data rather
   * than TMDB, and the reason the app is opened most of the time.
   *
   * Ordered by most recently watched, using the history timeline rather than
   * the watchlist's own order: the thing you watched last night should be
   * first, regardless of when it was added.
   *
   * "Up next" is where the series picks up by the rule the detail view's
   * Resume and the Watchlist card use (`pickup.svelte.ts`). It used to read the
   * episode last *started*, which is usually one already finished, so it
   * named an episode the user had watched.
   *
   * The bar is the series' share of episodes watched, against the episode
   * count the detail view stores on the entry — the Watchlist card's figure.
   * It used to be ticks in the current season against the furthest episode
   * reached, which is 100% for anyone watching in order.
   */
  import type { MediaSummary, WatchlistEntry } from '@shared/types'
  import { activityOf, indexHistory } from '@shared/watchlistrank'
  import { library } from '../lib/library.svelte'
  import { seriesPickUp } from '../lib/pickup.svelte'
  import { episodeCode } from '../lib/format'
  import TitleCard from './TitleCard.svelte'
  import RowShell from './RowShell.svelte'

  interface Props {
    onselect: (media: MediaSummary) => void
  }

  const { onselect }: Props = $props()

  interface Resumable {
    entry: WatchlistEntry
    media: MediaSummary
    subtitle: string
    progress: number
  }

  const items = $derived.by<Resumable[]>(() => {
    // The most recent play per title decides the order.
    const played = indexHistory(library.history)

    return library.listedWatchlist
      .filter((entry) => entry.watchedEpisodes.length > 0 || played.lastAt.has(entry.tmdbId))
      .sort((a, b) => (played.lastAt.get(b.tmdbId) ?? 0) - (played.lastAt.get(a.tmdbId) ?? 0))
      .slice(0, 20)
      .map((entry) => {
        const media: MediaSummary = {
          tmdbId: entry.tmdbId,
          type: entry.type,
          title: entry.title,
          posterPath: entry.posterPath,
          backdropPath: null,
          overview: '',
          rating: 0,
          releaseDate: null,
          genreIds: entry.genreIds,
        }

        if (entry.type === 'movie') {
          return { entry, media, subtitle: 'Film', progress: library.filmProgress(entry.tmdbId)?.percent ?? 0 }
        }

        // No bar until the detail view has stored the episode count: a share
        // of an unknown total is not a number worth drawing.
        const fraction = activityOf(entry, played).fraction
        const { target } = seriesPickUp(entry)
        return {
          entry,
          media,
          subtitle: `Up next · ${episodeCode(target.season, target.episode)}`,
          progress: fraction === null ? 0 : fraction * 100,
        }
      })
  })
</script>

{#if items.length > 0}
  <RowShell title="Continue Watching" empty={false} loaded>
    {#each items as item (item.entry.id)}
      <TitleCard
        media={item.media}
        {onselect}
        subtitle={item.subtitle}
        progress={item.progress}
      />
    {/each}
  </RowShell>
{/if}
