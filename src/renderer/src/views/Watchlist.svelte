<script lang="ts">
  /**
   * The Watchlist surface: what the user is watching, plus the history timeline.
   *
   * Two sections rather than two tabs, because they answer the same question
   * ("what have I been watching") at different granularities, and splitting
   * them further would mean another click to see the thing you just watched.
   */
  import type { MediaSummary } from '@shared/types'
  import type { MalPreview } from '@shared/ipc'
  import MalImportDialog from '../components/MalImportDialog.svelte'
  import { library } from '../lib/library.svelte'
  import { posterUrl } from '../lib/images'
  import { episodeCode, runtime, timeAgo } from '../lib/format'

  interface Props {
    onselect: (media: MediaSummary) => void
  }

  const { onselect }: Props = $props()

  type Filter = 'all' | 'tv' | 'movie'
  let filter = $state<Filter>('all')
  let historyQuery = $state('')

  /**
   * History folds away, and the watchlist takes the room.
   *
   * The two sections compete for one screen and they are not equally urgent:
   * the watchlist is what you came to act on, history is what you came to
   * remember. Collapsing history is the cheap way to give the active list the
   * whole page, so the tiles get larger and the progress bar becomes readable
   * at a glance instead of being a two-pixel line under a thumbnail.
   */
  const historyCollapsed = $derived(library.settings.historyCollapsed)

  interface Progress {
    /** 0–100, or null when the series total is not known yet. */
    percent: number | null
    /** The line under the title: where you are, and how far that is. */
    label: string
  }

  /**
   * Where the user is in a title.
   *
   * Deliberately shows the resume *position* even when the total is unknown —
   * "S02E04" is the useful half of the answer and it is always available,
   * whereas the percentage needs a detail fetch that may not have happened yet.
   * Showing 0% in that case would be a confident lie about an unwatched-looking
   * series the user is halfway through.
   */
  function progressOf(entry: {
    type: 'tv' | 'movie'
    tmdbId: number
    lastSeason: number | null
    lastEpisode: number | null
    watchedEpisodes: string[]
    episodeCount: number | null
  }): Progress {
    /**
     * A film has no episodes to count, so its bar comes from where playback
     * was left instead — the position main records on exit.
     *
     * Falls back to the bare "Film" label when there is no position, which is
     * both the never-started case and the watched-to-the-end case: main drops
     * a resume point once it is past the last twentieth, so a finished film
     * does not sit at 99% forever.
     */
    if (entry.type === 'movie') {
      const film = library.filmProgress(entry.tmdbId)
      if (!film) return { percent: null, label: 'Film' }
      return { percent: film.percent, label: `${runtime(film.minutesIn)} in` }
    }

    const position = episodeCode(entry.lastSeason ?? 1, entry.lastEpisode ?? 1)
    const watched = entry.watchedEpisodes.length
    const total = entry.episodeCount

    if (!total || total <= 0) {
      return {
        percent: null,
        label: watched > 0 ? `${position} · ${watched} watched` : position,
      }
    }

    const percent = Math.min(100, Math.round((watched / total) * 100))
    return { percent, label: `${position} · ${watched} of ${total}` }
  }

  const entries = $derived(
    filter === 'all' ? library.watchlist : library.watchlist.filter((w) => w.type === filter),
  )

  const history = $derived.by(() => {
    const q = historyQuery.trim().toLowerCase()
    return q ? library.history.filter((h) => h.title.toLowerCase().includes(q)) : library.history
  })

  /**
   * Watchlist entries are not `MediaSummary`, but the detail overlay only needs
   * enough to render its hero while the real detail loads.
   */
  function asMedia(entry: {
    tmdbId: number
    type: 'tv' | 'movie'
    title: string
    posterPath: string | null
  }): MediaSummary {
    return {
      tmdbId: entry.tmdbId,
      type: entry.type,
      title: entry.title,
      posterPath: entry.posterPath,
      backdropPath: null,
      overview: '',
      rating: 0,
      releaseDate: null,
      genreIds: [],
    }
  }

  /**
   * Catalogue transfer.
   *
   * The export format is frozen and shared with the Android app and the
   * ReelVault extension, so both directions go through the main process rather
   * than being re-implemented here — there is exactly one copy of the merge
   * logic and this is not it.
   */
  let transferNote = $state<string | null>(null)

  async function exportData(): Promise<void> {
    transferNote = null
    const result = (await window.wta.data.export()) as { ok?: boolean; cancelled?: boolean; error?: string }
    if (result?.cancelled) return
    transferNote = result?.ok ? 'Catalogue exported.' : (result?.error ?? 'Export failed.')
  }

  async function importData(): Promise<void> {
    transferNote = null
    const result = (await window.wta.data.import(null)) as {
      ok?: boolean
      cancelled?: boolean
      error?: string
    }
    if (result?.cancelled) return
    if (!result?.ok) {
      transferNote = result?.error ?? 'Import failed.'
      return
    }
    // The main process merged into the stored document; the in-memory copy is
    // now stale and would silently show the pre-import catalogue.
    await library.reload()
    transferNote = 'Catalogue imported.'
  }

  /**
   * A separate button from the catalogue import, deliberately.
   *
   * The two do genuinely different things: one merges a WatchThemAll export and
   * is over in a click, the other opens a review dialog for a few hundred anime
   * and asks where each status group should land. Folding them into one control
   * that behaves differently depending on the file extension would mean the
   * user cannot tell which they are about to get until it happens.
   */
  async function importMal(): Promise<void> {
    transferNote = null
    try {
      malPreview = await window.wta.mal.preview()
    } catch (err) {
      transferNote = err instanceof Error ? err.message : 'Could not read that file.'
    }
  }

  let malPreview = $state<MalPreview | null>(null)
