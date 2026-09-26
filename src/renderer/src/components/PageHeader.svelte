<script lang="ts">
  /**
   * The heading every tab opens with: its name, a count, a line of context,
   * and the tab's own tools on the right.
   *
   * One component because five tabs had five headings. Watchlist and Releases
   * set theirs at 19px, Watched and History at 24px, and Settings used the
   * browser's unstyled default, so the name of the page moved and changed size
   * as the user went from tab to tab.
   */
  import type { Snippet } from 'svelte'

  interface Props {
    title: string
    /** A figure beside the title — how many things the tab holds. */
    count?: string | number | null
    /** One line under the title, for what the tab is doing right now. */
    lede?: string | null
    /** The tab's tools, laid out at the right-hand end. */
    children?: Snippet
  }

  const { title, count = null, lede = null, children }: Props = $props()
</script>

<header class="page-head">
  <div class="page-title">
    <div class="page-name">
      <h1>{title}</h1>
      {#if count !== null && count !== ''}<span class="page-count">{count}</span>{/if}
    </div>
    {#if lede}<p class="page-lede">{lede}</p>{/if}
  </div>
  {#if children}
    <!-- `head-actions` is the phone sheet's hook for letting these wrap. -->
    <div class="page-tools head-actions">{@render children()}</div>
  {/if}
</header>

<style>
  .page-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3) var(--space-4);
    flex-wrap: wrap;
  }

  .page-title {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .page-name {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
  }

  h1 {
    margin: 0;
    font-family: var(--font-display);
    font-size: var(--text-xl);
    font-weight: var(--weight-bold);
    letter-spacing: var(--tracking-snug);
    line-height: var(--leading-tight);
  }

  .page-count {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .page-lede {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .page-tools {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
</style>
