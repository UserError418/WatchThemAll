<script lang="ts">
  /**
   * The player's floating chrome.
   *
   * Lives in a transparent `WebContentsView` stacked above the video, which is
   * the only arrangement in which it can overlap the picture at all: the app
   * window's own page always paints beneath its child views, so the controls
   * used to grow a band and push the video down instead of floating over it.
   *
   * That freedom comes with one obligation, and it shapes everything here:
   * **a view swallows every mouse event inside its bounds.** Whatever this
   * document covers is unclickable in the video underneath. So the overlay is
   * sized to exactly what it draws — `reportHeight` is not a nicety, it is what
   * keeps the rest of the picture usable.
   */

  import type {
    PlayerContext,
    PlayerSuggestion,
    TitleOutcome,
    TitleProviderState,
  } from '@shared/ipc'
  import { untrack } from 'svelte'
  import type { Episode } from '@shared/types'

  const BAR_HEIGHT = 56
  const EPISODE_PANEL_HEIGHT = 226
  const SOURCE_PANEL_MAX = 300
  /** How long the bar stays after the pointer stops asking for it. */
  const HIDE_AFTER_MS = 2_800

  /**
   * The same, with a panel open. Longer, because a list is being read rather
   * than glanced at — but still finite, which is the point: an open panel used
   * to hold the chrome open indefinitely, and since this view swallows every
   * click inside its bounds that left a third of the picture permanently
   * unusable to anyone who opened the source list and then looked away.
   */
  const PANEL_HIDE_AFTER_MS = 5_000

  /**
   * The strip this view keeps even when the chrome is away.
   *
   * Without it the bar could never come back, and for a while it never did.
   * The original trigger was the player view's `input-event` stream, on the
   * stated grounds that no frame can hide an event from it. That is wrong, and
   * measurably so: an embed plays the video in a cross-origin iframe, Chromium
   * routes pointer events straight to that frame's own widget after the first
   * hit test, and the top-level view stops being told. Driving the mouse from
   * the middle of the picture to the top edge produced exactly **one** report,
   * for the position where it entered, and then silence — so nothing ever said
   * "near the top" and the bar was never seen at all.
   *
   * A live strip of our own has no such hole: this document is a real view and
   * gets every event inside its bounds whatever the page below is doing. The
   * cost is the forty pixels of picture it makes unclickable, which is the
   * cheapest thing in reach — it is the band the bar covers anyway.
   */
  const HOT_ZONE_PX = 40

  const api = window.wtaChrome

  let context = $state<PlayerContext | null>(null)
  let panel = $state<'none' | 'episodes' | 'sources'>('none')
  let barVisible = $state(true)
  let hoveringChrome = $state(false)

  /**
   * What each source has actually done with this title.
   *
   * The same question the detail view's picker answers, and deliberately the
   * same call — a second derivation would eventually disagree with the first,
   * and the user would have two lists telling them different things about the
   * same provider. See `SourcePicker.svelte` for what the colours claim.
   *
   * Worth more here than there, because this list is the one people reach for
   * *after* a source has just disappointed them: the point is to pick the next
   * one without guessing.
   */
  let sourceState = $state<TitleProviderState>({ outcomes: {}, lastUsed: null })

  /** Colour and tooltip together, so they cannot drift apart. */
  const OUTCOME_META: Record<TitleOutcome, { colour: string; title: string }> = {
    worked: { colour: '#34d399', title: 'Has played this title for you' },
    failed: { colour: '#fb5c76', title: 'Tried, and could not play this title' },
  }
  /** `--resume` from the app's tokens; this document has no stylesheet to read. */
  const RESUME_COLOUR = '#5b9dfa'
  const RESUME_TITLE = 'The source this title was last streamed on'

  /**
   * Re-read on every open, never cached.
   *
   * The player appends to this log as it plays, so the most interesting entry
   * is almost always the one written seconds ago — the source that just failed
   * and sent the user to this menu in the first place.
   */
  function openSources(): void {
    if (panel === 'sources') {
      panel = 'none'
      return
    }
    panel = 'sources'
    if (context === null) return
    void api
      .outcomes({ type: context.type, imdbId: context.imdbId, tmdbId: context.tmdbId })
      .then((result) => (sourceState = result))
      .catch(() => {
        // No record is a fair answer: every dot is simply blank, which is what
        // "never tried" looks like anyway.
        sourceState = { outcomes: {}, lastUsed: null }
      })
  }

  /** Episodes of the season being browsed, which need not be the one playing. */
  let browsingSeason = $state<number | null>(null)
  let episodes = $state<Episode[]>([])
  let loadingEpisodes = $state(false)

  $effect(() => api?.onContext((next) => (context = next)))

  /* ── The failed-source offer ──────────────────────────────────────────── */

  /**
   * Moved here from the app window, and the move is the whole point.
   *
   * The app window's page paints *beneath* the native player view, so a banner
   * there could not be drawn over the picture — it had to reserve a band of
   * layout, and that reservation is what squashed the video down every time a
   * provider failed. This document is the layer that can float, so the banner
   * floats.
   */
  let suggestion = $state<PlayerSuggestion | null>(null)
  $effect(() => api?.onSuggestion((next) => (suggestion = next)))

  /**
   * How long the user has to stop the switch.
   *
   * The offer is not a question: the provider has already failed and the user
   * is looking at a black rectangle, so doing nothing should fix it rather
   * than preserve it. Five seconds is long enough to read the sentence and
   * reach the button, short enough that waiting it out is never the fastest
   * way to give up.
   */
  const AUTOSWITCH_SECONDS = 5

  /** Seconds left, or null when no countdown is running. */
  let countdown = $state<number | null>(null)

  /**
   * Keyed on the offer itself, so a second provider failing restarts the clock
   * rather than inheriting what was left of the first one's.
   */
  $effect(() => {
    const pending = suggestion
    if (!pending) {
      countdown = null
      return
    }

    /**
     * The seconds live in a plain local and are only mirrored into state.
     * Reading `countdown` inside the effect would make the effect depend on a
     * value it writes every tick, so each tick would tear the interval down
     * and start another — which once produced two intervals and switched the
     * provider twice.
     */
    let left = untrack(() => countdown) ?? AUTOSWITCH_SECONDS
    countdown = left

    const tick = setInterval(() => {
      left -= 1
      countdown = left
      if (left > 0) return
      clearInterval(tick)
      api.switchProvider(pending.nextProviderId)
    }, 1000)

    return () => clearInterval(tick)
  })

  function switchNow(): void {
    if (!suggestion) return
    countdown = null
    api.switchProvider(suggestion.nextProviderId)
  }

  /** Stop the clock and stay put. The source keeps loading either way. */
  function keepWaiting(): void {
    countdown = null
    void api.dismissSuggestion()
  }

  /**
   * Measured rather than assumed: the sentence wraps at narrow widths, and a
   * guessed height either clips the buttons or swallows clicks on picture the
   * banner is not covering.
   */
  let suggestionHeight = $state(0)

  /**
   * The bar is summoned by the pointer and dismissed by time.
   *
   * Position is a *trigger*, not a hold: an earlier version treated "pointer is
   * near the top" as a reason to stay open, so nudging the mouse mid-episode
   * brought the bar back and it never left again. Only hovering the chrome
   * itself, or having a panel open, actually holds it.
   *
   * A second trigger, and the one that carries the weight — see `HOT_ZONE_PX`.
   * This one only sees the pointer while it is over parts of the player that
   * are not the provider's iframe, which on a playing embed is almost nowhere.
   */
  $effect(() =>
    api?.onPointerTop((nearTop) => {
      if (nearTop) barVisible = true
    }),
  )

  /**
   * A standing offer pins the chrome open.
   *
   * Two reasons. The source has just failed, so the controls are the thing the
   * user wants in front of them; and the banner hangs below the bar, so a bar
   * that came and went underneath it would slide the buttons up and down while
   * somebody was aiming at them.
   */
  $effect(() => {
    if (suggestion) barVisible = true
  })

  $effect(() => {
    if (!barVisible) return
    if (suggestion) return
    // Hovering the chrome holds it open — including hovering a panel, which is
    // a child of it. Nothing else does.
    if (hoveringChrome) return
    const timer = setTimeout(
      () => (barVisible = false),
      panel === 'none' ? HIDE_AFTER_MS : PANEL_HIDE_AFTER_MS,
    )
    return () => clearTimeout(timer)
  })

  /** Closing the chrome must not leave a panel open behind it. */
  $effect(() => {
    if (!barVisible) panel = 'none'
  })

  const panelHeight = $derived(
    panel === 'episodes' ? EPISODE_PANEL_HEIGHT : panel === 'sources' ? SOURCE_PANEL_MAX : 0,
  )

  /**
   * How much of the window this overlay may cover.
   *
   * Everything it draws, and — when it draws nothing — the strip it needs to
   * notice the pointer coming back. A view swallows every click inside its
   * bounds, so this is the number that decides how much of the picture stays
   * the user's.
   */
  const neededHeight = $derived(
    (barVisible ? BAR_HEIGHT + panelHeight : HOT_ZONE_PX) + suggestionHeight,
  )

  $effect(() => {
    api?.setOverlayHeight(neededHeight)
  })

  /* ── Episodes ─────────────────────────────────────────────────────────── */

  async function loadSeason(season: number): Promise<void> {
    if (context === null || context.type !== 'tv') return
    loadingEpisodes = true
    browsingSeason = season
    try {
      const result = await api.season(context.tmdbId, season)
      // Guard against a slow answer for a season the user has since left.
      if (browsingSeason === season) episodes = result?.episodes ?? []
    } catch {
      // A failed fetch leaves the strip empty rather than breaking the chrome;
      // the player itself is unaffected by not knowing the episode list.
      if (browsingSeason === season) episodes = []
    } finally {
      loadingEpisodes = false
    }
  }

  function openEpisodes(): void {
    if (panel === 'episodes') {
      panel = 'none'
      return
    }
    panel = 'episodes'
    if (context?.season != null && browsingSeason !== context.season)
      void loadSeason(context.season)
  }

  const still = (path: string | null): string | null =>
    path === null ? null : `https://image.tmdb.org/t/p/w300${path}`

  /** "1h 2m", "52m", or nothing at all rather than a misleading "0m". */
  function runtimeLabel(minutes: number | null): string {
    if (minutes === null || minutes <= 0) return ''
    const hours = Math.floor(minutes / 60)
    return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
  }

  const positionLabel = $derived(
    context === null || context.season === null || context.episode === null
      ? ''
      : `S${String(context.season).padStart(2, '0')}E${String(context.episode).padStart(2, '0')}`,
  )
