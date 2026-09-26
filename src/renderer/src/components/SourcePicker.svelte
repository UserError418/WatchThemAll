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
   * It now reports two kinds of evidence, both about *this* title:
   *
   *   - nothing at all — never tried or scanned, and saying anything would be
   *     a guess
   *   - red — tried or measured, and it produced no stream
   *   - amber — reachable, but nothing streamed while testing. Worth a try
   *   - green — it has actually played, or was just measured streaming
   *   - blue — the source this title was last streamed on, labelled "resume"
   *
   * Blue outranks green because it is the more specific claim: every blue
   * source is also a green one, and "this is where you were" is what the user
   * is looking for when they open this list mid-series. Everything below blue
   * is decided by `providerDot`, which is derived from `providerRank` — the
   * same function that orders Automatic's fallback chain.
   *
   * ## The order of the rows
   *
   * Automatic's own order, sent by main with the dots (`state.order`): working
   * sources at the top, "may work" in the middle, dead ones at the bottom, and
   * within each group the user's favourites and then their provider order. So
   * the list reads top to bottom in the order the app will actually try.
   *
   * The rows do not move while a test is running. The order is re-read when it
   * finishes, so the dots fill in where the user is looking and the list
   * re-sorts once, at the end, rather than shuffling under the pointer.
   * A source that streamed also shows how long it took to start and, where its
   * stream says, the best quality it offers.
   *
   * Within each group the order is the user's to choose — speed, quality, or
   * their own list first — under Settings → Source order. It is Automatic's
   * order either way, because the same setting drives both.
   *
   * ## Testing every source
   *
   * The dots above are blank for a title nobody has watched, which is exactly
   * when the user most needs them. "Test all sources" fills them in: it loads
   * every enabled provider in a hidden window and watches for a real media
   * request, which is the only signal a page that loads fine and plays nothing
   * cannot fake. It takes about a minute and reports as it goes.
   *
   * Still shown, never used to disable an option. A provider that failed
   * yesterday may work today, and the user's judgement has to be able to
   * override ours — so a red row stays clickable.
   */
  import { flip } from 'svelte/animate'
  import type { ProbeVerdict, ScanReason, TitleProviderState, TitleRef } from '@shared/ipc'
  import { formatQuality, formatStreamTime, inScanOrder, providerDot } from '@shared/scanrank'
  import { library } from '../lib/library.svelte'
  import { DUR_MID, duration, menuIn, menuOut } from '../lib/motion'
  import { scan } from '../lib/scan.svelte'

  interface Props {
    /** Currently selected provider id, or null to let the app decide. */
    selected: string | null
    /** The title the dots are about. */
    media: TitleRef
    /**
     * Which episode to test, for a series.
     *
     * Coverage is episode-level — a provider routinely carries a season one and
     * not a season four — so a scan that did not say which episode would
     * measure whichever one the URL template happened to build, and report it
     * as a fact about the show.
     */
    episode?: { season: number; episode: number } | null
    onselect: (providerId: string | null) => void
  }

  const { selected, media, episode = null, onselect }: Props = $props()

  let open = $state(false)
  let sourceState = $state<TitleProviderState>({
    outcomes: {},
    lastUsed: null,
    scan: null,
    order: [],
  })

  /**
   * The verdicts to draw, live run preferred over the stored one.
   *
   * A scan in flight for *this* title is the most current thing there is, and
   * its partial results are what make the dots fill in one by one instead of
   * appearing all at once at the end. When nothing is running, or the running
   * scan is measuring a different title, the stored scan is used — which
   * `providers.outcomes` has already discarded if it aged out.
   */
  const verdicts = $derived<Record<string, ProbeVerdict>>(
    scan.matches(media) ? scan.verdicts : (sourceState.scan?.verdicts ?? {}),
  )

  /** How long each streaming source took to start, from the same run as `verdicts`. */
  const timings = $derived<Record<string, number>>(
    scan.matches(media) ? scan.timings : (sourceState.scan?.timings ?? {}),
  )
  /** The best quality each streaming source offers, where its stream says. Same run again. */
  const qualities = $derived<Record<string, number>>(
    scan.matches(media) ? scan.qualities : (sourceState.scan?.qualities ?? {}),
  )
  /** Why each source that did not stream failed, where the test could tell. Same run again. */
  const reasons = $derived<Record<string, ScanReason>>(
    scan.matches(media) ? scan.reasons : (sourceState.scan?.reasons ?? {}),
  )

  /** True while a scan of the title this picker is showing is running. */
  const scanning = $derived(scan.running && scan.matches(media))

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

  /**
   * What the last test measured about one source, for the end of its label:
   * " · 3.8 s · 1080p". Only for a source that streamed; either part may be
   * missing, and a missing quality means the stream did not say, not that it
   * is poor.
   */
  function measurement(id: string): string {
    if (verdicts[id] !== 'stream') return ''
    const ms = timings[id]
    const quality = qualities[id]
    return (
      (ms !== undefined ? ` · ${formatStreamTime(ms)}` : '') +
      (quality !== undefined ? ` · ${formatQuality(quality)}` : '')
    )
  }

  /** The rows, in Automatic's order. See "The order of the rows" above. */
  const rows = $derived(inScanOrder(enabled, sourceState.order))

  const selectedName = $derived(
    selected ? (enabled.find((p) => p.id === selected)?.name ?? 'Automatic') : 'Automatic',
  )

  const RESUME_TITLE = 'The source this title was last streamed on'

  /** This document has the token sheet, so tones resolve to custom properties. */
  const TONE: Record<'good' | 'warn' | 'bad', string> = {
    good: 'var(--success)',
    warn: 'var(--warning)',
    bad: 'var(--danger)',
  }

  /**
   * How far the running scan has got, as a sentence.
   *
   * A bare spinner for sixty seconds is indistinguishable from a hang, and this
   * feature's entire pitch is that it saves the user from waiting through
   * providers one at a time — so it has to be visibly doing that.
   */
  const scanLabel = $derived.by(() => {
    if (!scanning) return null
    if (!scan.current) return 'Starting…'
    // The re-check runs after every provider has a verdict, so the counter is
    // already at its maximum — saying "12 of 12" again would read as stuck.
    if (scan.confirming) return `Double-checking ${scan.current}`
    const of = scan.total > 0 ? ` of ${scan.total}` : ''
    return `Testing ${scan.current} (${scan.done + 1}${of})`
  })

  /** How many sources the last scan found streaming, once it has finished. */
  const scanSummary = $derived.by(() => {
    if (scanning || !scan.matches(media)) return null
    const settled = Object.keys(scan.verdicts).length
    if (settled === 0) return null
    const working = Object.values(scan.verdicts).filter((v) => v === 'stream').length
    const stopped = scan.cancelled ? ' (stopped)' : ''
    return `${working} of ${settled} sources streaming${stopped}`
  })

  async function runScan(): Promise<void> {
    if (scanning) {
      await scan.cancel()
      return
    }
    await scan.start(media, episode)
    // Re-read so the stored scan and the outcome dots come from one moment.
    sourceState = await window.wta.providers.outcomes(media)
  }

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
      <!--
        Automatic and the test, pinned together at the head.

        The test used to sit at the foot, on the reasoning that the list is what
        the user came for. It was easy to miss there, and it is what makes the
        list worth reading: until it runs, most dots are empty. Sticky, so it
        stays in reach while a long list scrolls beneath it.
      -->
      <div class="head">
        <button class="item" class:active={selected === null} onclick={() => choose(null)}>
          <span class="dot" style:background="var(--accent)"></span>
          <span class="name">Automatic</span>
          <span class="hint">Best available</span>
        </button>
        {#if enabled.length > 0}
          <button class="scan" class:running={scanning} onclick={runScan}>
            <span class="name">{scanning ? 'Stop testing' : 'Test all sources'}</span>
            {#if scanLabel}
              <span class="hint">{scanLabel}</span>
            {:else if scanSummary}
              <span class="hint">{scanSummary}</span>
            {:else}
              <span class="hint">About a minute</span>
            {/if}
          </button>
          {#if scanning && scan.total > 0}
            <div class="progress" role="progressbar" aria-valuenow={scan.done} aria-valuemin={0} aria-valuemax={scan.total}>
              <div class="bar" style:width="{(scan.done / scan.total) * 100}%"></div>
            </div>
          {/if}
        {/if}
        <div class="divider"></div>
      </div>

      {#each rows as provider (provider.id)}
        {@const resume = provider.id === sourceState.lastUsed}
        {@const dot = providerDot(sourceState.outcomes[provider.id], verdicts[provider.id], reasons[provider.id])}
        {@const testing = scanning && scan.current === provider.name}
        {@const time = measurement(provider.id)}
        <button
          class="item"
          class:active={selected === provider.id}
          onclick={() => choose(provider.id)}
          animate:flip={{ duration: duration(DUR_MID) }}
        >
          <!--
            An empty slot, not a grey dot, when the provider has never been
            tried. A dot of any colour is a claim, and "no idea" is not one —
            keeping the space reserved is what stops the names jumping around.
          -->
          {#if resume}
            <span class="dot" style:background="var(--resume)" title={RESUME_TITLE}></span>
          {:else if dot.tone}
            <span class="dot" style:background={TONE[dot.tone]} title={dot.hint}></span>
          {:else}
            <span class="dot none" title={dot.hint}></span>
          {/if}
          <span class="name">{provider.name}</span>
          {#if resume}
            <span class="hint resume">resume{time}</span>
          {:else if testing}
            <!-- The one being measured right now, so the list shows progress
                 moving down it rather than only a counter changing. -->
            <span class="hint testing">testing…</span>
          {:else if dot.label}
            <span class="hint" class:bad={dot.tone === 'bad'}>{dot.label}{time}</span>
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

  /* Never wraps: "works · 3.8 s" broken across two lines reads as two claims. */
  .hint {
    color: var(--text-tertiary);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .hint.bad {
    color: var(--danger);
  }

  .hint.resume {
    color: var(--resume);
  }

  .hint.testing {
    color: var(--accent);
  }

  /*
    Deliberately shaped like an `.item` rather than like a primary button.
    It sits in a list of sources and does something *to* that list, so making
    it the loudest thing in the menu would pull the eye away from the choice
    the user opened the menu to make.
  */
  .scan {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
    font-family: inherit;
    text-align: left;
    cursor: pointer;
  }

  .scan:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }

  .scan.running {
    color: var(--accent);
  }

  .scan .name {
    font-weight: 500;
  }

  .progress {
    height: 2px;
    margin: 0 var(--space-3) var(--space-2);
    overflow: hidden;
    border-radius: 1px;
    background: var(--border-subtle);
  }

  .bar {
    height: 100%;
    background: var(--accent);
    /* Providers settle at wildly different speeds, so an un-eased bar jumps.
       The transition is what makes it read as progress rather than as glitching. */
    transition: width 240ms ease;
  }

  /*
    Stuck to the top of the scrolling menu. The negative offset and matching
    padding cover the menu's own padding, so rows scrolling underneath do not
    show through the gap above it.
  */
  .head {
    position: sticky;
    top: calc(-1 * var(--space-2));
    z-index: 1;
    margin-top: calc(-1 * var(--space-2));
    padding-top: var(--space-2);
    background: var(--bg-raised);
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
