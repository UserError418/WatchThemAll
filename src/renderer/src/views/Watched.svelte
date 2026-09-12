<script lang="ts">
  /**
   * Everything the user has already seen.
   *
   * Distinct from the History section in the Watchlist tab, and the distinction
   * matters: History is an append-only log of *play events* written by the
   * player, one row per episode opened here. This is a title-level library —
   * "I have watched this" — which is mostly things that were never played
   * through this app at all. Imports land here; so does a series finished
   * years ago on something else.
   *
   * It is also where rating happens, because this is the only surface where the
   * user is looking at a list of things they have an opinion about. Asking for
   * a rating anywhere else means asking about something they have not seen.
   */
  import type { MediaSummary, WatchedEntry } from '@shared/types'
  import { library } from '../lib/library.svelte'
  import { posterUrl } from '../lib/images'
  import RateButtons from '../components/RateButtons.svelte'

  interface Props {
    onselect: (media: MediaSummary) => void
  }

  const { onselect }: Props = $props()

  type Filter = 'all' | 'unrated' | 'liked' | 'disliked'

  let filter = $state<Filter>('all')
  let query = $state('')

  /** A WatchedEntry is nearly a MediaSummary; the overlay needs the rest. */
  function asMedia(entry: WatchedEntry): MediaSummary {
    return {
      tmdbId: entry.tmdbId,
      imdbId: entry.imdbId,
      type: entry.type,
      title: entry.title,
      posterPath: entry.posterPath,
      backdropPath: null,
      overview: '',
      releaseDate: null,
      rating: 0,
      genreIds: entry.genreIds,
    }
  }

  const visible = $derived.by(() => {
    const needle = query.trim().toLowerCase()
    return library.watched.filter((entry) => {
      if (needle && !entry.title.toLowerCase().includes(needle)) return false
      const rating = library.ratingFor(entry.tmdbId)
      if (filter === 'unrated') return rating === null
      if (filter === 'liked') return rating === 'like'
      if (filter === 'disliked') return rating === 'dislike'
      return true
    })
  })

  const unratedCount = $derived(library.unratedWatched.length)

  const FILTERS: Array<{ id: Filter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'unrated', label: 'Unrated' },
    { id: 'liked', label: 'Liked' },
    { id: 'disliked', label: 'Disliked' },
  ]
</script>

