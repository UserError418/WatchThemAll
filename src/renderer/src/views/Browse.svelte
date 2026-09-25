<script module lang="ts">
  /**
   * Which of the user's favourites this app session's "Because you…" rows are
   * about.
   *
   * Module scope, so it is chosen once per launch rather than once per visit to
   * the tab: switching to Watchlist and back should not reshuffle the page the
   * user was halfway down, while the next launch should show a different one.
   */
  const SESSION_SEED = Math.floor(Math.random() * 2 ** 31)
</script>

<script lang="ts">
  /**
   * The Browse surface: a hero, then rows.
   *
   * Two kinds of row, in a deliberate order. The personalised rows — Top picks,
   * "Because you watched ‹Title›", and genre shelves chosen by the user's taste
   * — are planned by main from the store, because that is where the taste
   * profile lives (see `foryou.ts`). The fixed charts come after them: they
   * answer "what is everyone watching", which is worth knowing and is not the
   * question the top of a personal page should answer.
   *
   * Continue Watching and the Top 10 stay above both. They answer "what should
   * I open" more directly than any recommendation, and the Top 10 is the row
   * people scan first out of habit.
   *
   * Rows below the fold do not fetch until they are scrolled near — see
   * BrowseRow. That is what keeps first paint independent of how many rows the
   * plan produces.
   */
  import { untrack } from 'svelte'
  import type { MediaSummary } from '@shared/types'
  import type { ForYouRow, RowRequest } from '@shared/ipc'
  import BrowseRow from '../components/BrowseRow.svelte'
  import ContinueRow from '../components/ContinueRow.svelte'
  import Hero from '../components/Hero.svelte'
  import Top10Row from '../components/Top10Row.svelte'
  import DiscoveryFeed from '../components/DiscoveryFeed.svelte'
  import { library } from '../lib/library.svelte'
  import { shown } from '../lib/shown.svelte'

  interface Props {
    onselect: (media: MediaSummary) => void
  }

  const { onselect }: Props = $props()

  let plan = $state<ForYouRow[]>([])
  let heroFallback = $state<MediaSummary | null>(null)

  $effect(() => {
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

  /**
   * Changes whenever the library does in a way the profile would notice.
   *
   * The collections are replaced, never mutated, on every write — so reading
   * the references is enough to subscribe, and a rating changed from 7 to 9
   * (same length, different contents) still registers.
   */
  const tasteVersion = $derived([library.ratings, library.watched, library.watchlist])

  /**
   * The plan is fetched on arrival and then left alone — rows that rearranged
   * themselves whenever the user rated something would be a page that moves
   * under the pointer. Two exceptions, both below.
   */
  let planned = false
  $effect(() => {
    void tasteVersion
    // A new user with nothing to go on gets an empty plan. Their first few
    // ratings are exactly when the rows should appear, so an empty plan is
    // re-asked on every change until it is not empty.
    //
    // `plan` is read untracked: this effect must re-run when the *library*
    // changes, not when the plan it just fetched arrives — an empty plan would
    // otherwise re-request itself forever.
    untrack(() => {
      if (planned && plan.length > 0) return
      planned = true
      void loadPlan()
    })
  })

  async function loadPlan(): Promise<void> {
    try {
      const result = await window.wta.tmdb.forYouPlan({ seed: SESSION_SEED })
      plan = result.rows
    } catch (err) {
      // The fixed rows still render; a page without personal rows is a worse
      // page, not a broken one.
      console.error('[browse] could not plan the personal rows:', err)
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

  const forYou = (row: ForYouRow) => (page: number) => window.wta.tmdb.forYouRow({ row, page })
  const chart = (request: RowRequest) => (page: number) => window.wta.tmdb.row({ ...request, page })

  const charts: Array<{ key: string; title: string; request: RowRequest }> = [
    { key: 'onTheAir', title: 'On The Air', request: { row: 'onTheAir', page: 0 } },
    { key: 'topRated', title: 'Top Rated Series', request: { row: 'topRated', page: 0 } },
    { key: 'popularMovies', title: 'Popular Films', request: { row: 'popularMovies', page: 0 } },
    { key: 'upcoming', title: 'Coming Soon', request: { row: 'upcoming', page: 0 } },
  ]
</script>

<div class="browse">
  <Hero fallback={heroFallback} {onselect} />
  <!-- Above every TMDB row: what the user was already in the middle of. -->
  <ContinueRow {onselect} />
  <Top10Row title="Top 10 Series This Week" request={{ row: 'trending', page: 0 }} eager {onselect} />

  {#each plan as row, index (row.key)}
    {#if row.kind === 'topPicks'}
      <!--
        The one row that follows the library live. Re-created when the taste
        changes, so rating something from the detail view is reflected here
        without reloading the page — the other rows keep their place.
      -->
      {#key tasteVersion}
        <BrowseRow title={row.title} load={forYou(row)} hideOwned eager={index === 0} {onselect} />
      {/key}
    {:else}
      <BrowseRow title={row.title} load={forYou(row)} hideOwned eager={index === 0} {onselect} />
    {/if}
  {/each}

  {#each charts as row (row.key)}
    <BrowseRow title={row.title} load={chart(row.request)} {onselect} />
  {/each}

  <!-- Past the curated shelves, the catalogue itself. -->
  <DiscoveryFeed {onselect} />
</div>

<style>
  .browse {
    padding-bottom: var(--space-8);
  }
</style>
