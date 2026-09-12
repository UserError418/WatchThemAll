<script lang="ts">
  /**
   * The Browse surface: a hero, then rows.
   *
   * Row composition is personalised without a separate recommendation engine.
   * The fixed rows are always present; genre rows are ordered by the user's own
   * taste profile, which is derived from data already in memory rather than by
   * querying TMDB for every saved title.
   *
   * Rows below the fold do not fetch until they are scrolled near — see
   * BrowseRow. That is what keeps first paint independent of how many rows the
   * profile produces.
   */
  import type { MediaSummary } from '@shared/types'
  import type { GenreRowRequest, RowRequest } from '@shared/ipc'
  import BrowseRow from '../components/BrowseRow.svelte'
  import ContinueRow from '../components/ContinueRow.svelte'
  import Hero from '../components/Hero.svelte'
  import Top10Row from '../components/Top10Row.svelte'
  import TailoredRow from '../components/TailoredRow.svelte'
  import DiscoveryFeed from '../components/DiscoveryFeed.svelte'
  import { library } from '../lib/library.svelte'
  import { shown } from '../lib/shown.svelte'

  interface Props {
    onselect: (media: MediaSummary) => void
  }

  const { onselect }: Props = $props()

  interface RowSpec {
    key: string
    title: string
    request: RowRequest | GenreRowRequest
    /** Personalised rows hide what the user already has; fixed rows do not. */
    hideOwned?: boolean
  }

  let genreNames = $state<Map<number, string>>(new Map())
  let heroFallback = $state<MediaSummary | null>(null)

  $effect(() => {
    void loadGenreNames()
    void loadHeroFallback()

    /**
     * Clear the shown-title registry when this surface goes away.
     *
     * It records which row owns which title, and it outlives the components
     * that made the claims. Without this, coming back to Browse renders a page
     * where every row finds its titles already claimed — by a row that no
     * longer exists — and shows nothing.
     */
    return () => shown.reset()
  })

  async function loadGenreNames(): Promise<void> {
    try {
      const [tv, movie] = await Promise.all([
        window.wta.tmdb.genres('tv'),
        window.wta.tmdb.genres('movie'),
      ])
      genreNames = new Map([...tv, ...movie].map((g) => [g.id, g.name]))
    } catch (err) {
      // Genre rows simply do not appear; the fixed rows still do.
      console.error('[browse] could not load genre names:', err)
    }
  }

  async function loadHeroFallback(): Promise<void> {
    try {
      // The same request BrowseRow makes for the trending row, so the TMDB
      // client's cache serves one of the two for free.
      const trending = await window.wta.tmdb.row({ row: 'trending', page: 1 })
      heroFallback = trending.items[0] ?? null
    } catch (err) {
      console.error('[browse] could not load hero:', err)
    }
  }

  const fixedRows: RowSpec[] = [
    { key: 'onTheAir', title: 'On The Air', request: { row: 'onTheAir', page: 0 } },
    { key: 'topRated', title: 'Top Rated Series', request: { row: 'topRated', page: 0 } },
    { key: 'popularMovies', title: 'Popular Films', request: { row: 'popularMovies', page: 0 } },
    { key: 'upcoming', title: 'Coming Soon', request: { row: 'upcoming', page: 0 } },
  ]

  /**
   * Up to four genre rows. The first is labelled as a recommendation because it
   * is one; the rest are plain genre rows so the surface does not read as if
   * every shelf were personalised.
   */
  const genreRows = $derived.by<RowSpec[]>(() => {
    if (genreNames.size === 0) return []
    const ids = library.topGenreIds().filter((id) => genreNames.has(id))
    if (ids.length === 0) return []

    return ids.slice(0, 4).map((genreId, index) => ({
      key: `genre-${genreId}`,
      title: index === 0 ? `Because you watch ${genreNames.get(genreId)}` : genreNames.get(genreId)!,
      request: { genreId, type: 'tv' as const, page: 0 },
      hideOwned: true,
    }))
  })

  /**
   * The personalised rows come first among the plain rows, but below Continue
   * Watching and the Top 10 — both of which answer "what should I open" more
   * directly than a genre shelf does.
   */
  const rows = $derived([...genreRows, ...fixedRows])
</script>

<div class="browse">
  <Hero fallback={heroFallback} {onselect} />
  <!-- Above every TMDB row: what the user was already in the middle of. -->
  <ContinueRow {onselect} />
  <Top10Row title="Top 10 Series This Week" request={{ row: 'trending', page: 0 }} eager {onselect} />
  <!--
    The only row on this page derived from what this user has actually watched
    and rated. Above the genre shelves because it answers "what should I open"
    more directly than any of them, and below the Top 10 because that is the
    row people scan first out of habit. Renders nothing until there is enough
    history to say something worth saying — see TailoredRow.
  -->
  <TailoredRow {genreNames} {onselect} />
  {#each rows as row, index (row.key)}
    <BrowseRow
      title={row.title}
      request={row.request}
      hideOwned={row.hideOwned ?? false}
      eager={index < 1}
      {onselect}
    />
  {/each}

  <!-- Past the curated shelves, the catalogue itself. -->
  <DiscoveryFeed {onselect} />
</div>

<style>
  .browse {
    padding-bottom: var(--space-8);
  }
</style>
