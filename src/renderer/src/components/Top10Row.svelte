<script lang="ts">
  /**
   * The "Top 10" row — oversized rank numerals beside portrait artwork.
   *
   * Distinct from `BrowseRow` in three ways, all deliberate:
   *
   * It is capped at ten. A "Top 10" that pages endlessly as you scroll right is
   * not a top ten, so this row does not load more.
   *
   * It uses portrait posters rather than the landscape cards the other rows
   * use, because the numeral needs a tall shape to sit against.
   *
   * It does not hide titles already in the library. A ranking with holes in it
   * is misleading — if the country's third-most-watched show is one you follow,
   * it is still third.
   */
  import type { MediaSummary } from '@shared/types'
  import type { RowRequest } from '@shared/ipc'
  import RowShell from './RowShell.svelte'
  import { posterSrcset, posterUrl } from '../lib/images'

  interface Props {
    title: string
    request: RowRequest
    onselect?: (media: MediaSummary) => void
    /** Load on mount rather than waiting to be scrolled near. */
    eager?: boolean
  }

  const { title, request, onselect, eager = false }: Props = $props()

  const LIMIT = 10

  let items = $state<MediaSummary[]>([])
  let loading = $state(false)
  let loaded = $state(false)
  let error = $state<string | null>(null)

  async function load(): Promise<void> {
    if (loading || loaded) return
    loading = true
    error = null
    try {
      const result = await window.wta.tmdb.row({ ...request, page: 1 })
      items = result.items.slice(0, LIMIT)
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
  empty={items.length === 0}
  onnear={load}
  onretry={load}
>
  {#each items as media, index (media.tmdbId)}
    {@const poster = posterUrl(media.posterPath, 'w342')}
    <div class="rank-card">
      <button class="hit" onclick={() => onselect?.(media)} title={media.title}>
        <!--
          The numeral is text rather than an image so it scales with the type
          system and stays crisp at any zoom. `aria-hidden` because the rank is
          already conveyed by document order.
        -->
        <span class="numeral" aria-hidden="true">{index + 1}</span>
        <span class="art">
          {#if poster}
            <img
              src={poster}
              srcset={posterSrcset(media.posterPath)}
              sizes="150px"
              alt=""
              loading="lazy"
              decoding="async"
              width="150"
              height="225"
            />
          {:else}
            <span class="placeholder">{media.title.slice(0, 1)}</span>
          {/if}
        </span>
        <span class="sr-only">{index + 1}. {media.title}</span>
      </button>
    </div>
  {/each}
</RowShell>

<style>
  .rank-card {
    flex: 0 0 auto;
  }

  .hit {
    display: flex;
    align-items: flex-end;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
    transition: transform var(--dur-mid) var(--ease-pop);
  }

  .hit:hover {
    transform: scale(1.06);
  }

  /**
   * Outlined rather than filled: a solid numeral this size would dominate the
   * artwork it is meant to be labelling. The stroke reads at a glance and
   * still lets the poster hold the row.
   */
  .numeral {
    display: block;
    /* Slight negative margin so the poster overlaps the numeral's right edge,
       which is what stops the pair reading as two separate objects. */
    margin-right: -22px;
    color: var(--bg-base);
    font-size: 150px;
    font-weight: 900;
    line-height: 0.78;
    letter-spacing: -12px;
    -webkit-text-stroke: 3px var(--text-tertiary);
    user-select: none;
  }

  /* "10" is twice as wide as the single digits and would otherwise blow out
     the row's rhythm. */
  .numeral:not(:empty) {
    font-variant-numeric: tabular-nums;
  }

  .art {
    display: block;
    position: relative;
    width: 150px;
    aspect-ratio: var(--poster-ratio);
    border-radius: var(--radius-md);
    overflow: hidden;
    background: var(--bg-elevated);
    box-shadow: var(--shadow-card);
  }

  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .placeholder {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    color: var(--text-tertiary);
    font-size: var(--text-2xl);
    font-weight: 700;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .hit {
      transition: none;
    }
  }
</style>
