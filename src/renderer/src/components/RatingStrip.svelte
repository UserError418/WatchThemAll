<script lang="ts">
  /**
   * The user's rating, 1 to 10, as a row of ten numbered pips.
   *
   * Replaces the thumbs (`RateButtons`), which carried the argument that the
   * recommendation only needed the sign. It no longer does — the taste model
   * reads how far a rating sits from the user's own mean — so the control has
   * to offer the whole scale. It still has to be something people use in
   * passing on a list of two hundred titles, which rules out a slider (a drag
   * is two gestures and imprecise on a phone) and a dropdown (a menu to open
   * for every title). Ten pips are one tap for any value, and the row reads
   * as a scale without a label.
   *
   * Tapping the value already set clears it, the same toggle the thumbs had,
   * so one control both states and retracts a rating. The exception is a
   * `coarse` value converted from a thumb: tapping it confirms it instead —
   * see `library.rate` for why.
   *
   * ## Two forms
   *
   * - **full** — the strip itself, for the detail overlay, where there is room
   *   and rating is the point of being there.
   * - **compact** — a chip showing the number (or "Rate"), for the Watched
   *   rows, where ten pips on every season of every series would be a wall of
   *   digits. Tapping the chip opens the strip on its own line below the row;
   *   choosing a value, Escape, or tapping anywhere else closes it.
   *
   * The compact strip is a *sibling* of the chip rather than its child, and it
   * spans every column of its parent (`grid-column: 1 / -1`, or a full flex
   * basis). Both Watched rows are grids, so the strip gets a line of its own
   * the width of the row instead of squeezing into the chip's cell — at 412px
   * the title column would otherwise go to zero and the page would scroll
   * sideways, which is exactly how the season ribbon once failed there.
   *
   * ## Clicks do not escape
   *
   * Every handler stops propagation, as the thumbs did: this sits inside cards
   * and rows that open the detail overlay on click, and a rating tap that also
   * opened the title would make rating a list impossible.
   */
  import { tick } from 'svelte'
  import type { MediaSummary, RatingValue } from '@shared/types'
  import { legacyRatingOf, ratingBand, type RatingBand } from '@shared/rating'
  import { library } from '../lib/library.svelte'

  interface Props {
    media: MediaSummary
    /**
     * Which season this rating is about, or null for the whole title.
     *
     * A show can be worth watching while one season of it is not, so the two
     * are stored separately and this control has to say which it is setting.
     */
    season?: number | null
    form?: 'full' | 'compact'
  }

  const { media, season = null, form = 'full' }: Props = $props()

  const VALUES: RatingValue[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const BAND_WORD: Record<RatingBand, string> = {
    liked: 'liked',
    mixed: 'mixed',
    disliked: 'disliked',
  }

  const id = $props.id()

  const value = $derived(library.ratingFor(media.tmdbId, season))
  const coarse = $derived(library.isCoarse(media.tmdbId, season))
  const band = $derived(value === null ? null : ratingBand(value))

  /** Only meaningful for the compact form; the full strip is always shown. */
  let open = $state(false)
  const showStrip = $derived(form === 'full' || open)

  /**
   * Which pip holds the tab stop — the roving tabindex a radio group uses, so
   * Tab enters the strip once and the arrows move within it. Follows the
   * rating until the user starts moving, then follows them.
   */
  let focused = $state<RatingValue | null>(null)
  const tabStop = $derived(focused ?? value ?? 1)

  let chip = $state<HTMLButtonElement | null>(null)
  let strip = $state<HTMLDivElement | null>(null)
  const pips: HTMLButtonElement[] = []

  const groupLabel = $derived(
    season === null ? 'Your rating, 1 to 10' : `Your rating for season ${season}, 1 to 10`,
  )

  /** "From your 👍" — the quiet hint that a value was converted, not chosen. */
  const coarseHint = $derived(
    value !== null && coarse
      ? `From your ${legacyRatingOf(value) === 'like' ? '👍' : '👎'} — tap to refine`
      : null,
  )

  function pipTitle(v: RatingValue): string {
    if (v === value) return coarseHint ?? `${v} — tap again to clear`
    return `${v} · ${BAND_WORD[ratingBand(v)]}`
  }

  function choose(v: RatingValue, event: MouseEvent): void {
    event.stopPropagation()
    library.rate(media, v, season)
    focused = null
    if (form === 'compact') close(true)
  }

  async function toggle(event: MouseEvent): Promise<void> {
    event.stopPropagation()
    if (open) {
      close(false)
      return
    }
    open = true
    // Into the strip, on the current value, so a keyboard user can go
    // straight to the arrows. On touch this is invisible: no focus ring
    // without `:focus-visible`.
    await tick()
    pips[(value ?? 1) - 1]?.focus()
  }

  function close(returnFocus: boolean): void {
    open = false
    focused = null
    if (returnFocus) chip?.focus()
  }

  /**
   * Arrows move, Enter and Space choose.
   *
   * Moving does not select, unlike a native radio group, because selecting
   * here writes to the library and would pass through every value on the way
   * to the one wanted. And the ends clamp rather than wrap: this is a scale,
   * and one more press past 10 landing on 1 is a surprise nobody wants.
   * Enter and Space need nothing here — each pip is a button.
   */
  function onKeydown(event: KeyboardEvent): void {
    const from = focused ?? value ?? 1
    let to: number | null = null

    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') to = Math.min(10, from + 1)
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') to = Math.max(1, from - 1)
    else if (event.key === 'Home') to = 1
    else if (event.key === 'End') to = 10
    else if (event.key === 'Escape' && open) {
      // Only when there is something to close. Otherwise Escape belongs to
      // the overlay or the view around this control.
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }

    if (to === null) return
    event.preventDefault()
    event.stopPropagation()
    focused = to as RatingValue
    pips[to - 1]?.focus()
  }

  /** The chip only answers Escape; the arrows belong to the open strip. */
  function onChipKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    event.stopPropagation()
    close(true)
  }

  /** Tapping anywhere outside the chip and the strip closes the strip. */
  $effect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target && (chip?.contains(target) || strip?.contains(target))) return
      close(false)
    }
    // Capture, so a handler that stops propagation underneath cannot keep
    // the strip open by accident.
    document.addEventListener('pointerdown', onPointer, true)
    return () => document.removeEventListener('pointerdown', onPointer, true)
  })
