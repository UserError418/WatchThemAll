<script lang="ts">
  /**
   * Search across TMDB's TV and film catalogue.
   *
   * Requests are debounced and superseded: a query typed over the top of an
   * in-flight one discards that result rather than letting it land late and
   * overwrite the newer answer. The original had no such guard, so typing
   * quickly could leave results for a prefix of what was in the box.
   */
  import type { MediaSummary } from '@shared/types'
  import PosterCard from '../components/PosterCard.svelte'

  interface Props {
    onselect: (media: MediaSummary) => void
    /**
     * The query, owned by the shell.
     *
     * Search is a mode rather than a tab now: the box lives in the nav and is
     * reachable from anywhere, and typing into it takes over the surface. That
     * removes the state this view used to be in most of the time — visible,
     * focused, and completely empty — which is not a screen worth having.
     */
    query: string
  }

  const { onselect, query }: Props = $props()

  let results = $state<MediaSummary[]>([])
  let page = $state(0)
  let totalPages = $state(0)
  let loading = $state(false)
  let error = $state<string | null>(null)
  /** Monotonic token; only the newest request is allowed to write results. */
  let requestSeq = 0

  /**
   * React to the shell's query, debounced.
   *
   * Debouncing still matters even though the shell owns the text: the effect
   * fires on every keystroke, and one request per character would both waste
   * the round trips and let an early answer land after a later one. The
   * sequence token is what actually guarantees ordering; the delay is what
   * keeps the request count sane.
   */
  $effect(() => {
    const text = query.trim()

    if (!text) {
      requestSeq += 1
      results = []
      page = 0
      totalPages = 0
      error = null
      return
    }

    const timer = setTimeout(() => void run(text, 1, true), 250)
    return () => clearTimeout(timer)
  })

  async function run(text: string, nextPage: number, replace: boolean): Promise<void> {
    const seq = ++requestSeq
    loading = true
    error = null
    try {
      // Federated: TMDB for richness, IMDB for the breadth of catalogue and
      // the ids providers key on. `tmdb.search` alone cannot find everything.
      const result = await window.wta.search(text, nextPage)
      if (seq !== requestSeq) return // superseded by a newer query
      results = replace ? result.items : [...results, ...result.items]
      page = result.page
      totalPages = result.totalPages
    } catch (err) {
      if (seq !== requestSeq) return
      error = err instanceof Error ? err.message : 'Search failed'
    } finally {
      if (seq === requestSeq) loading = false
    }
  }

  function loadMore(): void {
    if (loading || page >= totalPages) return
    void run(query.trim(), page + 1, false)
  }


  /** Infinite scroll: load the next page when the sentinel comes into view. */
  function whenVisible(node: HTMLElement) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore()
      },
      { rootMargin: '300px' },
    )
    observer.observe(node)
    return { destroy: () => observer.disconnect() }
  }
</script>

<div class="search">
  <header class="results-head">
    <h2>Results for “{query.trim()}”</h2>
    {#if results.length > 0}
      <span class="count">{results.length}{page < totalPages ? '+' : ''}</span>
    {/if}
  </header>

  {#if error}
    <p class="state error" role="alert">{error}</p>
  {:else if results.length === 0 && loading}
    <p class="state">Searching…</p>
  {:else if results.length === 0}
    <p class="state">Nothing found for “{query.trim()}”.</p>
  {:else}
    <div class="grid">
      <!--
        Key on the IMDB id when there is no TMDB id. Every IMDB-sourced result
        carries `tmdbId: 0`, so keying on that alone gives them all the same
        key and Svelte refuses to render the block at all — the surface goes
        blank rather than showing a duplicate.
      -->
      {#each results as media (`${media.type}-${media.tmdbId || media.imdbId}`)}
        <PosterCard {media} {onselect} />
      {/each}
    </div>
    {#if page < totalPages}
      <div class="sentinel" use:whenVisible>{loading ? 'Loading…' : ''}</div>
    {/if}
  {/if}
</div>

<style>
  .search {
    padding: var(--space-5) var(--space-6) var(--space-8);
  }

  .results-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    margin-bottom: var(--space-5);
  }

  .results-head h2 {
    margin: 0;
    font-size: var(--text-lg);
  }

  .count {
    padding: 0 8px;
    border-radius: var(--radius-full);
    background: var(--bg-elevated);
    color: var(--text-tertiary);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--poster-width), 1fr));
    gap: var(--space-5) var(--space-3);
  }

  .sentinel {
    padding: var(--space-5);
    text-align: center;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }

  .state {
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }
  .state.error {
    color: var(--danger);
  }
</style>
