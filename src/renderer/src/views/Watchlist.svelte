<script lang="ts">
  /**
   * The Watchlist surface: what the user is part-way through.
   *
   * It used to carry the history timeline underneath, folded away behind a
   * disclosure. That arrangement lost the argument twice over — the fold was
   * closed by default so the timeline was invisible, and a list squeezed into
   * the bottom of another tab could never grow into anything that answered a
   * question. History is its own tab now; this one is only the active list.
   */
  import type { MediaSummary } from '@shared/types'
  import { library } from '../lib/library.svelte'
  import { posterUrl } from '../lib/images'
  import { episodeCode, runtime } from '../lib/format'
  import Score from '../components/Score.svelte'

  interface Props {
    onselect: (media: MediaSummary) => void
  }

  const { onselect }: Props = $props()

  type Filter = 'all' | 'tv' | 'movie'
  let filter = $state<Filter>('all')

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
</script>

<div class="view">
  <section>
    <header class="section-head">
      <h2>Watchlist</h2>
      <div class="head-actions">
        <div class="filters">
          {#each [['all', 'All'], ['tv', 'Series'], ['movie', 'Films']] as const as [id, label] (id)}
            <button class:active={filter === id} onclick={() => (filter = id)}>{label}</button>
          {/each}
        </div>
      </div>
    </header>

    {#if entries.length === 0}
      <p class="state">
        Nothing here yet. Add something from Browse or Search and it will show up with a resume
        position.
      </p>
    {:else}
      <div class="grid">
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
                <span class="badge-score"><Score rating={entry.rating} onArtwork /></span>
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

</div>

<style>
  /* Top-right, clear of the resume chip and above the progress bar. */
  .badge-score {
    position: absolute;
    right: 6px;
    top: 6px;
  }

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

  .remove:hover {
    color: var(--danger);
  }

  .state {
    color: var(--text-tertiary);
    font-size: var(--text-sm);
    max-width: 60ch;
  }
</style>
