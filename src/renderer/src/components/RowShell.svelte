<script lang="ts">
  /**
   * The chrome shared by every horizontal row: heading, edge arrows, the
   * snap-scrolling track, and the "load when near the viewport" trigger.
   *
   * Extracted so a row backed by TMDB (BrowseRow) and a row backed by the local
   * library (ContinueRow) look and behave identically. They differ only in
   * where their tiles come from, which is the only thing they should differ in.
   */
  import type { Snippet } from 'svelte'

  interface Props {
    title: string
    /** Rendered inside the scrolling track. */
    children: Snippet
    /** True while a page is in flight. */
    loading?: boolean
    /** True once a load has completed, whatever it returned. */
    loaded?: boolean
    /** True when there is nothing to show. */
    empty?: boolean
    /**
     * Load on mount instead of waiting to be scrolled near. Set on rows that
     * are above the fold, and as a safety net: `IntersectionObserver` needs a
     * rendering opportunity, so a row would otherwise never load at all in a
     * window that is never composited.
     */
    eager?: boolean
    error?: string | null
    /** Called when the row comes within a viewport of being visible. */
    onnear?: () => void
    /** Called when the track is scrolled close to its right edge. */
    onnearEnd?: () => void
    onretry?: () => void
  }

  const {
    title,
    children,
    loading = false,
    loaded = false,
    empty = false,
    error = null,
    eager = false,
    onnear,
    onnearEnd,
    onretry,
  }: Props = $props()

  let track = $state<HTMLElement | null>(null)
  let atStart = $state(true)
  let atEnd = $state(false)

  function whenNear(node: HTMLElement) {
    if (eager) {
      onnear?.()
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          onnear?.()
          observer.disconnect()
        }
      },
      { rootMargin: '400px' },
    )
    observer.observe(node)
    return { destroy: () => observer.disconnect() }
  }

  function onScroll(): void {
    if (!track) return
    const remaining = track.scrollWidth - track.scrollLeft - track.clientWidth
    atStart = track.scrollLeft < 8
    atEnd = remaining < 8
    if (remaining < 600) onnearEnd?.()
  }

  function nudge(direction: 1 | -1): void {
    track?.scrollBy({ left: direction * track.clientWidth * 0.85, behavior: 'smooth' })
  }
</script>

<section class="row" use:whenNear>
  <header>
    <h2>{title}</h2>
  </header>

  {#if error}
    <p class="state error" role="alert">
      {error}
      {#if onretry}<button class="retry" onclick={onretry}>Retry</button>{/if}
    </p>
  {:else if empty && !loaded}
    <!--
      Not yet loaded is not the same as empty. Showing "Nothing here." before a
      request has even been made states something we do not know, and looks
      identical to a row that genuinely came back with nothing.
    -->
    <div class="track skeletons">
      {#each Array(8) as _, i (i)}
        <div class="skeleton"></div>
      {/each}
    </div>
  {:else if empty}
    <p class="state">Nothing here.</p>
  {:else}
    <div class="track-wrap">
      <button
        class="edge left"
        class:hidden={atStart}
        onclick={() => nudge(-1)}
        aria-label="Scroll {title} left">‹</button
      >
      <div class="track" bind:this={track} onscroll={onScroll}>
        {@render children()}
        {#if loading}<div class="skeleton"></div>{/if}
      </div>
      <button
        class="edge right"
        class:hidden={atEnd}
        onclick={() => nudge(1)}
        aria-label="Scroll {title} right">›</button
      >
    </div>
  {/if}
</section>

<style>
  .row {
    /* The track carries its gutters as padding so a hovered card has somewhere
       to grow into. Pulling most of it back here keeps rows as tight as
       Netflix's without reintroducing the clipping that padding solves. An
       expanded card therefore overlays the row below, which is intended. */
    margin-bottom: calc(var(--space-6) - var(--row-gutter-bottom));
  }

  header {
    padding: 0 var(--page-inset) 0;
    /**
     * Pull the heading down into the track's headroom.
     *
     * The gutter is space for a hovered card to expand into, not spacing —
     * left alone it reads as a 56px gap between a row's title and its cards,
     * which is nothing like Netflix's tight pairing.
     */
    margin-bottom: calc(var(--space-2) - var(--row-gutter-top));
    position: relative;
    z-index: 1;
  }

  h2 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 700;
    letter-spacing: -0.3px;
    color: var(--text-primary);
  }

  .track-wrap {
    position: relative;
  }

  .track {
    display: flex;
    gap: var(--space-2);
    /**
     * A horizontal scroll container clips vertically too, so a card that
     * expands on hover can only grow into padding that already exists. That is
     * what the gutters are: headroom, not spacing.
     */
    padding: var(--row-gutter-top) var(--page-inset) var(--row-gutter-bottom);
    overflow-x: auto;
    overflow-y: hidden;
    scroll-snap-type: x proximity;
    /**
     * Snapping aligns a card's edge to the scrollport's edge, which ignores
     * padding — so the row silently scrolled itself by exactly the inset and
     * clipped its own first card. `scroll-padding` is what teaches the snap
     * where the content actually starts.
     */
    scroll-padding-inline: var(--page-inset);
    scrollbar-width: none;
  }

  .track::-webkit-scrollbar {
    display: none;
  }

  .track > :global(*) {
    scroll-snap-align: start;
    flex: 0 0 auto;
  }

  /* Netflix-style edge affordances: full-height, revealed on row hover. */
  .edge {
    position: absolute;
    top: var(--row-gutter-top);
    bottom: var(--row-gutter-bottom);
    z-index: 2;
    width: 46px;
    display: grid;
    place-items: center;
    font-size: 26px;
    color: var(--text-primary);
    background: linear-gradient(to right, rgb(var(--bg-base-rgb) / 0.92), rgb(var(--bg-base-rgb) / 0));
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease-out);
  }

  .edge.left {
    left: 0;
  }

  .edge.right {
    right: 0;
    background: linear-gradient(to left, rgb(var(--bg-base-rgb) / 0.92), rgb(var(--bg-base-rgb) / 0));
  }

  .row:hover .edge:not(.hidden),
  .edge:focus-visible {
    opacity: 1;
  }

  .edge.hidden {
    pointer-events: none;
  }

  .state {
    padding: 0 var(--page-inset);
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }

  .state.error {
    color: var(--danger);
  }

  .retry {
    margin-left: var(--space-2);
    color: var(--accent-hover);
    text-decoration: underline;
    font-size: var(--text-sm);
  }

  .skeletons {
    overflow: hidden;
  }

  .skeleton {
    flex: 0 0 auto;
    width: var(--card-width);
    aspect-ratio: var(--card-ratio);
    border-radius: var(--radius-md);
    background: linear-gradient(
      100deg,
      var(--bg-raised) 30%,
      var(--bg-elevated) 50%,
      var(--bg-raised) 70%
    );
    background-size: 220% 100%;
    animation: shimmer 1.4s infinite linear;
  }

  @keyframes shimmer {
    to {
      background-position: -220% 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton {
      animation: none;
    }
  }
</style>
