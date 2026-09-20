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

  .note {
    margin: 0;
    font-size: var(--text-sm, 13px);
    color: var(--accent, #ffce6a);
  }
</style>
