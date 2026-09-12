<script lang="ts">
  /**
   * "Continue Watching" — the only row sourced from the user's own data rather
   * than TMDB, and the reason the app is opened most of the time.
   *
   * Ordered by most recently watched, using the history timeline rather than
   * the watchlist's own order: the thing you watched last night should be
   * first, regardless of when it was added.
   *
   * Progress needs the episode count, which the watchlist entry does not store.
   * Rather than fetching detail for every entry — the mistake the original's
   * recommendation engine made at ~31 requests a load — the bar is drawn from
   * watched-episode count against the highest season/episode seen so far, and
   * omitted when there is nothing to compare against.
   */
  import type { MediaSummary, WatchlistEntry } from '@shared/types'
  import { library } from '../lib/library.svelte'
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
    // Most recent history entry per title decides the order. A plain record,
    // not a Map — this is a local accumulator, never reactive state.
    const lastWatched: Record<number, number> = {}
    for (const event of library.history) {
      lastWatched[event.tmdbId] ??= event.watchedAt
    }

    return library.watchlist
      .filter((entry) => entry.watchedEpisodes.length > 0 || lastWatched[entry.tmdbId] != null)
      .sort((a, b) => (lastWatched[b.tmdbId] ?? 0) - (lastWatched[a.tmdbId] ?? 0))
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
          return { entry, media, subtitle: 'Film', progress: 0 }
        }

        // Highest episode number marked in the current season, as a stand-in
        // for the season length we have not fetched.
        const seasonPrefix = `${entry.lastSeason ?? 1}:`
        const inSeason = entry.watchedEpisodes
          .filter((key) => key.startsWith(seasonPrefix))
          .map((key) => Number(key.slice(seasonPrefix.length)))
        const furthest = Math.max(entry.lastEpisode ?? 1, ...inSeason, 1)
        const progress = furthest > 1 ? (inSeason.length / furthest) * 100 : 0

        return {
          entry,
          media,
          subtitle: `Up next · ${episodeCode(entry.lastSeason ?? 1, entry.lastEpisode ?? 1)}`,
          progress,
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
