<script lang="ts">
  /**
   * Everything that configures the app, in one place.
   *
   * These controls used to be in two places and neither was findable. Transfer
   * lived in the Watchlist header *and* again in the provider sidebar; sync,
   * notifications and skip-intro were in that sidebar's footer, below a list of
   * providers they have nothing to do with. The sidebar is for providers now.
   *
   * ## Import asks first
   *
   * There used to be a separate MyAnimeList button, and the reasoning for it
   * was sound: the two imports do genuinely different things — one merges an
   * export and is over in a click, the other opens a review dialog for a few
   * hundred anime — so a single control that guessed from the file extension
   * would leave the user unable to tell which they were about to get.
   *
   * Asking up front keeps that property while losing the third button. The
   * choice is still explicit and still made *before* a file picker opens; it is
   * simply made by the user rather than inferred from what they happened to
   * pick.
   *
   * ## Laid out in columns
   *
   * The cards used to stack in one 860px column pinned to the window's left
   * edge, with no page padding at all, and the rest of a desktop window empty.
   * They are grouped now by what they are about — what plays and how, and
   * where the library lives — and the groups sit side by side once there is
   * room, with the keyboard shortcuts as a third column on wide windows.
   */
  import SyncPanel from '../components/SyncPanel.svelte'
  import MalImportDialog from '../components/MalImportDialog.svelte'
  import PageHeader from '../components/PageHeader.svelte'
  import { library } from '../lib/library.svelte'
  import type { MalPreview, WatchlistTestStatus } from '@shared/ipc'
  import type { SourceSortKey } from '@shared/types'

  let note = $state<string | null>(null)
  /** Shown after Import is pressed, until a source is chosen or dismissed. */
  let choosingImport = $state(false)
  let malPreview = $state<MalPreview | null>(null)

  async function exportData(): Promise<void> {
    note = null
    const result = (await window.wta.data.export()) as {
      ok?: boolean
      cancelled?: boolean
      error?: string
    }
    if (result?.cancelled) return
    note = result?.ok ? 'Catalogue exported.' : (result?.error ?? 'Export failed.')
  }

  async function importCatalogue(): Promise<void> {
    choosingImport = false
    note = null
    const result = (await window.wta.data.import(null)) as {
      ok?: boolean
      cancelled?: boolean
      error?: string
    }
    if (result?.cancelled) return
    if (!result?.ok) {
      note = result?.error ?? 'Import failed.'
      return
    }
    // Main merged into the stored document; the in-memory copy is now stale and
    // would keep showing the pre-import catalogue.
    await library.reload()
    note = 'Catalogue imported.'
  }

  /** What each ordering key means, in the words the Settings card uses. */
  const SORT_KEY_TEXT: Record<SourceSortKey, { name: string; detail: string }> = {
    speed: {
      name: 'Speed',
      detail: 'How fast the stream started in the last test. Within 30% counts as the same.',
    },
    quality: {
      name: 'Quality',
      detail: 'The best quality the stream offers, where it says so.',
    },
    list: {
      name: 'Your list',
      detail: 'Favourites first, then your order in the Providers panel.',
    },
  }

  const sourceOrder = $derived(library.settings.sourceOrder)
  /**
   * Keys below "Your list" never get a say: it orders completely. Shown dimmed
   * rather than hidden, so moving one up is an obvious thing to try.
   */
  const listAt = $derived(sourceOrder.indexOf('list'))

  function moveSortKey(index: number, by: -1 | 1): void {
    const target = index + by
    if (target < 0 || target >= sourceOrder.length) return
    const next = [...sourceOrder]
    ;[next[index], next[target]] = [next[target] as SourceSortKey, next[index] as SourceSortKey]
    library.setSourceOrder(next)
  }

  /**
   * The watchlist tester's state, for one line under the order.
   *
   * Asked once on mount, then kept current by its event. Null on the phone,
   * which has no tester, and until the first answer arrives — the line is
   * simply absent then rather than saying something provisional.
   */
  let testStatus = $state<WatchlistTestStatus | null>(null)
  $effect(() => {
    void window.wta.providers.backgroundStatus().then((status) => (testStatus ??= status))
    return window.wta.on.watchlistTest((status) => (testStatus = status))
  })

  /** The status in words. See `watchlisttester.ts` for what each state means. */
  function describeTesting(status: WatchlistTestStatus): string {
    const progress = `${status.done} of ${status.total} watchlist sources up to date`
    switch (status.state) {
      case 'testing':
        return `Testing ${status.providerName} on ${status.title} — ${progress}.`
      case 'paused':
        return status.pausedFor === 'playback'
          ? `Paused while you watch — ${progress}.`
          : `Paused while a test by hand runs — ${progress}.`
      case 'idle':
        return status.total === 0
          ? 'Nothing on your watchlist to test yet.'
          : `All ${status.total} watchlist sources up to date. Reds are tested again after 3 days, ambers after 4, greens after 30.`
      case 'waiting':
        return `One source a minute — ${progress}.`
    }
  }

  async function importMal(): Promise<void> {
    choosingImport = false
    note = null
    try {
      malPreview = await window.wta.mal.preview()
    } catch (err) {
      note = err instanceof Error ? err.message : 'Could not read that file.'
    }
  }