<div class="watched">
  <header>
    <div class="title">
      <h1>Watched</h1>
      <span class="count">{library.watched.length}</span>
    </div>

    <div class="tools">
      <input
        bind:value={query}
        type="search"
        placeholder="Filter by title…"
        aria-label="Filter watched titles"
      />
      <div class="filters">
        {#each FILTERS as f (f.id)}
          <button class:active={filter === f.id} onclick={() => (filter = f.id)}>
            {f.label}
            {#if f.id === 'unrated' && unratedCount > 0}<span class="badge">{unratedCount}</span>{/if}
          </button>
        {/each}
      </div>
    </div>
  </header>

  {#if library.watched.length === 0}
    <p class="empty">
      Nothing here yet. Add titles you have already seen from their detail page, or bring a
      MyAnimeList export in through <strong>Import</strong> on the Watchlist tab.
    </p>
  {:else}
    <!--
      A prompt rather than a modal.

      Rating is worth encouraging and not worth interrupting for: a dialog that
      opens over a two-hundred-title library asking "what did you think of
      this?" gets dismissed, and dismissed prompts train people to dismiss the
      next one too. This sits above the grid, states the number, and filters to
      it in one click.
    -->
    {#if unratedCount > 0 && filter !== 'unrated'}
      <button class="prompt" onclick={() => (filter = 'unrated')}>
        <span class="prompt-lead">{unratedCount} of these have no rating yet.</span>
        <span class="prompt-hint"
          >Rating them is what makes the tailored row on Browse worth reading — show me →</span
        >
      </button>
    {/if}

    <div class="grid">
      {#each visible as entry (entry.id)}
        {@const media = asMedia(entry)}
        {@const src = posterUrl(entry.posterPath)}
        <div class="tile" class:unresolved={entry.tmdbId === 0}>
          <button class="art" onclick={() => onselect(media)} title={entry.title}>
            {#if src}
              <img {src} alt="" loading="lazy" decoding="async" width="168" height="252" />
            {:else}
              <span class="placeholder" aria-hidden="true">{entry.title.slice(0, 1)}</span>
            {/if}
            {#if entry.source === 'mal'}
              <span class="badge-source" title="Imported from MyAnimeList">MAL</span>
            {/if}
          </button>

          <p class="name" title={entry.title}>{entry.title}</p>

          <div class="row">
            <RateButtons {media} size="sm" />
            <button
              class="drop"
              onclick={() => library.removeFromWatched(entry.tmdbId)}
              aria-label="Remove {entry.title} from watched"
              title="Remove from watched">✕</button
            >
          </div>
        </div>
      {/each}
    </div>

    {#if visible.length === 0}
      <p class="empty">Nothing matches that filter.</p>
    {/if}
  {/if}
</div>

<style>
  .watched {
    padding: var(--space-7) var(--page-inset) var(--space-8);
  }

  header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-5);
    flex-wrap: wrap;
    margin-bottom: var(--space-5);
  }

  .title {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
  }

  h1 {
    margin: 0;
    font-size: var(--text-xl);
  }

  .count {
    padding: 2px var(--space-2);
    border-radius: var(--radius-full);
    background: var(--bg-elevated);
    color: var(--text-tertiary);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .tools {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .tools input {
    height: 32px;
    width: 220px;
    padding: 0 var(--space-3);
    border-radius: var(--radius-full);
    border: 1px solid var(--border-subtle);
    background: var(--bg-raised);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-sm);
    -webkit-user-select: text;
    user-select: text;
  }

  .tools input::-webkit-search-cancel-button {
    display: none;
  }

  .filters {
    display: flex;
    gap: var(--space-1);
  }

  .filters button {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-full);
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }

  .filters button:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .filters button.active {
    background: var(--accent-muted);
    color: var(--accent-hover);
  }

  .badge {
    padding: 0 5px;
    border-radius: var(--radius-full);
    background: var(--accent);
    color: var(--text-on-media);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .prompt {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    flex-wrap: wrap;
    width: 100%;
    margin-bottom: var(--space-5);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    border: 1px solid var(--border-subtle);
    background: var(--bg-raised);
    text-align: left;
  }

  .prompt:hover {
    border-color: var(--accent);
  }

  .prompt-lead {
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .prompt-hint {
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--poster-width), 1fr));
    gap: var(--space-5) var(--space-3);
  }

  .tile {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  .art {
    position: relative;
    aspect-ratio: 2 / 3;
    border-radius: var(--radius-md);
    overflow: hidden;
    background: var(--bg-elevated);
  }

  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    color: var(--text-disabled);
    font-size: var(--text-2xl);
    font-weight: 700;
  }

  /* An import that has not been matched to a TMDB record yet: it has a title
     and nothing else, so it cannot show art or open a detail page. */
  .unresolved .art {
    opacity: 0.55;
  }

  .badge-source {
    position: absolute;
    top: 6px;
    left: 6px;
    padding: 1px 5px;
    border-radius: var(--radius-sm);
    background: rgb(var(--bg-base-rgb) / 0.82);
    color: var(--text-tertiary);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.4px;
  }

  .name {
    margin: 0;
    font-size: var(--text-sm);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .drop {
    width: 28px;
    height: 28px;
    border-radius: var(--radius-full);
    color: var(--text-tertiary);
    font-size: var(--text-xs);
  }

  .drop:hover {
    background: var(--bg-hover);
    color: var(--danger);
  }

  .empty {
    padding: var(--space-7) 0;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
    max-width: 60ch;
    line-height: 1.6;
  }
</style>
