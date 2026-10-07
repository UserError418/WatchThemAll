<script lang="ts" generics="T extends string">
  /**
   * A choice in a tab's heading, shaped as a pill and labelled on screen:
   * "Sort by · Recently added" on Watched, "Preferred source · Automatic" on
   * Downloads.
   *
   * Labelled on screen, and shaped as a menu, because the first one was a
   * bare select styled as a pill with "Sort by" for screen readers only. It
   * read as one more filter chip at the end of Watched's row ("Recently
   * added"), and the owner asked for a sort that was already there.
   *
   * One component since Downloads needed the same control (2026-10-07): two
   * copies of a control look like two controls, and drift apart.
   */

  interface Props {
    /** The words before the choice; also the select's accessible name. */
    label: string
    /** The chosen option's id. Bind it, or pass it and follow `onchange` where the choice is kept elsewhere. */
    value: T
    options: ReadonlyArray<{ id: T; label: string }>
    /** Path data for a 24×24 stroke icon before the label. */
    glyph?: string
    /** The viewer picked an option. */
    onchange?: (value: T) => void
    title?: string
  }

  let { label, value = $bindable(), options, glyph, onchange, title }: Props = $props()

  function pick(next: T): void {
    value = next
    onchange?.(next)
  }

  let select = $state<HTMLSelectElement | null>(null)

  /**
   * A press anywhere on the pill opens the menu. A label only focuses its
   * select, so pressing the words before the choice did nothing but draw the
   * focus ring: on the phone that was half the pill (seen on the emulator,
   * 2026-10-07). `showPicker` is Chromium 121+ (Electron and the phone's
   * WebView both are); without it, focus is the old behaviour.
   */
  function openMenu(event: MouseEvent): void {
    if (select === null || event.target === select) return
    event.preventDefault()
    // lib.dom declares `showPicker` on inputs only.
    const menu = select as HTMLSelectElement & { showPicker(): void }
    try {
      menu.showPicker()
    } catch {
      select.focus()
    }
  }
</script>

<!-- The click is the pointer's shortcut to the menu; the keyboard reaches the select itself. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<label class="pill-select" {title} onclick={openMenu}>
  {#if glyph}
    <svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><path d={glyph} /></svg>
  {/if}
  <span class="pill-label">{label}</span>
  <select bind:this={select} {value} onchange={(e) => pick(e.currentTarget.value as T)}>
    {#each options as option (option.id)}
      <option value={option.id}>{option.label}</option>
    {/each}
  </select>
  <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
</label>

<style>
  /*
    The same height and outline as the filter box, so a header's text controls
    read as a set; the chevron is what says "menu" rather than "toggle". The
    native select stays underneath for the keyboard and for screen readers,
    stripped of its own look.
  */
  .pill-select {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    max-width: 100%;
    padding: 0 var(--space-3) 0 var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-full);
    background: var(--bg-elevated);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: border-color var(--dur-fast) var(--ease-out);
  }
  .pill-select:hover,
  .pill-select:focus-within {
    border-color: var(--border-strong);
  }
  .glyph,
  .chevron {
    width: 14px;
    height: 14px;
    flex: none;
    fill: none;
    stroke: var(--text-tertiary);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    pointer-events: none;
  }
  .pill-label {
    color: var(--text-tertiary);
    white-space: nowrap;
  }
  .pill-select select {
    appearance: none;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    font-weight: var(--weight-emphasis);
    text-overflow: ellipsis;
    /* Room for the chevron, which sits over the select's right end. */
    padding: var(--space-2) 22px var(--space-2) 0;
    margin-right: -20px;
    cursor: pointer;
  }
  /*
    Android's WebView counts a tapped select as :focus-visible, and the app's
    focus ring is a box-shadow, so `outline: none` alone left a double ring.
    The pill's border shows keyboard focus instead.
  */
  .pill-select select:focus {
    outline: none;
    box-shadow: none;
  }
  .pill-select:has(select:focus-visible) {
    border-color: var(--accent);
  }
  .pill-select option {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }
</style>
