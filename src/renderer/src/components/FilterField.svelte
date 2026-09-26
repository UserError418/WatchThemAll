<script lang="ts">
  /**
   * The "Filter by title…" box that narrows a tab's own list.
   *
   * One component because three tabs have one: History had it first, Watched
   * grew its own copy at a different size and weight, and the Watchlist had
   * none. Two copies of a control look like two controls, so the user has to
   * learn each — the one thing a filter box must never cost.
   *
   * It narrows what is already on screen and never searches the catalogue.
   * That is the nav bar's search, which takes over the whole page; this one
   * stays inside the tab it belongs to.
   */

  interface Props {
    /** The text typed so far, bound by the parent that does the filtering. */
    value: string
    /** The accessible name — "Filter watched titles", not the placeholder. */
    label: string
    placeholder?: string
  }

  let { value = $bindable(''), label, placeholder = 'Filter by title…' }: Props = $props()

  let input = $state<HTMLInputElement | null>(null)

  function clear(): void {
    value = ''
    input?.focus()
  }

  /** Escape empties the box first, and only an empty box lets it through. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || value === '') return
    event.stopPropagation()
    value = ''
  }
</script>

<div class="filter-field" class:filled={value !== ''}>
  <svg class="glass" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <line x1="16.2" y1="16.2" x2="21" y2="21" />
  </svg>
  <input
    bind:this={input}
    bind:value
    type="text"
    {placeholder}
    aria-label={label}
    spellcheck="false"
    autocomplete="off"
    onkeydown={onKeydown}
  />
  {#if value !== ''}
    <button class="clear" onclick={clear} aria-label="Clear the filter" title="Clear">✕</button>
  {/if}
</div>

<style>
  .filter-field {
    position: relative;
    display: flex;
    align-items: center;
    width: 240px;
    max-width: 100%;
  }

  .glass {
    position: absolute;
    left: 12px;
    width: 14px;
    height: 14px;
    fill: none;
    stroke: var(--text-tertiary);
    stroke-width: 2;
    stroke-linecap: round;
    pointer-events: none;
  }

  input {
    width: 100%;
    padding: var(--space-2) 34px var(--space-2) 34px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-full);
    background: var(--bg-elevated);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-sm);
    transition:
      border-color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }

  input::placeholder {
    color: var(--text-tertiary);
  }

  input:focus-visible {
    outline: none;
    border-color: var(--accent);
  }

  /* A live filter is a state the list is in, so the box says so while it is. */
  .filled input {
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
    background: var(--accent-subtle);
  }

  .filter-field:focus-within .glass,
  .filled .glass {
    stroke: var(--text-secondary);
  }

  .clear {
    position: absolute;
    right: 6px;
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border-radius: var(--radius-full);
    color: var(--text-tertiary);
    font-size: var(--text-2xs);
  }

  .clear:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }
</style>