</script>

<div class="view">
  <PageHeader title="Settings" />

  <div class="columns">
    <div class="column" aria-label="Watching">
      <p class="group">Watching</p>
      <section class="card">
        <h2>Source order</h2>
        <p class="hint">
          Sources that work always come first, then those that may work, then those that do not.
          Within each group, this decides the order — in the source lists and for Automatic. Speed
          and quality come from <strong>Test all sources</strong>.
        </p>
        {#if testStatus}
          <!-- The watchlist is tested in the background, so its lists are ready before you open them. -->
          <p class="hint testing">{describeTesting(testStatus)}</p>
        {/if}

        <ol class="sort-keys">
          {#each sourceOrder as key, index (key)}
            <li class:moot={index > listAt}>
              <span class="rank">{index + 1}</span>
              <span class="what">
                <strong>{SORT_KEY_TEXT[key].name}</strong>
                <span>
                  {index > listAt
                    ? 'No effect while below Your list, which already decides every tie.'
                    : SORT_KEY_TEXT[key].detail}
                </span>
              </span>
              <button
                class="move"
                aria-label="Move {SORT_KEY_TEXT[key].name} up"
                disabled={index === 0}
                onclick={() => moveSortKey(index, -1)}>↑</button
              >
              <button
                class="move"
                aria-label="Move {SORT_KEY_TEXT[key].name} down"
                disabled={index === sourceOrder.length - 1}
                onclick={() => moveSortKey(index, 1)}>↓</button
              >
            </li>
          {/each}
        </ol>
      </section>

      <section class="card">
        <h2>Playback and alerts</h2>

        <label class="check">
          <input
            type="checkbox"
            checked={library.settings.notificationsEnabled}
            onchange={(e) => library.setNotificationsEnabled(e.currentTarget.checked)}
          />
          Notify me about new episodes
        </label>

        <label class="check">
          <input
            type="checkbox"
            checked={library.settings.skipIntro}
            onchange={(e) => library.setSkipIntro(e.currentTarget.checked)}
          />
          Offer to skip intros
        </label>

        <!--
          Spelled out rather than hidden behind the label, because this is the only
          switch in the app that changes who learns what you are watching.
          Everything else here is either local or already visible to TMDB. It moved
          out of the provider sidebar together with its checkbox — a privacy note
          that ends up somewhere other than the control it describes is worse than
          none at all.
        -->
        <p class="privacy">
          Asks two community databases — <strong>IntroDB</strong> and <strong>SkipDB</strong>, plus
          <strong>AniSkip</strong> for anime — where the intro is, by IMDB id and episode number. They
          learn what you are watching. Nothing else is sent, and turning this off stops it at once.
        </p>
      </section>
    </div>

    <div class="column" aria-label="Your library">
      <p class="group">Your library</p>
      <section class="card">
        <h2>Sync</h2>
        <SyncPanel />
      </section>

      <section class="card">
        <h2>Your data</h2>
        <p class="hint">
          Your library lives on this machine, and in your own Google Drive if Sync is on. An
          export is a single file you can keep, move to another device, or import back.
        </p>

        <div class="row actions">
          <button onclick={exportData} title="Save your catalogue to a file">↑ Export</button>
          <button onclick={() => (choosingImport = !choosingImport)} title="Bring a catalogue in">
            ↓ Import
          </button>
        </div>

        {#if choosingImport}
          <div class="choice" role="group" aria-label="What are you importing?">
            <button onclick={importCatalogue}>
              <strong>A WatchThemAll export</strong>
              <span>Merges another copy of this app's catalogue into this one.</span>
            </button>
            <button onclick={importMal}>
              <strong>A MyAnimeList XML</strong>
              <span>Opens a review of what was found before anything is changed.</span>
            </button>
          </div>
        {/if}

        {#if note}<p class="note">{note}</p>{/if}
      </section>
    </div>

    <!--
      Only where there is a keyboard: the phone renders this same view, and a
      list of keys it does not have is a list of things that do not work.
    -->
    <div class="column shortcuts-column" aria-label="Keyboard">
      <p class="group">Keyboard</p>
      <section class="card">
        <h2>Shortcuts</h2>
        <dl class="keys">
          <dt><kbd>/</kbd> or <kbd>Ctrl</kbd> <kbd>F</kbd></dt>
          <dd>Search films and series</dd>
          <dt><kbd>Ctrl</kbd> <kbd>K</kbd></dt>
          <dd>Jump to a tab or a title on your lists, or run a command</dd>
          <dt><kbd>1</kbd> – <kbd>6</kbd></dt>
          <dd>Switch tabs, from Browse to Settings</dd>
          <dt><kbd>Esc</kbd></dt>
          <dd>Close whatever is open — a title, a menu, the player</dd>
        </dl>
      </section>
    </div>
  </div>
</div>

{#if malPreview}
  <MalImportDialog preview={malPreview} onclose={() => (malPreview = null)} />
{/if}

<style>
  .view {
    padding: var(--space-5) var(--space-6) var(--space-8);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  /*
    One column until two fit, then two, then three with the shortcuts.
    Columns rather than a grid of cards, so a tall card (the source order)
    does not stretch the short one beside it to match.
  */
  .columns {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-5);
    align-items: start;
  }

  @media (min-width: 1100px) {
    .columns {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .shortcuts-column {
      grid-column: span 2;
    }
  }

  @media (min-width: 1600px) {
    .columns {
      grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr) minmax(0, 0.8fr);
    }

    .shortcuts-column {
      grid-column: auto;
    }
  }

  /* After the rules above, which would otherwise win on source order. */
  @media (hover: none) {
    .shortcuts-column {
      display: none;
    }
  }

  .column {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }

  .group {
    margin: 0 0 calc(var(--space-1) * -1) var(--space-1);
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-caps);
    text-transform: uppercase;
    color: var(--text-tertiary);
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-5);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    background: var(--bg-raised);
  }

  .card h2 {
    margin: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-emphasis);
  }

  .hint,
  .privacy {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
  }

  .privacy {
    color: var(--text-tertiary);
    font-size: var(--text-xs);
  }

  .row {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  /* Export and Import are actions, and have to look pressable. */
  .actions button {
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-full);
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-size: var(--text-sm);
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }

  .actions button:hover {
    background: var(--bg-hover);
    border-color: var(--border-strong);
  }

  /* The two import sources, offered as a choice rather than guessed at. */
  .choice {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-2);
  }

  /* These have to *look* pressable. Laid out as cards they lost the app's
     default button affordance entirely and read as two paragraphs of text. */
  .choice button {
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: flex-start;
    text-align: left;
    padding: var(--space-3);
    line-height: var(--leading-normal);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
    cursor: pointer;
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }

  .choice button:hover {
    background: var(--bg-hover);
    border-color: var(--accent);
  }

  .choice span {
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .check {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }

  .sort-keys {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .sort-keys li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
  }

  /* Below "Your list": still movable, visibly not in effect. */
  .sort-keys li.moot {
    opacity: 0.55;
  }

  .rank {
    width: 1.5em;
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .what {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    font-size: var(--text-sm);
  }

  .what span {
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .move {
    width: 32px;
    height: 32px;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    cursor: pointer;
  }

  .move:hover:not(:disabled) {
    border-color: var(--accent);
  }

  .move:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .note {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--accent);
  }

  .keys {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--space-3) var(--space-4);
    align-items: baseline;
    margin: 0;
  }

  .keys dt {
    white-space: nowrap;
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }

  .keys dd {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  kbd {
    display: inline-block;
    min-width: 22px;
    padding: 2px 6px;
    border: 1px solid var(--border-default);
    border-bottom-width: 2px;
    border-radius: var(--radius-xs);
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    text-align: center;
  }
</style>
