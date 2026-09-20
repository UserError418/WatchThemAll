<script lang="ts">
  /**
   * App shell.
   *
   * Owns which surface is showing, the detail overlay, and the subscriptions to
   * main-process events. Every view fetches its own data — this is deliberately
   * not the old design, where one 3189-line class held all state for every
   * screen and re-rendered all of it whenever anything changed.
   */
  import type { MediaSummary } from '@shared/types'
  import type { PlayerState } from '@shared/ipc'
  import { library } from './lib/library.svelte'
  import { previewAudio } from './lib/preview.svelte'
  import Browse from './views/Browse.svelte'
  import Search from './views/Search.svelte'
  import Watchlist from './views/Watchlist.svelte'
  import Watched from './views/Watched.svelte'
  import Releases from './views/Releases.svelte'
  import History from './views/History.svelte'
  import Settings from './views/Settings.svelte'
  import CommandPalette from './components/CommandPalette.svelte'
  import DetailOverlay from './components/DetailOverlay.svelte'
  import PlayerFrame from './components/PlayerFrame.svelte'
  import ProviderPanel from './components/ProviderPanel.svelte'

  type Tab = 'browse' | 'search' | 'watchlist' | 'watched' | 'releases' | 'history' | 'settings'

  /**
   * Search is not among these on purpose.
   *
   * It used to be a tab, and a tab you land on with nothing typed is an empty
   * screen — which is the state it was in almost every time it was opened. As a
   * mode it is reachable from every surface without costing one, and it can
   * never be blank: typing is what summons it and clearing it puts you back
   * exactly where you were.
   */
  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'browse', label: 'Browse' },
    { id: 'watchlist', label: 'Watchlist' },
    { id: 'watched', label: 'Watched' },
    { id: 'releases', label: 'Releases' },
    { id: 'history', label: 'History' },
    { id: 'settings', label: 'Settings' },
  ]

  let tab = $state<Tab>('browse')
  let searchQuery = $state('')
  let searchInput = $state<HTMLInputElement | null>(null)

  /** Typing takes over the surface; clearing hands it back. */
  const searching = $derived(searchQuery.trim().length > 0)
  let selected = $state<MediaSummary | null>(null)
  /**
   * The inline player, or null when nothing is playing.
   *
   * Pushed from main rather than set here, because main is what actually knows:
   * it owns the native view, it is what falls back to another source, and it is
   * what tears the player down when every source has failed. A renderer-owned
   * flag would drift out of sync with the thing on screen the first time a
   * fallback ran.
   */
  let playing = $state<PlayerState | null>(null)
  /** A standing offer to leave a slow provider. Withdrawn by main, never here. */
  let providersOpen = $state(false)
  let paletteOpen = $state(false)
  let ready = $state(false)
  let loadError = $state<string | null>(null)
  let toast = $state<string | null>(null)
  /**
   * The nav floats over the hero and gains a background once the user scrolls.
   * Only Browse has a hero, so on every other surface it is solid immediately.
   */
  let scrolled = $state(false)
  const navSolid = $derived(scrolled || tab !== 'browse')

  function onMainScroll(event: Event): void {
    scrolled = (event.currentTarget as HTMLElement).scrollTop > 24
  }

  const trackedCount = $derived(library.trackers.length)
  const watchlistCount = $derived(library.watchlist.length)
  const watchedCount = $derived(library.watched.length)

  $effect(() => {
    void start()
  })

  async function start(): Promise<void> {
    try {
      await library.load()
      ready = true
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Could not load your library'
    }
  }

  /**
   * Main-process subscriptions. Each returns its own unsubscribe function, and
   * the effect's teardown calls them — the original registered listeners it had
   * no way to remove.
   */
  $effect(() => {
    const off = [
      window.wta.on.navigate((target) => {
        if (TABS.some((t) => t.id === target)) tab = target as Tab
      }),
      window.wta.on.menuAction((action) => {
        if (action === 'focus-search') {
          paletteOpen = true
        } else if (action === 'export') {
          void window.wta.data.export()
        } else if (action === 'import') {
          void window.wta.data.import(null).then(() => library.reload())
        }
      }),
      window.wta.on.storeChanged(() => void library.reload()),
      /**
       * Stop every preview while something is playing.
       *
       * Handled here rather than by the surface that started the play, because
       * the surfaces that need to stop are the ones the user has already
       * navigated away from — a hovered card whose row is now behind a player
       * window is not going to receive a `mouseleave`.
       */
      window.wta.on.playbackActive((active) => previewAudio.setSuspended(active)),
      window.wta.on.playerState((state) => (playing = state)),
      window.wta.on.releaseFound((payload) => {
        const list = Array.isArray(payload) ? payload : [payload]
        if (list.length === 0) return
        toast =
          list.length === 1
            ? `${list[0]?.title} has a new episode`
            : `${list.length} tracked series have new episodes`
        setTimeout(() => (toast = null), 6000)
      }),
      window.wta.on.episodeWatched(({ tmdbId, type, season, episode }) => {
        /**
         * Enough of something was watched to count.
         *
         * Fired on *leaving* it, not on starting it, and only past the halfway
         * threshold — so stepping through episodes with the player's own
         * controls still lands in the library, while opening a title and
         * backing straight out no longer does.
         */
        if (!library.isInWatchlist(tmdbId)) return

        // A film has no position to record; finishing one means the title
        // itself is watched.
        if (type === 'movie' || season == null || episode == null) {
          library.markTitleSeen(tmdbId)
          return
        }

        library.setPosition(tmdbId, season, episode)
        library.setWatched(tmdbId, season, episode, true)
      }),
      window.wta.on.playbackSettled((settled) => {
        /**
         * What the play amounted to, whatever it amounted to.
         *
         * Its sibling above is a verdict and fires only on success; this is the
         * measurement and fires every time, which is what lets the History tab
         * say "you gave this eleven minutes and stopped". Nothing is filtered
         * here — an entry for a title outside the watchlist is still a thing
         * that happened.
         */
        library.notePlayback(settled)
      }),
    ]
    return () => off.forEach((unsubscribe) => unsubscribe())
  })

  function onKeydown(event: KeyboardEvent): void {
    /**
     * The player owns the keyboard while it is up.
     *
     * Without this the shell's own Escape would close the detail overlay
     * *behind* the player — invisibly, so the user would come back from
     * watching an episode to the browse page instead of the episode list they
     * left. Same for `/`, which would focus a search box under a video.
     */
    if (playing) return

    const target = event.target as HTMLElement | null
    const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'

    if (event.key === 'Escape') {
      if (paletteOpen) paletteOpen = false
      else if (selected) selected = null
      else if (providersOpen) providersOpen = false
      // Last, because it is the least modal of the four: Escape should dismiss
      // whatever is on top before it undoes the search underneath it.
      else if (searching) searchQuery = ''
      return
    }

    /**
     * `/` and Ctrl/Cmd+F focus the search box from anywhere.
     *
     * Both, because the two habits are equally common and neither is worth
     * making someone unlearn. Not while already typing, or `/` would be
     * unusable inside the box it focuses.
     */
    if (!typing && event.key === '/') {
      searchInput?.focus()
      event.preventDefault()
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
      searchInput?.focus()
      searchInput?.select()
      event.preventDefault()
      return
    }

    // The menu accelerator covers Ctrl/Cmd+K, but the menu is hidden by
    // default on Windows and Linux, so bind it here too.
    if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
      paletteOpen = true
      event.preventDefault()
      return
    }

    // Anything below is a bare key; not while a modal owns the keyboard.
    if (paletteOpen) return

    // Digits switch tabs, but only when the user is not typing into something.
    if (typing || event.ctrlKey || event.metaKey || event.altKey) return
    const index = Number(event.key)
    if (index >= 1 && index <= TABS.length) {
      tab = TABS[index - 1]!.id
      event.preventDefault()
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="shell">
  <nav class:solid={navSolid}>
    <div class="nav-left">
      <span class="brand"
        ><span class="mark">▶</span><span class="brand-name">WatchThemAll</span></span
      >

      <div class="tabs">
        {#each TABS as t (t.id)}
          <button class:active={tab === t.id} onclick={() => (tab = t.id)}>
            {t.label}
            {#if t.id === 'watchlist' && watchlistCount > 0}
              <span class="count">{watchlistCount}</span>
            {:else if t.id === 'watched' && watchedCount > 0}
              <span class="count">{watchedCount}</span>
            {:else if t.id === 'releases' && trackedCount > 0}
              <span class="count">{trackedCount}</span>
            {/if}
          </button>
        {/each}
      </div>
    </div>

    <!--
      The search box, in the nav on every surface.

      Centred in the window rather than merely sitting between the tabs and the
      actions: it is the one control every surface shares, and a search field
      that drifts left or right as the nav's other contents change width reads
      as incidental. The nav is a three-column grid with equal outer columns so
      the middle one lands on the window's centre line regardless of how wide
      the brand or the action buttons are.
    -->
    <div class="nav-search">
      <svg class="magnifier" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <line x1="16.2" y1="16.2" x2="21" y2="21" />
      </svg>
      <input
        bind:this={searchInput}
        bind:value={searchQuery}
        type="search"
        placeholder="Search films and series…"
        autocomplete="off"
        spellcheck="false"
        aria-label="Search films and series"
      />
      {#if searching}
        <button
          class="clear"
          onclick={() => {
            searchQuery = ''
            searchInput?.focus()
          }}
          aria-label="Clear search"
          title="Clear search (Esc)">✕</button
        >
      {/if}
    </div>

    <div class="nav-actions">
      <!--
        The global preview-sound switch. It lives in the nav because it governs
        every preview surface — hovered cards, the browse billboard, the detail
        hero — and a control buried in one of them would read as local to it.
      -->
      <button
        class="sound-btn"
        class:muted={!library.settings.previewAudio}
        onclick={() => library.setPreviewAudio(!library.settings.previewAudio)}
        aria-pressed={library.settings.previewAudio}
        title={library.settings.previewAudio
          ? 'Preview sound is on — click to mute previews'
          : 'Preview sound is off — click to unmute previews'}
      >
        <!--
          A stroked SVG, not an emoji. Emoji render as full-colour bitmap
          glyphs from the system font — they carry their own palette and their
          own idea of weight, so they never match a flat monochrome UI and they
          look different on every platform the app ships to.
        -->
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
          {#if library.settings.previewAudio}
            <path d="M16 9.2a4 4 0 0 1 0 5.6" />
            <path d="M18.6 6.6a7.6 7.6 0 0 1 0 10.8" />
          {:else}
            <line x1="16.5" y1="9.5" x2="21" y2="14.5" />
            <line x1="21" y1="9.5" x2="16.5" y2="14.5" />
          {/if}
        </svg>
      </button>

      <button
        class="providers-btn"
        class:on={providersOpen}
        onclick={() => (providersOpen = !providersOpen)}
        title="Providers and data"
      >
        <!--
          The word is a separate element so a narrow viewport can drop it and
          keep the mark. At 412px the three-column nav gave the search field
          220px, which clipped its own placeholder mid-word.
        -->
        ◈ <span class="btn-label">Providers</span>
      </button>
    </div>
  </nav>

  <main class:under-hero={tab === 'browse' && !searching} onscroll={onMainScroll}>
    {#if loadError}
      <p class="fatal" role="alert">{loadError}</p>
    {:else if !ready}
      <p class="fatal">Loading your library…</p>
    {:else if searching}
      <Search onselect={(m) => (selected = m)} query={searchQuery} />
    {:else if tab === 'browse'}
      <Browse onselect={(m) => (selected = m)} />
    {:else if tab === 'watchlist'}
      <Watchlist onselect={(m) => (selected = m)} />
    {:else if tab === 'watched'}
      <Watched onselect={(m) => (selected = m)} />
    {:else if tab === 'history'}
      <History onselect={(m) => (selected = m)} />
    {:else if tab === 'settings'}
      <Settings />
    {:else}
      <Releases onselect={(m) => (selected = m)} />
    {/if}
  </main>
</div>

{#if providersOpen}
  <ProviderPanel onclose={() => (providersOpen = false)} />
{/if}

{#if selected}
  <DetailOverlay media={selected} onclose={() => (selected = null)} />
{/if}

<!--
  Above everything, and outside `.shell` — the native video view paints over
  the whole window, so the frame that reserves space for it cannot be nested
  inside a scrolling container.
-->
{#if playing}
  <PlayerFrame player={playing} onclose={() => void window.wta.player.close()} />
{/if}

{#if paletteOpen}
  <CommandPalette
    onclose={() => (paletteOpen = false)}
    onselect={(m) => (selected = m)}
    onnavigate={(t) => {
      if (t === 'search') {
        searchInput?.focus()
        return
      }
      tab = t
    }}
    onopenProviders={() => (providersOpen = true)}
  />
{/if}

{#if library.persistError}
  <div class="toast error" role="alert">
    Changes are not being saved: {library.persistError}
  </div>
{:else if toast}
  <div class="toast" role="status">{toast}</div>
{/if}

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  nav {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 30;
    /*
      Three columns, outer two equal. That equality is what actually centres
      the search box: with a flex row it would sit wherever the brand and the
      action buttons left room, and it would move every time a tab badge
      appeared. `minmax(0, 1fr)` rather than `1fr` so a long title in the left
      column shrinks instead of pushing the centre off-axis.
    */
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    gap: var(--space-5);
    height: var(--nav-height);
    padding: 0 var(--space-6);
    /* Transparent over the hero, so the artwork runs to the top edge. The
       gradient keeps the nav text legible against a bright backdrop. */
    background: linear-gradient(to bottom, rgb(var(--bg-base-rgb) / 0.85), transparent);
    /* The gradient must be sized to the border box, not the padding box. With
       the default `padding-box` origin it stops 1px short of the transparent
       border and then *repeats*, redrawing its dark first row as a hairline
       across the hero artwork. */
    background-origin: border-box;
    border-bottom: 1px solid transparent;
    transition:
      background var(--dur-mid) var(--ease-out),
      border-color var(--dur-mid) var(--ease-out);
  }

  nav.solid {
    background: var(--bg-raised);
    border-bottom-color: var(--border-subtle);
  }

  .nav-left {
    display: flex;
    align-items: center;
    gap: var(--space-5);
    min-width: 0;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-weight: 700;
    letter-spacing: 0.2px;
    white-space: nowrap;
  }

  .mark {
    color: var(--accent);
  }

  /*
    Below this the wordmark stops fitting.

    The nav's outer grid columns are equal by construction — that equality is
    what puts the search box on the window's centre line — so the *wider* of
    brand-plus-tabs and the action buttons sets both. On a 1024px window that
    left the tabs 282px of track for 384px of content and "Releases" rendered
    underneath the search box. Dropping the wordmark returns ~110px to the
    column, and the ▶ mark still identifies the app.
  */
  @media (max-width: 1180px) {
    .brand-name {
      display: none;
    }
  }

  .tabs {
    display: flex;
    gap: var(--space-4);
  }

  .tabs button {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
    border-bottom: 2px solid transparent;
    transition: color var(--dur-fast) var(--ease-out);
  }

  .tabs button:hover {
    color: var(--text-primary);
  }

  .tabs button.active {
    color: var(--text-primary);
    border-bottom-color: var(--accent);
  }

  .count {
    padding: 0 6px;
    border-radius: var(--radius-full);
    background: var(--bg-elevated);
    color: var(--text-tertiary);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  /**
   * The search box grows to take the slack between the tabs and the actions,
   * capped so it does not become a full-width bar on a wide window — a box that
   * wide reads as the page's primary content rather than as chrome.
   */
  .nav-search {
    position: relative;
    display: flex;
    align-items: center;
    /* Clamped rather than fixed: wide enough to invite a click on a large
       window, and it gives way before the tabs do on a small one. */
    width: clamp(220px, 30vw, 560px);
  }

  .nav-search input {
    width: 100%;
    height: 40px;
    /* Room for the magnifier on the left and the clear button on the right. */
    padding: 0 38px 0 40px;
    border-radius: var(--radius-full);
    background: var(--bg-raised);
    border: 1px solid var(--border-subtle);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-md);
    -webkit-user-select: text;
    user-select: text;
    transition:
      border-color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out),
      box-shadow var(--dur-fast) var(--ease-out);
  }

  .nav-search input:hover {
    border-color: var(--border-strong);
    background: var(--bg-elevated);
  }

  .nav-search input:focus {
    border-color: var(--accent);
    background: var(--bg-elevated);
    box-shadow: 0 0 0 3px var(--accent-muted);
    outline: none;
  }

  .magnifier {
    position: absolute;
    left: 14px;
    width: 16px;
    height: 16px;
    fill: none;
    stroke: var(--text-tertiary);
    stroke-width: 2;
    stroke-linecap: round;
    /* Decorative; the click target is the input underneath it. */
    pointer-events: none;
  }

  .nav-search:focus-within .magnifier {
    stroke: var(--text-secondary);
  }

  /*
    Chromium draws its own clear button inside `type="search"`, which sat beside
    ours and gave the field two ✕. Ours stays: it is the one we style, it also
    returns focus to the field, and it carries the shortcut in its tooltip.
  */
  .nav-search input::-webkit-search-cancel-button {
    display: none;
  }

  .nav-search input::placeholder {
    color: var(--text-tertiary);
  }

  .nav-search .clear {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    width: 24px;
    height: 24px;
    border-radius: var(--radius-full);
    color: var(--text-tertiary);
    font-size: var(--text-xs);
  }

  .nav-search .clear:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  /*
    The two controls sit at opposite ends of the right column.

    They do different jobs and belong to different things, so grouping them as
    a pair was wrong. The sound switch governs previews, which is what the
    surface under the search box is full of, so it stays beside the search box.
    The providers button opens the panel that slides in from the right edge —
    putting the button in that corner means the panel arrives from under it
    rather than from somewhere unrelated.
  */
  .nav-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  /*
    Same pill as the providers button beside it, so the two action controls
    read as one set rather than as an icon and a button that happen to be
    adjacent.
  */
  .sound-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border-subtle);
    background: transparent;
    color: var(--text-secondary);
    transition:
      color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }

  .sound-btn svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* The speaker cone is a solid shape; only the waves and the cross are lines. */
  .sound-btn svg path:first-child {
    fill: currentColor;
    stroke-width: 1;
  }

  .sound-btn:hover {
    color: var(--text-primary);
    border-color: var(--border-strong);
    background: var(--bg-elevated);
  }

  /*
    Sound on is the default and the louder state, so it is the one that gets
    the accent; muted is a plain outline rather than a dimmed version of the
    same thing, because a control at 50% opacity reads as disabled.
  */
  .sound-btn[aria-pressed='true'] {
    color: var(--accent);
    border-color: var(--accent);
  }

  .providers-btn {
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    background: var(--bg-elevated);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .providers-btn:hover,
  .providers-btn.on {
    background: var(--accent-muted);
    color: var(--text-primary);
  }

  main {
    flex: 1 1 auto;
    /*
      Both axes named on purpose.

      `overflow-y: auto` alone leaves `overflow-x` at `visible`, and CSS turns
      a `visible` axis into `auto` as soon as the other one is not — so this
      element has always been a *horizontal* scroller too. On a desktop window
      nothing overflows it and that is invisible; at 412px the browse rows do,
      and the page slid roughly 1600px sideways under the finger while the tab
      bar and the nav stayed put. Measured on an Android device: `scrollWidth`
      2002 against a `clientWidth` of 402.

      Each row already owns a scroller of its own (`RowShell`'s `.track`), so
      there is nothing here the user should ever scroll horizontally.
    */
    overflow-x: hidden;
    overflow-y: auto;
    /* The nav is out of flow, so surfaces without a hero need the space back. */
    padding-top: var(--nav-height);
  }

  /* Browse renders a hero that the nav floats over, so it reclaims the space.
     Svelte scopes styles per component, so this is a class on <main> rather
     than a `:has()` test for the child component's markup. */
  main.under-hero {
    padding-top: 0;
  }

  .fatal {
    padding: var(--space-7) var(--space-6);
    /* Cleared explicitly: this renders before any surface exists to size it. */
    color: var(--text-tertiary);
  }

  .toast.error {
    border-color: var(--danger);
    color: var(--danger);
  }

  .toast {
    position: fixed;
    bottom: var(--space-5);
    left: 50%;
    transform: translateX(-50%);
    z-index: 60;
    padding: var(--space-3) var(--space-5);
    border-radius: var(--radius-full);
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    box-shadow: var(--shadow-pop);
    font-size: var(--text-sm);
  }

  @media (max-width: 720px) {
    nav {
      gap: var(--space-3);
      padding: 0 var(--space-4);
    }
    .brand {
      font-size: var(--text-sm);
    }
    .tabs {
      gap: var(--space-3);
    }
  }
</style>