</script>

<!--
  `onmouseenter`/`onmouseleave` on the chrome itself is what holds it open. The
  pointer merely being near the top is a trigger, handled above.
-->
{#if !barVisible}
  <!--
    The invisible strip along the top edge. `onmousemove` as well as
    `onmouseenter`, because the enter can be missed: the bar hides by shrinking
    this view underneath a pointer that is already inside it, and no crossing
    means no `mouseenter` — the bar would then be unreachable until the pointer
    left and came back.
  -->
  <div
    class="hotzone"
    style="height: {HOT_ZONE_PX}px"
    aria-hidden="true"
    onmouseenter={() => (barVisible = true)}
    onmousemove={() => (barVisible = true)}
  ></div>
{:else}
  <div
    class="chrome"
    role="group"
    aria-label="Player controls"
    onmouseenter={() => (hoveringChrome = true)}
    onmouseleave={() => (hoveringChrome = false)}
  >
    <div class="bar" style="height: {BAR_HEIGHT}px">
      <button class="ghost" onclick={() => api.back()}>← Back</button>

      <span class="title">{context?.title ?? ''}</span>
      {#if positionLabel}<span class="position">{positionLabel}</span>{/if}

      <span class="spacer"></span>

      <button class="ghost" title="Reload this source" onclick={() => void api.reload()}>↻</button>

      {#if context?.type === 'tv'}
        <button class="ghost" class:active={panel === 'episodes'} onclick={openEpisodes}>
          Episodes
        </button>
      {/if}

      <button class="ghost" class:active={panel === 'sources'} onclick={openSources}>
        {context?.providerName ?? 'Source'} ▾
      </button>
    </div>

    {#if panel === 'episodes'}
      <!--
        A strip that floats over the picture rather than displacing it. Each
        card carries the same three facts the series detail view shows, because
        that is what makes an episode recognisable: the still, what it is
        called, and how long it runs.
      -->
      <div class="panel episodes">
        {#if loadingEpisodes}
          <p class="hint">Loading episodes…</p>
        {:else if episodes.length === 0}
          <p class="hint">No episode list for this season.</p>
        {:else}
          <div class="strip">
            {#each episodes as episode (episode.episode)}
              <button
                class="episode"
                class:playing={episode.episode === context?.episode &&
                  browsingSeason === context?.season}
                onclick={() => {
                  if (browsingSeason !== null) api.goTo(browsingSeason, episode.episode)
                  panel = 'none'
                }}
              >
                <span class="thumb">
                  {#if still(episode.stillPath)}
                    <img src={still(episode.stillPath)} alt="" loading="lazy" />
                  {/if}
                </span>
                <span class="meta">
                  <span class="ep-title">{episode.episode}. {episode.name}</span>
                  <span class="ep-runtime">{runtimeLabel(episode.runtime)}</span>
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if panel === 'sources'}
      <div class="panel sources">
        {#each context?.providers ?? [] as provider (provider.id)}
          {@const resume = provider.id === sourceState.lastUsed}
          {@const outcome = sourceState.outcomes[provider.id]}
          <button
            class="source"
            class:playing={provider.id === context?.providerId}
            onclick={() => {
              api.switchProvider(provider.id)
              panel = 'none'
            }}
          >
            <!--
              An empty slot rather than a grey dot when a provider has never
              been tried. A dot of any colour is a claim and "no idea" is not
              one; reserving the space is what keeps the names from shifting.
            -->
            {#if resume}
              <span class="dot" style:background={RESUME_COLOUR} title={RESUME_TITLE}></span>
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
            {#if provider.id === context?.providerId}
              <span class="tag">Playing</span>
            {:else if resume}
              <span class="tag resume">resume</span>
            {:else if outcome === 'failed'}
              <span class="tag bad">no stream</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<!--
  Always present, so `clientHeight` reads a real 0 when there is no offer.
  Binding on the banner itself would leave the last measured height behind
  when it unmounted, and the overlay would keep swallowing clicks on picture
  it had stopped drawing over.
-->
<div class="offer-slot" bind:clientHeight={suggestionHeight}>
  {#if suggestion}
    <div class="suggestion" role="alert">
      <span class="reason">{suggestion.reason}.</span>
      <!--
        The seconds are hidden from assistive tech while the sentence is not:
        `role="alert"` re-announces its whole subtree on every change, so a
        live counter would read the banner out five times. The buttons carry
        the same information in their labels.
      -->
      <span class="offer">
        Switching to {suggestion.nextProviderName}
        {#if countdown !== null}<span class="count" aria-hidden="true">in {countdown}s</span>{/if}
      </span>
      <button class="switch" onclick={switchNow}>Switch now</button>
      <button class="wait" onclick={keepWaiting}>Keep waiting</button>

      <!-- A draining bar, so the deadline is legible without reading it. -->
      {#if countdown !== null}
        <div class="timer" aria-hidden="true">
          <span style:width="{(countdown / AUTOSWITCH_SECONDS) * 100}%"></span>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /*
    Deliberately draws nothing. It exists to be hovered — the view under it is
    sized to exactly this, so it is also the only part of the picture the
    overlay is costing the user while the chrome is away.
  */
  .hotzone {
    width: 100%;
  }

  .offer-slot {
    font:
      500 13px/1.4 Inter,
      system-ui,
      sans-serif;
    color: #e9e9ee;
  }

  /*
    Floats over the picture rather than displacing it — which is the whole
    reason it moved into this document. Opaque, because it has to stay
    readable over whatever frame the video happens to be showing.
  */
  .suggestion {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 8px 14px;
    margin: 6px 14px 0;
    padding: 12px 16px;
    border-radius: 12px;
    background: rgba(8, 8, 12, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .reason {
    font-weight: 600;
  }

  .offer {
    color: #9a9aa6;
  }

  .suggestion button {
    border: none;
    border-radius: 999px;
    cursor: pointer;
    font:
      600 12px/1 Inter,
      system-ui,
      sans-serif;
    padding: 7px 14px;
    white-space: nowrap;
  }

  .switch {
    background: #e8b04b;
    color: #17130a;
  }

  .wait {
    background: rgba(255, 255, 255, 0.1);
    color: #e9e9ee;
  }

  .count {
    color: #e8b04b;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  /* On the banner's bottom edge, so it reads as the deadline for the whole
     prompt rather than as one more control in the row. */
  .timer {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 2px;
    background: rgba(255, 255, 255, 0.12);
  }

  .timer span {
    display: block;
    height: 100%;
    background: #e8b04b;
    /* Exactly one tick, linear: easing here would make the bar disagree with
       the number beside it. */
    transition: width 1s linear;
  }

  .chrome {
    font:
      500 13px/1 Inter,
      system-ui,
      sans-serif;
    color: #e9e9ee;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    /* Fading rather than a hard edge: the picture reads through the chrome
       instead of being cropped by a bar sitting on top of it. */
    background: linear-gradient(to bottom, rgba(8, 8, 12, 0.94), rgba(8, 8, 12, 0));
  }

  .title {
    font-weight: 600;
  }

  .position {
    color: #9a9aa6;
    font-size: 12px;
  }

  .spacer {
    flex: 1;
  }

  .ghost {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 7px;
    color: inherit;
    cursor: pointer;
    font: inherit;
    padding: 7px 11px;
  }

  .ghost:hover {
    background: rgba(255, 255, 255, 0.16);
  }

  .ghost.active {
    background: rgba(240, 180, 90, 0.22);
    border-color: rgba(240, 180, 90, 0.5);
  }

  .panel {
    margin: 6px 14px 0;
    border-radius: 12px;
    background: rgba(8, 8, 12, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.1);
    overflow: hidden;
  }

  .episodes {
    height: 200px;
  }

  .hint {
    color: #9a9aa6;
    margin: 0;
    padding: 24px;
  }

  /* Horizontal, because a season is a sequence and scanning it sideways is how
     the detail view already presents it. */
  .strip {
    display: flex;
    gap: 12px;
    height: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 12px;
    scrollbar-width: thin;
  }

  .episode {
    background: none;
    border: 1px solid transparent;
    border-radius: 9px;
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    font: inherit;
    gap: 7px;
    padding: 6px;
    text-align: left;
    width: 208px;
  }

  .episode:hover {
    background: rgba(255, 255, 255, 0.07);
  }

  .episode.playing {
    border-color: rgba(240, 180, 90, 0.55);
  }

  .thumb {
    background: #17171d;
    border-radius: 6px;
    display: block;
    height: 110px;
    overflow: hidden;
    width: 100%;
  }

  .thumb img {
    height: 100%;
    object-fit: cover;
    width: 100%;
  }

  .meta {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .ep-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ep-runtime {
    color: #9a9aa6;
    font-size: 12px;
  }

  .sources {
    max-height: 288px;
    overflow-y: auto;
    padding: 6px;
    width: 260px;
    margin-left: auto;
    margin-right: 14px;
  }

  .source {
    align-items: center;
    background: none;
    border: none;
    border-radius: 7px;
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    gap: 9px;
    padding: 9px 10px;
    text-align: left;
    width: 100%;
  }

  /* Takes the slack, so the tag stays pinned to the right edge. */
  .source .name {
    flex: 1;
  }

  .dot {
    border-radius: 50%;
    flex: 0 0 auto;
    height: 7px;
    width: 7px;
  }

  /* The reserved blank. See the comment on the markup. */
  .dot.none {
    background: none;
  }

  .source:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .source.playing {
    color: #f0b45a;
  }

  .tag {
    color: #9a9aa6;
    flex: 0 0 auto;
    font-size: 12px;
  }

  .tag.resume {
    color: #5b9dfa;
  }

  .tag.bad {
    color: #fb5c76;
  }
</style>
