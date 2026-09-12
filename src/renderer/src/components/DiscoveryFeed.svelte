<script lang="ts">
  /**
   * The bottom of the browse page: keep going.
   *
   * The curated rows are finite and their tail is weak — by the fourth genre
   * shelf the shows are neither personal nor especially interesting, and then
   * the page simply stops. This replaces that dead end with a grid that pages
   * into TMDB's whole catalogue for as long as the user keeps scrolling.
   *
   * **Vertical, not another horizontal row.** That is the point of it. The rows
   * above are for scanning a curated shelf; this is for browsing without a
   * destination, and a grid you scroll down is the shape that suits it. Fifteen
   * sideways-scrolling shelves is a worse version of the same thing.
   *
   * Everything already claimed by a row above is filtered out, so scrolling
   * past the shelves never means seeing them again in a different order.
   */
  import type { MediaSummary } from '@shared/types'
  import type { DiscoverRequest } from '@shared/ipc'
  import TitleCard from './TitleCard.svelte'
  import { shown } from '../lib/shown.svelte'

  interface Props {
    onselect: (media: MediaSummary) => void
  }

  const { onselect }: Props = $props()

  let items = $state<MediaSummary[]>([])
  let page = $state(0)
  let loading = $state(false)
  let error = $state<string | null>(null)
  /** Set once the catalogue stops giving us anything new, so we stop asking. */
  let exhausted = $state(false)

  /**
   * Fixed for the session.
   *
   * Chosen once rather than per request: a seed that changed as the user
   * scrolled would reorder the catalogue underneath them, so the grid would
   * repeat titles and skip others while looking like it was working.
   */
  const seed = Math.floor(Math.random() * 1000)

  /**
   * Series and films, alternating.
   *
   * TMDB's discover endpoint is per-media-type, so a single-type feed would be
   * all series or all films forever. Alternating by page mixes them without
   * needing two request streams interleaved by hand.
   */
  function requestFor(nextPage: number): DiscoverRequest {
    return {
      discover: true,
      type: nextPage % 2 === 0 ? 'movie' : 'tv',
      page: Math.ceil(nextPage / 2),
      seed,
    }
  }

  async function loadMore(): Promise<void> {
    if (loading || exhausted) return
    loading = true
    error = null

    try {
      const next = page + 1
      const result = await window.wta.tmdb.row(requestFor(next))

      /**
       * Filter against both the rows above and what this grid already holds.
       *
       * The second half matters more than it looks: the sort rotation means
       * consecutive pages come from different orderings of the same catalogue,
       * so overlap between them is normal rather than exceptional.
       */
      const have = new Set(items.map((i) => `${i.type}:${i.tmdbId}`))
      const fresh = result.items.filter(
        (m) => !shown.has(m) && !have.has(`${m.type}:${m.tmdbId}`) && m.posterPath,
      )

      items = [...items, ...fresh]
      page = next

      /**
       * Give up only after several barren pages in a row.
       *
       * A single page can legitimately come back empty — an unlucky slice where
       * everything was already shown above — and stopping on the first one
       * would end the feed early and permanently. Ten consecutive empties means
       * the catalogue really is exhausted for this seed.
       */
      barren = fresh.length === 0 ? barren + 1 : 0
      if (barren >= 10) exhausted = true
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not load more'
    } finally {
      loading = false
    }
  }

  let barren = 0

  /** Load the next page when the sentinel scrolls into view. */
  function whenVisible(node: HTMLElement): { destroy: () => void } {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore()
      },
      // Well before the sentinel is actually on screen, so the grid grows
      // ahead of the scroll rather than stuttering at the bottom.
      { rootMargin: '600px' },
    )
    observer.observe(node)
    return { destroy: () => observer.disconnect() }
  }
</script>

<section class="discovery">
  <header>
    <h2>Browse More</h2>
    <p>Random movies and series, scroll forever</p>
  </header>

  <div class="grid">
    {#each items as media (`${media.type}-${media.tmdbId || media.imdbId}`)}
      <TitleCard {media} {onselect} />
    {/each}
  </div>

  {#if error}
    <p class="state error" role="alert">{error}</p>
  {:else if exhausted}
    <p class="state">That is everything we could find. Try a search for something specific.</p>
  {:else}
    <div class="sentinel" use:whenVisible>{loading ? 'Finding more…' : ''}</div>
  {/if}
</section>

<style>
  .discovery {
    /* Extra top and bottom room for the first and last rows to grow into. */
    padding: calc(var(--space-7) + var(--card-grow) / 2) var(--page-inset)
      calc(var(--space-8) + var(--card-grow) / 2);
  }

  header {
    margin-bottom: var(--space-5);
  }

  h2 {
    margin: 0 0 var(--space-1);
    font-size: var(--text-lg);
  }

  header p {
    margin: 0;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }

  /*
    The same cards as the rows above, not the smaller poster tiles.

    They were posters because this started as a dense tail to the page, but a
    tail nobody can preview is a wall of artwork — and the surface it sits under
    lets you hover anything and watch it. Sizing the columns from `--card-width`
    keeps the two halves of the page the same scale.

    The gutters are the interesting part: a hovered card grows past its own box,
    so the grid has to leave room for that growth in both axes or the expansion
    is clipped by the next row. `--card-grow` is the same measurement the rows
    use, which is why hover looks identical here and there.
  */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--card-width), 1fr));
    column-gap: var(--space-4);
    row-gap: calc(var(--card-grow) + var(--space-6));
    /* Cards expand outside their cell; clipping them is what a poster grid
       would have done and is exactly what must not happen here. */
    overflow: visible;
  }

  .sentinel {
    padding: var(--space-6);
    text-align: center;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }

  .state {
    padding: var(--space-5) 0;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }

  .state.error {
    color: var(--danger);
  }
</style>
