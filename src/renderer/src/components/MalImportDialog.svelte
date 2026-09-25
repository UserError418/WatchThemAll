<script lang="ts">
  /**
   * Review a MyAnimeList export before importing it.
   *
   * A MAL list is a few hundred titles accumulated over years, and importing it
   * blind rewrites someone's whole library in one click. So nothing happens
   * until the user has seen what is in the file, decided where each status
   * group belongs, and had the chance to untick anything they do not want.
   *
   * The grouping is by MAL status rather than alphabetical because the status is
   * the only thing that determines where a title *goes* — reviewing 311 titles
   * as one flat list would be pointless, while reviewing five groups and
   * spot-checking inside them is a minute's work.
   *
   * Nothing here has touched TMDB yet. The preview is parsed from the XML
   * alone, so opening the file is instant and cancelling costs nothing; the
   * several hundred lookups happen only once this dialog is confirmed.
   */
  import type { MalPreview, MalPreviewEntry, MalStatusId, MalTarget } from '@shared/ipc'
  import { SvelteSet } from 'svelte/reactivity'
  import { library } from '../lib/library.svelte'
  import { modalIn, modalOut, scrimIn, scrimOut } from '../lib/motion'

  interface Props {
    preview: MalPreview
    onclose: () => void
  }

  const { preview, onclose }: Props = $props()

  const TARGETS: Array<{ id: MalTarget; label: string }> = [
    { id: 'watchlist', label: 'Watchlist' },
    { id: 'watched', label: 'Watched' },
    { id: 'releases', label: 'Release tracking' },
    { id: 'skip', label: "Don't import" },
  ]

  const STATUSES: MalStatusId[] = ['watching', 'completed', 'onHold', 'dropped', 'planToWatch']

  let targets = $state<Record<MalStatusId, MalTarget>>({
    watching: 'watchlist',
    completed: 'watched',
    onHold: 'watchlist',
    dropped: 'watched',
    planToWatch: 'releases',
  })
  let applyScores = $state(true)

  /**
   * Which titles are ticked, by MAL id.
   *
   * A positive set rather than an exclusion list, because the group toggles
   * need to state "all of these" without knowing what was excluded before. It
   * is converted to an exclusion list at the boundary, which is the shape the
   * importer wants.
   *
   * `SvelteSet` so mutating it re-renders; a plain Set in `$state` is tracked
   * by reassignment only, and `.add()` on one changes nothing on screen.
   */
  const included = new SvelteSet<number>()

  /** Which groups are expanded. All collapsed initially — 311 rows is a wall. */
  const open = new SvelteSet<MalStatusId>()

  /**
   * Seed the defaults from the file.
   *
   * In an effect rather than an initialiser so it re-runs if a different export
   * is previewed into the same dialog, and so the defaults come from main —
   * which owns the mapping — rather than being duplicated here where the two
   * copies could drift.
   */
  $effect(() => {
    targets = { ...preview.defaultTargets }
    included.clear()
    for (const entry of preview.entries) {
      if (preview.defaultSelected[entry.status]) included.add(entry.malId)
    }
  })

  let importing = $state(false)
  let progress = $state<{ done: number; total: number } | null>(null)
  let error = $state<string | null>(null)

  /**
   * Entries bucketed by status.
   *
   * A plain object rather than a Map: this is derived and replaced wholesale on
   * every change, so it never needs the reactive Map's mutation tracking, and
   * the lint rule that would push us to `SvelteMap` is right about Maps that
   * *are* mutated in place.
   */
  const grouped = $derived.by(() => {
    const buckets: Record<MalStatusId, MalPreviewEntry[]> = {
      watching: [],
      completed: [],
      onHold: [],
      dropped: [],
      planToWatch: [],
    }
    for (const entry of preview.entries) buckets[entry.status].push(entry)
    return buckets
  })

  function countIn(status: MalStatusId): number {
    return grouped[status].filter((e) => included.has(e.malId)).length
  }

  function toggleGroup(status: MalStatusId): void {
    const entries = grouped[status]
    const allIn = entries.every((e) => included.has(e.malId))
    for (const entry of entries) {
      if (allIn) included.delete(entry.malId)
      else included.add(entry.malId)
    }
  }

  function toggleEntry(malId: number): void {
    if (!included.delete(malId)) included.add(malId)
  }

  function toggleOpen(status: MalStatusId): void {
    if (!open.delete(status)) open.add(status)
  }

  /** Titles that will actually be written, after both group and per-title choices. */
  const totalSelected = $derived(
    preview.entries.filter((e) => included.has(e.malId) && targets[e.status] !== 'skip').length,
  )

  $effect(() => {
    const off = window.wta.on.malProgress((p) => (progress = p))
    return off
  })

  async function run(): Promise<void> {
    importing = true
    error = null
    try {
      const summary = await window.wta.mal.commit({
        targets: $state.snapshot(targets),
        excludedMalIds: preview.entries
          .filter((e) => !included.has(e.malId))
          .map((e) => e.malId),
        applyScores,
      })
      await library.reload()
      done = summary
    } catch (err) {
      error = err instanceof Error ? err.message : 'The import failed'
    } finally {
      importing = false
      progress = null
    }
  }

  let done = $state<Awaited<ReturnType<typeof window.wta.mal.commit>> | null>(null)
