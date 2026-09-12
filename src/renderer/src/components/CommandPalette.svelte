<script lang="ts">
  /**
   * Command palette (Ctrl/Cmd+K).
   *
   * Searches the user's own library and offers the app's commands in one list.
   * Deliberately local-only: it is a navigation tool, not a second search
   * surface. Typing here should never wait on the network, and the Search tab
   * already covers "find something I do not have".
   *
   * Scoring is prefix-and-substring rather than fuzzy. Fuzzy matching looks
   * clever in a demo and produces baffling orderings on a library of a few
   * hundred titles, where the user almost always knows the first word.
   */
  import type { MediaSummary } from '@shared/types'
  import { library } from '../lib/library.svelte'
  import { episodeCode } from '../lib/format'
  import { posterUrl } from '../lib/images'
  import { modalIn, modalOut, scrimIn, scrimOut } from '../lib/motion'

  type Tab = 'browse' | 'search' | 'watchlist' | 'releases'

  interface Props {
    onclose: () => void
    onselect: (media: MediaSummary) => void
    onnavigate: (tab: Tab) => void
    onopenProviders: () => void
  }

  const { onclose, onselect, onnavigate, onopenProviders }: Props = $props()

  interface Entry {
    id: string
    label: string
    hint: string
    posterPath?: string | null
    run: () => void
  }

  let query = $state('')
  let active = $state(0)
  let input = $state<HTMLInputElement | null>(null)

  $effect(() => {
    input?.focus()
  })

  const commands = $derived<Entry[]>([
    { id: 'cmd-browse', label: 'Go to Browse', hint: 'Command', run: () => onnavigate('browse') },
    { id: 'cmd-search', label: 'Go to Search', hint: 'Command', run: () => onnavigate('search') },
    {
      id: 'cmd-watchlist',
      label: 'Go to Watchlist',
      hint: 'Command',
      run: () => onnavigate('watchlist'),
    },
    {
      id: 'cmd-releases',
      label: 'Go to Releases',
      hint: 'Command',
      run: () => onnavigate('releases'),
    },
    {
      id: 'cmd-providers',
      label: 'Open Providers',
      hint: 'Command',
      run: () => onopenProviders(),
    },
    {
      id: 'cmd-check',
      label: 'Check releases now',
      hint: 'Command',
      run: () => void window.wta.releases.checkNow().then(() => library.reload()),
    },
    {
      id: 'cmd-export',
      label: 'Export data',
      hint: 'Command',
      run: () => void window.wta.data.export(),
    },
    {
      id: 'cmd-import',
      label: 'Import data',
      hint: 'Command',
      run: () => void window.wta.data.import(null).then(() => library.reload()),
    },
  ])

  function toMedia(entry: {
    tmdbId: number
    type?: 'tv' | 'movie'
    title: string
    posterPath: string | null
    genreIds?: number[]
  }): MediaSummary {
    return {
      tmdbId: entry.tmdbId,
      type: entry.type ?? 'tv',
      title: entry.title,
      posterPath: entry.posterPath,
      backdropPath: null,
      overview: '',
      rating: 0,
      releaseDate: null,
      genreIds: entry.genreIds ?? [],
    }
  }

  const libraryEntries = $derived<Entry[]>([
    ...library.watchlist.map((w) => ({
      id: `w-${w.id}`,
      label: w.title,
      hint:
        w.type === 'tv'
          ? `Watchlist · ${episodeCode(w.lastSeason ?? 1, w.lastEpisode ?? 1)}`
          : 'Watchlist · Film',
      posterPath: w.posterPath,
      run: () => onselect(toMedia(w)),
    })),
    ...library.trackers
      // A tracked series that is also in the watchlist would appear twice.
      .filter((t) => !library.isInWatchlist(t.tmdbId))
      .map((t) => ({
        id: `t-${t.id}`,
        label: t.title,
        hint: 'Tracking releases',
        posterPath: t.posterPath,
        run: () => onselect(toMedia(t)),
      })),
  ])

  const results = $derived.by<Entry[]>(() => {
    const q = query.trim().toLowerCase()
    const all = [...libraryEntries, ...commands]
    if (!q) return all.slice(0, 12)

    return all
      .map((entry) => {
        const label = entry.label.toLowerCase()
        // Prefix beats word-start beats substring; anything else is dropped.
        const score = label.startsWith(q)
          ? 0
          : label.split(/\s+/).some((word) => word.startsWith(q))
            ? 1
            : label.includes(q)
              ? 2
              : 3
        return { entry, score }
      })
      .filter((r) => r.score < 3)
      .sort((a, b) => a.score - b.score || a.entry.label.localeCompare(b.entry.label))
      .slice(0, 12)
      .map((r) => r.entry)
  })

  // Keep the highlight inside the list as it shrinks under a longer query.
  $effect(() => {
    if (active >= results.length) active = Math.max(0, results.length - 1)
  })

  function choose(entry: Entry | undefined): void {
    if (!entry) return
    entry.run()
    onclose()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      active = Math.min(active + 1, results.length - 1)
      event.preventDefault()
    } else if (event.key === 'ArrowUp') {
      active = Math.max(active - 1, 0)
      event.preventDefault()
    } else if (event.key === 'Enter') {
      choose(results[active])
      event.preventDefault()
    } else if (event.key === 'Escape') {
      onclose()
      event.preventDefault()
    }
  }
