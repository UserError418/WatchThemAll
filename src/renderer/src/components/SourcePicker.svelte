<script lang="ts">
  /**
   * Choose which provider plays this title.
   *
   * Cycle 1 had a `setDefaultProvider` method that nothing ever called, so the
   * app silently always used whichever provider sorted first. This is the UI
   * that was missing. The choice is stored on the watchlist entry, not
   * globally — different titles genuinely play better on different providers,
   * and a global setting makes the user re-pick every time they switch show.
   *
   * ## What the dot means
   *
   * It used to be a reachability probe: a request to the provider's front page,
   * green if it answered. Every provider answered, so every dot was green, and
   * the indicator carried no information about the only thing the user cares
   * about — whether this source will play *this* show. Worse, it was actively
   * misleading, because these are single-page apps whose document loads with a
   * clean 200 and then fails to resolve a stream.
   *
   * It now reports recorded playback for this title on this machine:
   *
   *   - nothing at all — never tried, and saying anything would be a guess
   *   - red — tried, and it has never produced a stream for this title
   *   - green — it has actually played this title
   *   - blue — the source this title was last streamed on, labelled "resume"
   *
   * Blue outranks green because it is the more specific claim: every blue
   * source is also a green one, and "this is where you were" is what the user
   * is looking for when they open this list mid-series.
   *
   * Still shown, never used to disable an option. A provider that failed
   * yesterday may work today, and the user's judgement has to be able to
   * override ours.
   */
  import type { TitleOutcome, TitleProviderState, TitleRef } from '@shared/ipc'
  import { library } from '../lib/library.svelte'
  import { menuIn, menuOut } from '../lib/motion'

  interface Props {
    /** Currently selected provider id, or null to let the app decide. */
    selected: string | null
    /** The title the dots are about. */
    media: TitleRef
    onselect: (providerId: string | null) => void
  }

  const { selected, media, onselect }: Props = $props()

  let open = $state(false)
  let sourceState = $state<TitleProviderState>({ outcomes: {}, lastUsed: null })

  let trigger = $state<HTMLButtonElement | null>(null)
  /**
   * Where to draw the menu, in viewport coordinates.
   *
   * The menu is `position: fixed` rather than absolute because the picker sits
   * inside the detail overlay, which scrolls — an absolutely-positioned menu is
   * clipped by that scroll container and cannot be scrolled itself. Fixed
   * positioning takes it out of the overlay's clipping box entirely, at the
   * cost of having to place it by hand.
   */
  let menuPos = $state({ top: 0, left: 0, maxHeight: 320 })

  function placeMenu(): void {
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const gap = 6
    const below = window.innerHeight - rect.bottom - gap - 12

    // Flip above the trigger when there is more room up there — near the
    // bottom of the window the list would otherwise be a few pixels tall.
    const above = rect.top - gap - 12
    const openUp = below < 220 && above > below

    menuPos = {
      top: openUp ? Math.max(12, rect.top - gap - Math.min(above, 420)) : rect.bottom + gap,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 280)),
      maxHeight: Math.max(160, Math.min(openUp ? above : below, 420)),
    }
  }

  /**
   * Only providers the user has enabled, in the order they arranged them.
   *
   * The same order Automatic walks, deliberately: a list that reads top to
   * bottom in a different order from the one the app tries is a list that
   * cannot be used to predict what Automatic will do.
   */
  const enabled = $derived(
    library.orderedProviders.filter((p) => library.activeProviderIds.includes(p.id)),
  )

  const selectedName = $derived(
    selected ? (enabled.find((p) => p.id === selected)?.name ?? 'Automatic') : 'Automatic',
  )

  /** Colour and tooltip, kept together so they cannot drift apart. */
  const OUTCOME_META: Record<TitleOutcome, { colour: string; title: string }> = {
    worked: { colour: 'var(--success)', title: 'Has played this title for you' },
    failed: { colour: 'var(--danger)', title: 'Tried, and could not play this title' },
  }

  const RESUME_TITLE = 'The source this title was last streamed on'

  /**
   * Re-read every time the menu opens.
   *
   * The log is appended to by the player as it plays, so the interesting change
   * is almost always the one that just happened — a source the user tried a
   * minute ago. Caching this would show them the state before their own attempt.
   */
  function toggle(): void {
    open = !open
    if (!open) return
    placeMenu()
    void window.wta.providers.outcomes(media).then((result) => (sourceState = result))
  }

  // The overlay behind the menu scrolls and the window resizes; a fixed menu
  // does not follow either on its own.
  $effect(() => {
    if (!open) return
    const reposition = (): void => placeMenu()
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  })

  function choose(providerId: string | null): void {
    open = false
    onselect(providerId)
  }
