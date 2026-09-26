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
   */
  import SyncPanel from '../components/SyncPanel.svelte'
  import MalImportDialog from '../components/MalImportDialog.svelte'
  import { library } from '../lib/library.svelte'
  import type { MalPreview } from '@shared/ipc'
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
  <header class="page-head">
    <h1>Settings</h1>
  </header>

  <section class="card">
    <h2>Your data</h2>
    <p class="hint">
      Everything this app knows about you lives on this machine. An export is a
      single file you can keep, move to another device, or import back.
    </p>

    <div class="row">
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

  <section class="card">
    <h2>Sync</h2>
    <SyncPanel />
  </section>

  <section class="card">
    <h2>Source order</h2>
    <p class="hint">
      Sources that work always come first, then those that may work, then those that do not.
      Within each group, this decides the order — in the source lists and for Automatic. Speed
      and quality come from <strong>Test all sources</strong>.
    </p>

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

{#if malPreview}
  <MalImportDialog preview={malPreview} onclose={() => (malPreview = null)} />
{/if}

<style>
  .view {
    display: flex;
    flex-direction: column;
    gap: var(--space-5, 20px);
    max-width: 860px;
    padding-bottom: var(--space-8, 48px);
  }

  .page-head h1 {
    margin: 0;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 12px);
    padding: var(--space-5, 20px);
    border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
    border-radius: var(--radius-lg, 14px);
    background: var(--surface-1, rgba(255, 255, 255, 0.03));
  }

  .card h2 {
    margin: 0;
    font-size: var(--text-md, 15px);
    letter-spacing: 0.02em;
  }

  .hint,
  .privacy {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-sm, 13px);
    line-height: 1.6;
  }

  .privacy {
    color: var(--text-tertiary, var(--text-secondary));
    font-size: var(--text-xs, 12px);
  }

  .row {
    display: flex;
    gap: var(--space-2, 8px);
    flex-wrap: wrap;
  }

  /* The two import sources, offered as a choice rather than guessed at. */
  .choice {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: var(--space-2, 8px);
  }

  /* These have to *look* pressable. Laid out as cards they lost the app's
     default button affordance entirely and read as two paragraphs of text. */
  .choice button {
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: flex-start;
    text-align: left;
    padding: var(--space-3, 12px);
    line-height: 1.5;
    border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
    border-radius: var(--radius-md, 10px);
    background: var(--surface-2, rgba(255, 255, 255, 0.05));
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease;
  }

  .choice button:hover {
    background: var(--surface-3, rgba(255, 255, 255, 0.09));
    border-color: var(--accent, #ffce6a);
  }

  .choice span {
    color: var(--text-secondary);
    font-size: var(--text-xs, 12px);
  }

  .check {
    display: flex;
    align-items: center;
    gap: var(--space-2, 8px);
    font-size: var(--text-sm, 13px);
  }

  .sort-keys {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 8px);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .sort-keys li {
    display: flex;
    align-items: center;
    gap: var(--space-3, 12px);
    padding: var(--space-2, 8px) var(--space-3, 12px);
    border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
    border-radius: var(--radius-md, 10px);
    background: var(--surface-2, rgba(255, 255, 255, 0.05));
  }

  /* Below "Your list": still movable, visibly not in effect. */
  .sort-keys li.moot {
    opacity: 0.55;
  }

  .rank {
    width: 1.5em;
    color: var(--text-tertiary, var(--text-secondary));
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .what {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    font-size: var(--text-sm, 13px);
  }

  .what span {
    color: var(--text-secondary);
    font-size: var(--text-xs, 12px);
  }

  .move {
    width: 32px;
    height: 32px;
    border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
    border-radius: var(--radius-sm, 6px);
    background: none;
    color: inherit;
    cursor: pointer;
  }

  .move:hover:not(:disabled) {
    border-color: var(--accent, #ffce6a);
  }

  .move:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .note {
    margin: 0;
    font-size: var(--text-sm, 13px);
    color: var(--accent, #ffce6a);
  }
</style>
