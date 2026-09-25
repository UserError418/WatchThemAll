<script lang="ts">
  /**
   * A row backed by a paginated source — a TMDB chart, or a personalised row
   * main planned. The row does not know which: it is handed a `load` function
   * and asks it for pages.
   *
   * Two things the original got wrong and this fixes:
   *
   * The row does not fetch until it is near the viewport. The old dashboard
   * built every category up front — up to 700 tiles in one HTML string — so
   * first paint waited on rows nobody had scrolled to.
   *
   * More pages load as you scroll right, one at a time, guarded by an in-flight
   * flag. The old "endless" scroll re-served the same results forever because
   * its engine was rebuilt stateless on every request.
   */
  import type { MediaSummary } from '@shared/types'
  import type { Paged } from '@shared/ipc'
  import TitleCard from './TitleCard.svelte'
  import RowShell from './RowShell.svelte'
  import { library } from '../lib/library.svelte'
  import { shown } from '../lib/shown.svelte'

  interface Props {
    title: string
    /** Fetch one page, 1-based. */
    load: (page: number) => Promise<Paged<MediaSummary>>
    onselect?: (media: MediaSummary) => void
    /**
     * Hide titles already in the library. Set on the personalised rows: a shelf
     * headed "Because you watch Drama" that recommends the show that produced
     * that taste is not a recommendation. Left off for Trending and Top Rated,
     * where seeing something you already follow is informative rather than
     * redundant.
     */
    hideOwned?: boolean
    /** Load on mount rather than waiting to be scrolled near. */
    eager?: boolean
  }

  const { title, load, onselect, hideOwned = false, eager = false }: Props = $props()

  /**
   * A title's identity within the row.
   *
   * Type and id together, never the id alone: TMDB numbers films and series
   * separately, and a personalised shelf mixes both — keyed by id, a film and a
   * series that share a number would de-duplicate each other away, and as a
   * keyed `{#each}` would make Svelte throw on the duplicate key.
   */
  const keyOf = (m: MediaSummary): string => `${m.type}:${m.tmdbId}`

  let items = $state<MediaSummary[]>([])
  let page = $state(0)
  let totalPages = $state(1)
  let loading = $state(false)
  let loaded = $state(false)
  let error = $state<string | null>(null)

  /**
   * What this row actually shows.
   *
   * Two filters, in order. `hideOwned` drops titles the user already has, which
   * only personalised rows do — recommending something already in the watchlist
   * is noise.
   *
   * Then the row claims what is left, so a title shown by a row above is not
   * repeated here. TMDB's lists overlap heavily — a popular drama is trending
   * *and* top-rated *and* on the air *and* in the user's top genre — and shown
   * unfiltered that is the same handful of titles four times down one page.
   */
  const visible = $derived.by(() => {
    const owned = hideOwned
      ? items.filter((m) => !library.isInWatchlist(m.tmdbId) && !library.isTracked(m.tmdbId))
      : items
    return shown.claim(title, owned)
  })

  async function loadNextPage(): Promise<void> {
    if (loading || page >= totalPages) return
    loading = true
    error = null
    try {
      const next = await load(page + 1)
      // De-duplicate: TMDB's paginated endpoints repeat an entry across pages
      // when the underlying ranking shifts between requests.
      const seen = new Set(items.map(keyOf))
      items = [...items, ...next.items.filter((i) => !seen.has(keyOf(i)))]
      page = next.page
      totalPages = next.totalPages

      /**
       * Fetch again when deduping left the row too short to be worth a shelf.
       *
       * A row whose titles were nearly all claimed above renders as three cards
       * and a lot of empty track, which looks broken rather than curated. One
       * extra page is enough in practice and bounded — `loadNextPage` stops at
       * `totalPages`, so this cannot loop.
       */
      if (visible.length < 8 && page < totalPages) void loadNextPage()
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not load this row'
    } finally {
      loading = false
      loaded = true
    }
  }
</script>

<RowShell
  {title}
  {loading}
  {loaded}
  {error}
  {eager}
  empty={visible.length === 0}
  onnear={loadNextPage}
  onnearEnd={loadNextPage}
  onretry={loadNextPage}
>
  {#each visible as media, index (keyOf(media))}
    <!--
      Edge cards grow inward. The track is a horizontal scroll container, so a
      card expanding past either end is clipped rather than overflowing.
    -->
    <TitleCard
      {media}
      {onselect}
      anchor={index === 0 ? 'start' : index === visible.length - 1 ? 'end' : 'center'}
    />
  {/each}
</RowShell>