</script>

<div class="scrim" in:scrimIn out:scrimOut>
  <button class="scrim-catch" onclick={onclose} tabindex="-1" aria-hidden="true"></button>

  <div class="palette" in:modalIn out:modalOut role="dialog" aria-modal="true" aria-label="Command palette">
    <div class="field">
      <input
        bind:this={input}
        bind:value={query}
        onkeydown={onKeydown}
        type="text"
        placeholder="Jump to a title, or type a command…"
        autocomplete="off"
        spellcheck="false"
        aria-label="Command palette"
      />
      <kbd>esc</kbd>
    </div>

    {#if results.length === 0}
      <p class="empty">No match in your library or commands.</p>
    {:else}
      <ul>
        {#each results as entry, index (entry.id)}
          {@const poster = entry.posterPath ? posterUrl(entry.posterPath, 'w154') : null}
          <li>
            <button
              class:active={index === active}
              onclick={() => choose(entry)}
              onmouseenter={() => (active = index)}
            >
              {#if poster}
                <img src={poster} alt="" width="22" height="33" loading="lazy" />
              {:else}
                <span class="glyph" aria-hidden="true">›</span>
              {/if}
              <span class="label">{entry.label}</span>
              <span class="hint">{entry.hint}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    <footer>
      <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
      <span><kbd>↵</kbd> open</span>
      <span><kbd>esc</kbd> close</span>
    </footer>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 70;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    background: var(--bg-scrim);
  }

  .scrim-catch {
    position: fixed;
    inset: 0;
    cursor: default;
  }

  .palette {
    position: relative;
    width: min(560px, 92vw);
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-pop);
    overflow: hidden;
  }

  .field {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
  }

  input {
    flex: 1;
    background: none;
    border: none;
    color: var(--text-primary);
    font: inherit;
    outline: none;
    -webkit-user-select: text;
    user-select: text;
  }

  input::placeholder {
    color: var(--text-tertiary);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: var(--space-2);
    max-height: 46vh;
    overflow-y: auto;
  }

  li button {
    display: grid;
    grid-template-columns: 22px 1fr auto;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-2);
    border-radius: var(--radius-sm);
    text-align: left;
  }

  li button.active {
    background: var(--accent-muted);
  }

  li img {
    width: 22px;
    height: 33px;
    object-fit: cover;
    border-radius: 2px;
  }

  .glyph {
    text-align: center;
    color: var(--text-tertiary);
  }

  .label {
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hint {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    white-space: nowrap;
  }

  .empty {
    margin: 0;
    padding: var(--space-5) var(--space-4);
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }

  footer {
    display: flex;
    gap: var(--space-4);
    padding: var(--space-2) var(--space-4);
    border-top: 1px solid var(--border-subtle);
    color: var(--text-tertiary);
    font-size: var(--text-xs);
  }

  kbd {
    display: inline-block;
    padding: 0 4px;
    border: 1px solid var(--border-strong);
    border-radius: 3px;
    font-family: inherit;
    font-size: 10px;
  }
</style>