</script>

<div class="view">
  <section>
    <header class="section-head">
      <h2>Watchlist</h2>
      <div class="head-actions">
        <!--
          Import/export lives here as well as in the Providers panel. This is
          the catalogue, so this is where someone looks for it — the menu bar is
          hidden by default and the command palette has to be known about first.
        -->
        <div class="transfer">
          <button onclick={exportData} title="Save your catalogue to a file">↑ Export</button>
          <button onclick={importData} title="Merge a catalogue file into this one">
            ↓ Import
          </button>
          <button onclick={importMal} title="Import a MyAnimeList XML export">
            ↓ MyAnimeList
          </button>
        </div>
        <div class="filters">
          {#each [['all', 'All'], ['tv', 'Series'], ['movie', 'Films']] as const as [id, label] (id)}
            <button class:active={filter === id} onclick={() => (filter = id)}>{label}</button>
          {/each}
        </div>
      </div>
    </header>

    {#if transferNote}
      <p class="transfer-note" role="status">{transferNote}</p>
    {/if}

    {#if entries.length === 0}
      <p class="state">
        Nothing here yet. Add something from Browse or Search and it will show up with a resume
        position.
      </p>
    {:else}
      <div class="grid" class:roomy={historyCollapsed}>
        {#each entries as entry (entry.id)}
          {@const poster = posterUrl(entry.posterPath)}
          {@const progress = progressOf(entry)}
          <div class="tile">
            <button class="tile-main" onclick={() => onselect(asMedia(entry))}>
              <div class="art">
                {#if poster}
                  <img src={poster} alt="" loading="lazy" decoding="async" width="168" height="252" />
                {:else}
                  <div class="art-empty">{entry.title.slice(0, 1)}</div>
                {/if}

                <!-- Progress sits on the artwork, where the eye already is,
                     rather than below it competing with the title. -->
                {#if progress.percent !== null}
                  <div class="bar" aria-hidden="true">
                    <span style:width="{progress.percent}%"></span>
                  </div>
                {/if}

                <span class="resume">▶ {progress.label}</span>
              </div>
              <span class="title">{entry.title}</span>
              <span class="sub">
                {progress.label}
                {#if progress.percent !== null}
                  <span class="pct">· {progress.percent}%</span>
                {/if}
              </span>
            </button>
            <button
              class="remove"
              onclick={() => library.removeFromWatchlist(entry.tmdbId)}
              aria-label="Remove {entry.title} from watchlist"
              title="Remove from watchlist">✕</button
            >
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <section>
    <header class="section-head">
      <button
        class="disclosure"
        onclick={() => library.setHistoryCollapsed(!historyCollapsed)}
        aria-expanded={!historyCollapsed}
        title={historyCollapsed ? 'Show history' : 'Hide history and give the watchlist the room'}
      >
        <span class="chevron" class:collapsed={historyCollapsed} aria-hidden="true">⌄</span>
        <h2>History</h2>
        {#if library.history.length > 0}
          <span class="count">{library.history.length}</span>
        {/if}
      </button>

      {#if !historyCollapsed}
        <div class="history-tools">
          {#if library.history.length > 0}
            <input
              bind:value={historyQuery}
              type="search"
              placeholder="Filter history…"
              aria-label="Filter history"
            />
            <button class="ghost" onclick={() => library.clearHistory()}>Clear all</button>
          {/if}
        </div>
      {/if}
    </header>

    {#if historyCollapsed}
      <!-- Nothing rendered while collapsed: the point is the vertical space,
           and a placeholder would give most of it straight back. -->
    {:else if library.history.length === 0}
      <p class="state">Nothing watched yet. Hitting play anywhere records it here.</p>
    {:else if history.length === 0}
      <p class="state">No history matches “{historyQuery.trim()}”.</p>
    {:else}
      <ul class="history">
        {#each history as item (item.id)}
          {@const thumb = posterUrl(item.posterPath, 'w154')}
          <li>
            <button class="history-main" onclick={() => onselect(asMedia(item))}>
              {#if thumb}
                <img src={thumb} alt="" loading="lazy" decoding="async" width="34" height="51" />
              {:else}
                <span class="history-thumb-empty" aria-hidden="true"></span>
              {/if}
              <span class="history-title">{item.title}</span>
              <span class="history-meta">
                {#if item.season != null && item.episode != null}
                  {episodeCode(item.season, item.episode)} ·
                {/if}
                {timeAgo(item.watchedAt)}
              </span>
            </button>
            <button
              class="remove"
              onclick={() => library.removeHistoryEntry(item.id)}
              aria-label="Remove this history entry"
              title="Remove">✕</button
            >
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

{#if malPreview}
  <MalImportDialog preview={malPreview} onclose={() => (malPreview = null)} />
{/if}

<style>
  .view {
    padding: var(--space-5) var(--space-6) var(--space-8);
    display: flex;
    flex-direction: column;
    gap: var(--space-7);
  }

  .section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    margin-bottom: var(--space-4);
    flex-wrap: wrap;
  }

  h2 {
    margin: 0;
    font-size: var(--text-lg);
  }

  .head-actions {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }

  .transfer {
    display: flex;
    gap: var(--space-2);
  }

  .transfer button {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  .transfer button:hover {
    border-color: var(--border-strong);
    color: var(--text-primary);
  }

  .transfer-note {
    margin: 0 0 var(--space-3);
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }

  .filters {
    display: flex;
    gap: var(--space-1);
  }

  .filters button {
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    background: var(--bg-raised);
  }

  .filters button.active {
    background: var(--accent-muted);
    color: var(--text-primary);
  }

  .history-tools {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }

  input {
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-md);
    background: var(--bg-raised);
    border: 1px solid var(--border-subtle);
    color: var(--text-primary);
    font-size: var(--text-sm);
    -webkit-user-select: text;
    user-select: text;
  }

  .ghost {
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
  .ghost:hover {
    color: var(--danger);
  }

  /**
   * `auto-fit`, not `auto-fill`, and that one word is the whole fix.
   *
   * `auto-fill` creates as many tracks as the width allows and leaves the
   * surplus ones empty — so a seven-title watchlist on a wide display rendered
   * seven small posters hugging the left edge with a third of the page blank
   * beside them. `auto-fit` collapses the empty tracks, and the `1fr` then
   * shares the width among the tiles that actually exist.
   *
   * The cap is what stops that becoming absurd at the other end: without it a
   * watchlist of one renders a single poster half a metre tall. Tiles grow to
   * fill the row up to 1.9x their base size and centre in their track after
   * that, which covers everything from one title to forty.
   */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(var(--poster-width), 1fr));
    gap: var(--space-5) var(--space-3);
    justify-items: center;
  }

  .grid > :global(*) {
    width: 100%;
    max-width: calc(var(--poster-width) * 1.9);
  }

  /**
   * With history folded away the watchlist owns the page, so the tiles grow
   * into it rather than the section just ending higher up. Bigger tiles are
   * the actual payoff of collapsing; leaving the grid unchanged would make the
   * toggle feel like it did nothing but move a heading.
   */
  .grid.roomy {
    grid-template-columns: repeat(auto-fit, minmax(calc(var(--poster-width) * 1.45), 1fr));
    gap: var(--space-6) var(--space-4);
  }

  .grid.roomy > :global(*) {
    max-width: calc(var(--poster-width) * 2.4);
  }

  /** Watched-through fraction, drawn along the foot of the artwork. */
  .bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 4px;
    background: rgba(255, 255, 255, 0.24);
  }

  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
  }

  /**
   * The resume position, over the art on hover.
   *
   * Duplicated from the line below the title on purpose: at the roomy size the
   * artwork is what the eye lands on, and reading the answer there saves a
   * glance downward. It is hidden until hover so it does not compete with the
   * poster at rest.
   */
  .resume {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 4px;
    padding: var(--space-3) var(--space-2) var(--space-2);
    background: linear-gradient(to top, rgba(0, 0, 0, 0.88), transparent);
    color: var(--text-on-media);
    font-size: var(--text-xs);
    font-weight: 600;
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease-out);
  }

  .tile:hover .resume,
  .tile-main:focus-visible .resume {
    opacity: 1;
  }

  .pct {
    color: var(--accent-hover);
  }

  /* The History heading is the toggle, so the whole row is the hit target. */
  .disclosure {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    margin-left: calc(var(--space-2) * -1);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
  }

  .disclosure:hover {
    background: var(--bg-raised);
  }

  .chevron {
    display: inline-block;
    color: var(--text-tertiary);
    transition: transform var(--dur-fast) var(--ease-out);
  }

  .chevron.collapsed {
    transform: rotate(-90deg);
  }

  .count {
    padding: 0 6px;
    border-radius: var(--radius-full);
    background: var(--bg-elevated);
    color: var(--text-tertiary);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .tile {
    position: relative;
  }

  .tile-main {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    width: 100%;
    text-align: left;
    padding: 0;
  }

  .art {
    position: relative;
    aspect-ratio: var(--poster-ratio);
    border-radius: var(--radius-md);
    overflow: hidden;
    background: var(--bg-elevated);
    box-shadow: var(--shadow-card);
  }

  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .art-empty {
    display: grid;
    place-items: center;
    height: 100%;
    font-size: var(--text-xl);
    color: var(--text-disabled);
  }

  .title {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    line-height: var(--leading-snug);
    letter-spacing: var(--tracking-snug);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .sub {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }

  .remove {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
    width: 24px;
    height: 24px;
    border-radius: var(--radius-full);
    background: var(--bg-scrim);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease-out);
  }

  /* Invisible but still tappable without a pointer — and this one deletes.
     See the same note in `PosterCard`. */
  @media (hover: none) {
    .remove,
    .resume {
      opacity: 1;
    }
  }

  .tile:hover .remove,
  li:hover .remove,
  .remove:focus-visible {
    opacity: 1;
  }

  .remove:hover {
    color: var(--danger);
  }

  .history {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .history li {
    position: relative;
    border-bottom: 1px solid var(--border-subtle);
  }

  .history-main {
    display: grid;
    grid-template-columns: 34px 1fr auto;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-2) var(--space-6) var(--space-2) var(--space-2);
    text-align: left;
    border-radius: var(--radius-sm);
  }

  .history-main:hover {
    background: var(--bg-raised);
  }

  .history-main img,
  .history-thumb-empty {
    width: 34px;
    height: 51px;
    border-radius: var(--radius-sm);
    object-fit: cover;
    background: var(--bg-elevated);
  }

  .history-title {
    font-size: var(--text-sm);
  }

  .history-meta {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    white-space: nowrap;
  }

  .state {
    color: var(--text-tertiary);
    font-size: var(--text-sm);
    max-width: 60ch;
  }
</style>