</script>

<div class="picker">
  <button
    class="trigger"
    bind:this={trigger}
    onclick={toggle}
    aria-expanded={open}
    title="Choose which provider plays this"
  >
    <span class="label">Source</span>
    <span class="value">{selectedName}</span>
    <span class="caret" class:open>▾</span>
  </button>

  {#if open}
    <div
      class="menu"
      in:menuIn
      out:menuOut
      style:top="{menuPos.top}px"
      style:left="{menuPos.left}px"
      style:max-height="{menuPos.maxHeight}px"
    >
      <button class="item" class:active={selected === null} onclick={() => choose(null)}>
        <span class="dot" style:background="var(--accent)"></span>
        <span class="name">Automatic</span>
        <span class="hint">Best available</span>
      </button>

      <div class="divider"></div>

      {#each enabled as provider (provider.id)}
        {@const resume = provider.id === sourceState.lastUsed}
        {@const outcome = sourceState.outcomes[provider.id]}
        <button
          class="item"
          class:active={selected === provider.id}
          onclick={() => choose(provider.id)}
        >
          <!--
            An empty slot, not a grey dot, when the provider has never been
            tried. A dot of any colour is a claim, and "no idea" is not one —
            keeping the space reserved is what stops the names jumping around.
          -->
          {#if resume}
            <span class="dot" style:background="var(--resume)" title={RESUME_TITLE}></span>
          {:else if outcome}
            <span
              class="dot"
              style:background={OUTCOME_META[outcome].colour}
              title={OUTCOME_META[outcome].title}
            ></span>
          {:else}
            <span class="dot none" title="Not tried for this title yet"></span>
          {/if}
          <span class="name">{provider.name}</span>
          {#if resume}
            <span class="hint resume">resume</span>
          {:else if outcome === 'failed'}
            <span class="hint bad">no stream</span>
          {/if}
        </button>
      {/each}

      {#if enabled.length === 0}
        <p class="empty">No providers enabled. Turn one on in the Providers panel.</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .picker {
    position: relative;
  }

  .trigger {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    height: 100%;
    padding: 0 var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-size: var(--text-sm);
  }

  .trigger:hover {
    border-color: var(--border-strong);
  }

  .label {
    color: var(--text-tertiary);
    font-size: var(--text-xs);
  }

  .value {
    font-weight: 600;
  }

  .caret {
    color: var(--text-tertiary);
    transition: transform var(--dur-fast) var(--ease-out);
  }

  .caret.open {
    transform: rotate(180deg);
  }

  .menu {
    /* Fixed, not absolute — see `placeMenu`. The detail overlay scrolls, and an
       absolutely-positioned menu is clipped by it and cannot be scrolled. */
    position: fixed;
    z-index: 200;
    min-width: 260px;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: var(--space-2);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--bg-raised);
    box-shadow: var(--shadow-lg);
  }

  .item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: var(--text-sm);
    text-align: left;
  }

  .item:hover {
    background: var(--bg-elevated);
  }

  .item.active {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    font-weight: 700;
  }

  /* Reserves the dot's space without asserting anything about the provider. */
  .dot.none {
    background: transparent;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: 0 0 auto;
  }

  .name {
    flex: 1;
  }

  .hint {
    color: var(--text-tertiary);
    font-size: var(--text-xs);
  }

  .hint.bad {
    color: var(--danger);
  }

  .hint.resume {
    color: var(--resume);
  }

  .divider {
    height: 1px;
    margin: var(--space-2) 0;
    background: var(--border-subtle);
  }

  .empty {
    margin: 0;
    padding: var(--space-2);
    color: var(--text-tertiary);
    font-size: var(--text-xs);
  }
</style>
