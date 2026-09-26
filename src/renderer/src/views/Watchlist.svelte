<script lang="ts">
  /**
   * The Watchlist surface: what the user is part-way through, arranged by how
   * far through they are.
   *
   * ## Why bands rather than one sorted grid
   *
   * The brief was "sorted dynamically by how much and when each entry was last
   * watched". That is two dimensions, and a single ordered grid can only carry
   * one of them — the other becomes invisible, so a title sliding down the list
   * looks arbitrary instead of explained. Splitting them lets each be stated:
   * **the band says how far through you are, the order inside it says when.**
   *
   * The rules live in `watchlistrank.ts` with their thresholds and their tests.
   * This file is layout.
   *
   * An empty band is not rendered. A heading over nothing reads as the app
   * having lost something, which is worse than the heading being absent.
   */
  import type { MediaSummary } from '@shared/types'
  import { library } from '../lib/library.svelte'
  import { bandWatchlist } from '@shared/watchlistrank'
  import { fly } from 'svelte/transition'
  import { stagger } from '../lib/motion'
  import WatchlistCard from '../components/WatchlistCard.svelte'
  import PageHeader from '../components/PageHeader.svelte'
  import FilterField from '../components/FilterField.svelte'

  interface Props {
    onselect: (media: MediaSummary) => void
  }

  const { onselect }: Props = $props()

  type Filter = 'all' | 'tv' | 'movie'
  let filter = $state<Filter>('all')
  let query = $state('')

  const entries = $derived.by(() => {
    const needle = query.trim().toLowerCase()
    return library.listedWatchlist.filter(
      (w) =>
        (filter === 'all' || w.type === filter) &&
        (needle === '' || w.title.toLowerCase().includes(needle)),
    )
  })

  const groups = $derived(
    bandWatchlist(entries, library.history, (tmdbId) => {
      // Films have no episodes to count, so their fraction is the resume
      // position — looked up here because the ranking module is kept free of
      // the reactive library.
      const film = library.filmProgress(tmdbId)
      return film ? film.percent : null
    }),
  )

  const FILTERS: Array<[Filter, string]> = [
    ['all', 'All'],
    ['tv', 'Series'],
    ['movie', 'Films'],
  ]
</script>

<div class="view">
  <PageHeader title="Watchlist" count={library.listedWatchlist.length || null}>
    {#if library.listedWatchlist.length > 0}
      <FilterField bind:value={query} label="Filter the watchlist by title" />
    {/if}
    <div class="filters">
      {#each FILTERS as [id, label] (id)}
        <button class:active={filter === id} onclick={() => (filter = id)}>{label}</button>
      {/each}
    </div>
  </PageHeader>

  {#if library.listedWatchlist.length === 0}
    <p class="state">
      Nothing here yet. Add something from Browse or Search and it will show up with a resume
      position.
    </p>
  {:else if groups.length === 0}
    <p class="state">Nothing matches that filter.</p>
  {:else}
    {#each groups as group (group.band)}
      <section class="band">
        <header class="band-head">
          <h3>{group.label}</h3>
          <span class="tally">{group.items.length}</span>
          <span class="hint">{group.hint}</span>
        </header>

        <div class="grid">
          {#each group.items as item, index (item.entry.id)}
            <div in:fly={stagger(index)}>
              <WatchlistCard entry={item.entry} activity={item.activity} {onselect} />
            </div>
          {/each}
        </div>
      </section>
    {/each}
  {/if}
</div>

<style>
  .view {
    padding: var(--space-5) var(--space-6) var(--space-8);
    display: flex;
    flex-direction: column;
    gap: var(--space-7);
  }

  .filters {
    display: flex;
    gap: var(--space-1);
  }

  .filters button {
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    background: var(--bg-raised);
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }

  .filters button.active {
    background: var(--accent);
    color: var(--text-on-accent);
  }

  .band {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .band-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    /* A hairline under the heading gives the band an edge to belong to
       without drawing a box around a grid that already reads as a group. */
    border-bottom: 1px solid var(--border-subtle, rgb(255 255 255 / 8%));
    padding-bottom: var(--space-2);
  }

  h3 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--text-primary);
  }

  .tally {
    font-size: var(--text-xs);
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }

  .hint {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    margin-left: auto;
  }

  /*
   * `auto-fill` rather than `auto-fit`: with `auto-fit` a band holding two
   * cards stretches them across the whole width, so "Nearly finished" would
   * draw posters twice the size of the band beneath it.
   */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--wl-card), 1fr));
    gap: var(--space-4) var(--space-3);
    /* Room for the hover lift, so the top row is not clipped by the band. */
    padding-top: var(--space-2);
  }

  .state {
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }
</style>