</script>

{#if form === 'compact'}
  <button
    bind:this={chip}
    class="chip"
    class:rated={value !== null}
    class:coarse
    style:--band={band ? `var(--rating-${band})` : null}
    aria-expanded={open}
    aria-controls="{id}-strip"
    aria-label={value === null ? 'Rate' : `Your rating: ${value} of 10. Change`}
    title={coarseHint ?? (value === null ? 'Rate this' : 'Change your rating')}
    onclick={toggle}
    onkeydown={onChipKeydown}
  >
    {value ?? 'Rate'}
  </button>
{/if}

{#if showStrip}
  <!-- `tabindex="-1"`: focusable, as an interactive role must be, but out of
       the Tab order. The tab stop is the roving pip inside it. -->
  <div
    bind:this={strip}
    id="{id}-strip"
    class="strip"
    class:inline={form === 'compact'}
    role="radiogroup"
    aria-label={groupLabel}
    tabindex="-1"
    style:--band={band ? `var(--rating-${band})` : null}
    onkeydown={onKeydown}
  >
    {#each VALUES as v (v)}
      <button
        bind:this={pips[v - 1]}
        class="pip"
        class:lit={v === value}
        class:filled={value !== null && v < value}
        class:coarse={v === value && coarse}
        style:--own="var(--rating-{ratingBand(v)})"
        role="radio"
        aria-checked={v === value}
        aria-label={v === value && coarseHint ? `${v}, ${coarseHint}` : String(v)}
        tabindex={v === tabStop ? 0 : -1}
        title={pipTitle(v)}
        onclick={(e) => choose(v, e)}
      >
        {v}
      </button>
    {/each}
  </div>
{/if}

<style>
  .strip {
    display: flex;
    gap: 2px;
    /* Flexible pips with a cap: the whole scale fits wherever it is put, from
       a 270px season row on a phone to the detail overlay, and never stretches
       into a bar of wide slabs on a desktop row. */
    width: min(100%, 360px);
    min-width: 0;
  }

  /*
    The compact form's strip, on a line of its own under the row. Spans every
    column of a grid parent, or takes a whole line in a wrapping flex one, and
    sits under the chip at the right-hand end where the eye already is.
  */
  .strip.inline {
    grid-column: 1 / -1;
    flex-basis: 100%;
    /* Placed after its siblings. Without it the grid's auto-placement moves
       past the strip's new line in document order, and the row's ✕, which
       follows the chip, drops to a third line under the strip. */
    order: 1;
    justify-self: end;
    margin: var(--space-1) 0 var(--space-1);
  }

  .pip {
    flex: 1 1 0;
    min-width: 0;
    /* The touch target's height is the thing not to give up at 412px; width
       is what shrinks. */
    height: 32px;
    display: grid;
    place-items: center;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
    background: var(--bg-raised);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    transition:
      color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }

  .inline .pip {
    height: 28px;
  }

  /* Each pip previews its own band under the pointer, so the scale explains
     itself before anything is chosen. */
  .pip:hover {
    color: var(--text-primary);
    border-color: var(--own);
  }

  /* Everything up to the value, faintly: the magnitude reads at a glance
     without having to find the one lit digit. */
  .pip.filled {
    background: color-mix(in srgb, var(--band) 16%, var(--bg-raised));
    border-color: color-mix(in srgb, var(--band) 24%, transparent);
  }

  .pip.lit {
    background: var(--band);
    border-color: var(--band);
    color: var(--text-on-accent);
    font-weight: var(--weight-bold);
  }

  /* Converted from a thumb. Dashed rather than a badge or a colour of its
     own: it should read as "approximately" to anyone looking, and as nothing
     at all to anyone who is not. */
  .pip.lit.coarse {
    background: color-mix(in srgb, var(--band) 55%, var(--bg-raised));
    border-style: dashed;
    border-color: var(--text-primary);
  }

  .chip {
    min-width: 40px;
    height: 28px;
    padding: 0 var(--space-2);
    border-radius: var(--radius-full);
    border: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    transition:
      color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }

  .chip:hover {
    color: var(--text-primary);
    border-color: var(--border-strong);
    background: var(--bg-elevated);
  }

  /* Rated: the number in its band's colour, as the lit thumb used to be. */
  .chip.rated {
    color: var(--band);
    border-color: var(--band);
    font-weight: var(--weight-bold);
  }

  .chip.rated.coarse {
    border-style: dashed;
  }
</style>