</script>

<div class="scrim" in:scrimIn out:scrimOut>
  <button class="dismiss" onclick={onclose} aria-label="Close"></button>

  <div class="panel" in:modalIn out:modalOut role="dialog" aria-modal="true" aria-label="Import from MyAnimeList">
    {#if done}
      <header>
        <h2>Imported</h2>
      </header>
      <div class="body">
        <ul class="summary">
          <li><strong>{done.watched}</strong> added to Watched</li>
          <li><strong>{done.watchlist}</strong> added to your Watchlist</li>
          <li><strong>{done.releases}</strong> now tracked for new episodes</li>
          <li><strong>{done.ratings}</strong> rated from your MAL scores</li>
          {#if done.refined > 0}
            <li><strong>{done.refined}</strong> 👍/👎 sharpened to your exact MAL score</li>
          {/if}
        </ul>

        {#if done.unmatched.length > 0}
          <!--
            Named, not counted. "12 titles could not be matched" is not
            actionable; the list is, because the usual cause is a romanisation
            TMDB files under a different name and the user can add those by hand.
          -->
          <details class="unmatched">
            <summary>{done.unmatched.length} could not be matched on TMDB</summary>
            <p class="hint">
              Usually an alternate romanisation. Anything routed to Watched was still kept, with
              just its title; the rest were skipped.
            </p>
            <ul>
              {#each done.unmatched as title (title)}<li>{title}</li>{/each}
            </ul>
          </details>
        {/if}
      </div>
      <footer>
        <button class="primary" onclick={onclose}>Done</button>
      </footer>
    {:else}
      <header>
        <h2>Import from MyAnimeList</h2>
        <p class="lede">
          {preview.entries.length} titles{preview.userName ? ` from ${preview.userName}` : ''}.
          Choose where each group goes, then untick anything you would rather leave out.
          {#if preview.skipped > 0}
            <span class="warn">{preview.skipped} entries in the file could not be read.</span>
          {/if}
        </p>
      </header>

      <div class="body">
        {#each STATUSES as status (status)}
          {@const entries = grouped[status]}
          {#if entries.length > 0}
            {@const selected = countIn(status)}
            <section class="group" class:off={targets[status] === 'skip'}>
              <div class="group-head">
                <input
                  type="checkbox"
                  checked={selected === entries.length}
                  indeterminate={selected > 0 && selected < entries.length}
                  onchange={() => toggleGroup(status)}
                  aria-label="Select all {preview.labels[status]}"
                />

                <button class="group-name" onclick={() => toggleOpen(status)}>
                  <span class="caret" class:open={open.has(status)}>▸</span>
                  {preview.labels[status]}
                  <span class="tally">{selected} of {entries.length}</span>
                </button>

                <label class="target">
                  <span>goes to</span>
                  <select bind:value={targets[status]}>
                    {#each TARGETS as t (t.id)}
                      <option value={t.id}>{t.label}</option>
                    {/each}
                  </select>
                </label>
              </div>

              {#if open.has(status)}
                <ul class="titles">
                  {#each entries as entry (entry.malId)}
                    <li>
                      <label>
                        <input
                          type="checkbox"
                          checked={included.has(entry.malId)}
                          onchange={() => toggleEntry(entry.malId)}
                        />
                        <span class="t">{entry.title}</span>
                        {#if entry.score > 0}<span class="score">{entry.score}/10</span>{/if}
                        {#if entry.totalEpisodes > 0}
                          <span class="eps">{entry.watchedEpisodes}/{entry.totalEpisodes}</span>
                        {/if}
                      </label>
                    </li>
                  {/each}
                </ul>
              {/if}
            </section>
          {/if}
        {/each}

        <label class="scores">
          <input type="checkbox" bind:checked={applyScores} />
          <span>
            Use my MAL scores as ratings
            <em>Each score carries over as it is, 1 to 10. A 👍 or 👎 from before ratings had a
              scale is replaced by the exact score when the two agree; anything you have rated
              on the 1–10 scale is never overwritten.</em
            >
          </span>
        </label>
      </div>

      <footer>
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        {#if importing}
          <p class="progress" role="status">
            {progress ? `Matching ${progress.done} of ${progress.total} on TMDB…` : 'Starting…'}
          </p>
        {/if}
        <button class="ghost" onclick={onclose} disabled={importing}>Cancel</button>
        <button class="primary" onclick={run} disabled={importing || totalSelected === 0}>
          Import {totalSelected}
        </button>
      </footer>
    {/if}
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: grid;
    place-items: center;
    background: rgb(var(--bg-base-rgb) / 0.72);
    padding: var(--space-6);
  }

  .dismiss {
    position: absolute;
    inset: 0;
    cursor: default;
  }

  .panel {
    position: relative;
    display: flex;
    flex-direction: column;
    width: min(720px, 100%);
    max-height: min(80vh, 760px);
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-subtle);
    background: var(--bg-raised);
    overflow: hidden;
  }

  header {
    padding: var(--space-5) var(--space-5) var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
  }

  h2 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-lg);
  }

  .lede {
    margin: 0;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .warn {
    color: var(--warning);
  }

  .body {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: var(--space-4) var(--space-5);
  }

  .group {
    border-bottom: 1px solid var(--border-subtle);
    padding: var(--space-3) 0;
  }

  /* A group routed to "don't import" is dimmed rather than hidden, so the
     choice stays visible and reversible. */
  .group.off {
    opacity: 0.45;
  }

  .group-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .group-name {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 1 1 auto;
    padding: var(--space-1) 0;
    font-size: var(--text-sm);
    font-weight: 600;
    text-align: left;
  }

  .caret {
    display: inline-block;
    color: var(--text-tertiary);
    transition: transform var(--dur-fast) var(--ease-out);
  }

  .caret.open {
    transform: rotate(90deg);
  }

  .tally {
    color: var(--text-tertiary);
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }

  .target {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-tertiary);
    font-size: var(--text-xs);
  }

  select {
    padding: 4px var(--space-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
    background: var(--bg-elevated);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-xs);
  }

  .titles {
    max-height: 240px;
    overflow-y: auto;
    margin: var(--space-2) 0 0;
    padding: 0 0 0 var(--space-6);
    list-style: none;
  }

  .titles label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 3px 0;
    font-size: var(--text-sm);
  }

  .t {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .score,
  .eps {
    flex: 0 0 auto;
    color: var(--text-tertiary);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .scores {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    margin-top: var(--space-5);
    font-size: var(--text-sm);
  }

  .scores em {
    display: block;
    margin-top: 2px;
    color: var(--text-tertiary);
    font-size: var(--text-xs);
    font-style: normal;
    line-height: 1.5;
  }

  footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    border-top: 1px solid var(--border-subtle);
  }

  .progress,
  .error {
    margin: 0 auto 0 0;
    font-size: var(--text-sm);
    color: var(--text-tertiary);
  }

  .error {
    color: var(--danger);
  }

  .primary {
    padding: var(--space-2) var(--space-5);
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--text-on-media);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .primary:disabled {
    opacity: 0.5;
  }

  .ghost {
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }

  .summary {
    margin: 0;
    padding-left: var(--space-5);
    line-height: 1.9;
    font-size: var(--text-sm);
  }

  .unmatched {
    margin-top: var(--space-4);
    font-size: var(--text-sm);
  }

  .unmatched summary {
    cursor: pointer;
    color: var(--text-secondary);
  }

  .unmatched ul {
    max-height: 200px;
    overflow-y: auto;
    margin: var(--space-2) 0 0;
    padding-left: var(--space-5);
    color: var(--text-tertiary);
    font-size: var(--text-xs);
    line-height: 1.7;
  }

  .hint {
    margin: var(--space-2) 0 0;
    color: var(--text-tertiary);
    font-size: var(--text-xs);
    line-height: 1.5;
  }
</style>
