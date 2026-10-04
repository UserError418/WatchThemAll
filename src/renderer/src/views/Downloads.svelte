<script lang="ts">
  /**
   * The Downloads tab (the owner, 2026-10-04): what is on this device and
   * how it is going. An overview of the whole device, the download under way
   * with its speed and time left, then one card per film and one per series,
   * the series' seasons folding out with their episodes, each with its own
   * totals. A season or a whole series can be deleted at once, after a
   * confirmation, since that is gigabytes.
   *
   * Works with no network: everything shown is in the downloads' own records
   * and folders (the poster is a file beside the segments). Only "8 of 10
   * episodes" needs TMDB's season, and reads "8 episodes" without it.
   */
  import PageHeader from '../components/PageHeader.svelte'
  import { downloads } from '../lib/downloads.svelte'
  import { downloadTitle, formatBytes, isUnderWay, percentOf, qualityLabel, stateLine } from '../lib/downloads'
  import {
    groupDownloads,
    heightsLabel,
    overviewOf,
    runtimeLabel,
    seasonCountLabel,
    type DownloadGroup,
    type DownloadTotals,
  } from '../lib/downloadgroups'
  import { SpeedMeter, speedLabel, timeLeftLabel, type SpeedReading } from '../lib/downloadspeed'
  import { clock, episodeCode } from '../lib/format'
  import { toast } from '../lib/toast.svelte'
  import type { DownloadView } from '@shared/ipc'

  const list = $derived(downloads.list)
  const status = $derived(downloads.status)
  const groups = $derived(groupDownloads(list))
  const overview = $derived(overviewOf(groups))

  /** The one being fetched now: at most one runs at a time. */
  const running = $derived(list.find((d) => d.state === 'capturing' || d.state === 'downloading') ?? null)

  // ── Speed and time left ──────────────────────────────────────────────
  const meter = new SpeedMeter()
  let speed = $state<SpeedReading | null>(null)
  $effect(() => {
    const d = running
    if (d === null || d.state !== 'downloading') {
      meter.reset()
      speed = null
      return
    }
    meter.observe(d.id, d.bytesDone, d.segmentsDone, Date.now())
    speed = meter.reading({
      bytes: d.estimatedBytes === null ? null : Math.max(0, d.estimatedBytes - d.bytesDone),
      segments: Math.max(0, d.segmentsTotal - d.segmentsDone),
    })
  })

  // ── Folding and confirming ───────────────────────────────────────────
  /** Series unfolded, by group key; kept while the tab is open. */
  let open = $state<Record<string, boolean>>({})
  /** The season or series whose Delete is waiting for its confirmation. */
  let confirming = $state<string | null>(null)

  // ── Season lengths, for "8 of 10 episodes" ───────────────────────────
  let seasonLengths = $state<Record<string, number>>({})
  // Deliberately not reactive: it only stops the effect asking TMDB twice for one season.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const asked = new Set<string>()
  $effect(() => {
    for (const group of groups) {
      if (group.kind !== 'series') continue
      for (const season of group.seasons) {
        const key = `${group.tmdbId}:${season.season}`
        if (asked.has(key)) continue
        asked.add(key)
        void window.wta.tmdb
          .season(group.tmdbId, season.season)
          .then((found) => {
            if (found) seasonLengths = { ...seasonLengths, [key]: found.episodes.length }
          })
          .catch(() => asked.delete(key))
      }
    }
  })

  // ── Words ─────────────────────────────────────────────────────────────
  const storageShare = $derived.by(() => {
    if (status === null || status.freeBytes === null) return null
    const total = status.usedBytes + status.freeBytes
    return total > 0 ? Math.max(0.5, (status.usedBytes / total) * 100) : null
  })

  /** The size line: what is on disk, and of what, while it is still coming. */
  function size(download: DownloadView): string {
    if (download.state === 'done') return formatBytes(download.bytesDone)
    if (download.estimatedBytes !== null) return `${formatBytes(download.bytesDone)} of ~${formatBytes(download.estimatedBytes)}`
    return download.bytesDone > 0 ? formatBytes(download.bytesDone) : ''
  }

  function facts(download: DownloadView): string[] {
    return [
      size(download),
      qualityLabel(download.height),
      download.durationSeconds !== null ? clock(download.durationSeconds) : null,
      download.source?.name ?? null,
      new Date(download.finishedAt ?? download.createdAt).toLocaleDateString(),
    ].filter((fact): fact is string => fact !== null && fact !== '')
  }

  /** A group's or season's totals, as a line: size, length, quality, sources. */
  function totalsLine(totals: DownloadTotals): string {
    return [formatBytes(totals.bytes), runtimeLabel(totals.seconds), heightsLabel(totals.heights), totals.sources.slice(0, 2).join(', ') || null]
      .filter((fact): fact is string => fact !== null && fact !== '')
      .join(' · ')
  }

  /** What is still going on in a group, in a few words; empty when everything is downloaded. */
  function pending(totals: DownloadTotals): string[] {
    return [
      totals.underWay > 0 ? `${totals.underWay} downloading or waiting` : null,
      totals.paused > 0 ? `${totals.paused} paused` : null,
      totals.failed > 0 ? `${totals.failed} failed` : null,
    ].filter((line): line is string => line !== null)
  }

  /** How far a set of downloads is, by segments: for a series or season bar. */
  function percentOfAll(all: readonly DownloadView[]): number {
    return all.length === 0 ? 0 : Math.round(all.reduce((sum, d) => sum + percentOf(d), 0) / all.length)
  }

  function seriesEpisodes(group: Extract<DownloadGroup, { kind: 'series' }>): DownloadView[] {
    return group.seasons.flatMap((s) => s.episodes)
  }

  // ── Actions ───────────────────────────────────────────────────────────
  async function play(download: DownloadView): Promise<void> {
    const s = download.subject
    const result = await window.wta.play({
      tmdbId: s.tmdbId,
      imdbId: s.imdbId,
      type: s.type,
      title: s.title,
      season: s.season,
      episode: s.episode,
      providerId: null,
      runtimeMinutes: s.runtimeMinutes,
    })
    if (!result.ok) toast.show(result.error ?? `Could not play ${s.title}`)
  }

  /** Delete at once, but say what went: the files are gone, so there is no Undo to offer. */
  function remove(download: DownloadView): void {
    const { title, episode } = downloadTitle(download)
    downloads.remove(download.id)
    toast.show(`Deleted ${episode ? `${title} ${episode.split(' · ')[0]}` : title}${download.bytesDone > 0 ? `, freeing ${formatBytes(download.bytesDone)}` : ''}`)
  }

  /** Delete several (a season, a series), after the confirmation the button asked for. */
  function removeAll(all: readonly DownloadView[], what: string): void {
    const bytes = all.reduce((sum, d) => sum + d.bytesDone, 0)
    for (const d of all) downloads.remove(d.id)
    confirming = null
    toast.show(`Deleted ${what}${bytes > 0 ? `, freeing ${formatBytes(bytes)}` : ''}`)
  }

  function episodeLabel(download: DownloadView): string {
    const s = download.subject
    const code = s.season !== null && s.episode !== null ? episodeCode(s.season, s.episode) : ''
    return s.episodeName ? `${code} · ${s.episodeName}` : code
  }
</script>

{#snippet bar(percent: number, paused: boolean, label: string)}
  <div class="dl-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
    <div class="dl-fill" class:paused style:width="{percent}%"></div>
  </div>
{/snippet}

{#snippet controls(download: DownloadView, small: boolean)}
  <div class="dl-actions" class:small>
    {#if small && download.state === 'done'}
      <!-- An episode row: round icons, so the row stays one line on a phone. -->
      <button class="dl-icon primary" onclick={() => play(download)} aria-label="Play" title="Play">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path class="solid" d="M8 5.5v13l10.5-6.5z" /></svg>
      </button>
    {:else if download.state === 'done'}
      <button class="primary" onclick={() => play(download)}>▶ Play</button>
    {:else if isUnderWay(download)}
      <button onclick={() => downloads.pause(download.id)}>Pause</button>
    {:else}
      <button onclick={() => downloads.resume(download.id)}>{download.state === 'failed' ? 'Try again' : 'Resume'}</button>
    {/if}
    {#if small}
      <button class="dl-icon delete" onclick={() => remove(download)} aria-label="Delete" title="Delete the download and its files">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10.5 10.5v5.5M13.5 10.5v5.5" /></svg>
      </button>
    {:else}
      <button class="delete" onclick={() => remove(download)} title="Delete the download and its files">Delete</button>
    {/if}
  </div>
{/snippet}

{#snippet confirmDelete(key: string, all: readonly DownloadView[], what: string, label: string)}
  {#if confirming === key}
    <div class="dl-confirm" role="group" aria-label="Confirm delete">
      <span>Delete {all.length} {all.length === 1 ? 'download' : 'downloads'}, {formatBytes(all.reduce((sum, d) => sum + d.bytesDone, 0))}?</span>
      <button class="danger" onclick={() => removeAll(all, what)}>Delete</button>
      <button onclick={() => (confirming = null)}>Keep</button>
    </div>
  {:else}
    <button class="dl-link delete" onclick={() => (confirming = key)}>{label}</button>
  {/if}
{/snippet}

<div class="view">
  <PageHeader title="Downloads" count={list.length || null} />

  {#if list.length === 0}
    <p class="empty">
      Nothing downloaded yet. Open a film or a series and press <strong>Download</strong>: it plays here without a
      connection, in the same player.
    </p>
  {:else}
    <section class="dl-overview" aria-label="On this device">
      <div class="dl-stats">
        <div class="dl-stat">
          <span class="value">{formatBytes(status?.usedBytes ?? 0)}</span>
          <span class="label">stored</span>
        </div>
        {#if status?.freeBytes != null}
          <div class="dl-stat">
            <span class="value">{formatBytes(status.freeBytes)}</span>
            <span class="label">free</span>
          </div>
        {/if}
        <div class="dl-stat">
          <span class="value">{runtimeLabel(overview.seconds) ?? '0 min'}</span>
          <span class="label">of video</span>
        </div>
        <div class="dl-stat">
          <span class="value">{overview.films}</span>
          <span class="label">{overview.films === 1 ? 'film' : 'films'}</span>
        </div>
        <div class="dl-stat">
          <span class="value">{overview.series}</span>
          <span class="label">series · {overview.episodes} {overview.episodes === 1 ? 'episode' : 'episodes'}</span>
        </div>
        {#if overview.waiting > 0}
          <div class="dl-stat">
            <span class="value">{overview.waiting}</span>
            <span class="label">waiting</span>
          </div>
        {/if}
        {#if overview.failed > 0}
          <div class="dl-stat failed">
            <span class="value">{overview.failed}</span>
            <span class="label">failed</span>
          </div>
        {/if}
      </div>
      {#if storageShare !== null}
        <div class="dl-storage" title="Downloads' share of this device's free and used space">
          <div class="dl-storage-fill" style:width="{storageShare}%"></div>
        </div>
      {/if}
    </section>

    {#if running}
      {@const names = downloadTitle(running)}
      <section class="dl-now" aria-label="Downloading now">
        <p class="eyebrow">Downloading now</p>
        <h2>{names.title}{#if names.episode}<span class="sub"> · {names.episode}</span>{/if}</h2>
        {@render bar(percentOf(running), false, 'Download progress')}
        <p class="dl-now-facts">
          <span>{stateLine(running)}</span>
          {#if speed}<span>{speedLabel(speed.bytesPerSecond)}</span>{/if}
          {#if speed?.secondsLeft != null}<span>{timeLeftLabel(speed.secondsLeft)}</span>{/if}
          {#if running.segmentsTotal > 0}<span>{running.segmentsDone} of {running.segmentsTotal} segments</span>{/if}
          {#if size(running)}<span>{size(running)}</span>{/if}
          {#if qualityLabel(running.height)}<span>{qualityLabel(running.height)}</span>{/if}
        </p>
        <div class="dl-actions small">
          <button onclick={() => downloads.pause(running.id)}>Pause</button>
        </div>
      </section>
    {/if}

    <ul class="dl-groups">
      {#each groups as group (group.key)}
        {#if group.kind === 'film'}
          {@const d = group.download}
          <li class="dl-card" class:failed={d.state === 'failed'} class:done={d.state === 'done'}>
            <div class="dl-poster">
              {#if d.posterUrl}<img src={d.posterUrl} alt="" loading="lazy" />{:else}<span aria-hidden="true">{d.subject.title.slice(0, 1)}</span>{/if}
            </div>
            <div class="dl-body">
              <h2>{d.subject.title}</h2>
              <p class="dl-facts">Film · {facts(d).join(' · ')}</p>
              <p class="dl-state" class:busy={d.state !== 'failed' && d.state !== 'done'} class:error={d.state === 'failed'}>{stateLine(d)}</p>
              {#if isUnderWay(d) || d.state === 'paused'}{@render bar(percentOf(d), d.state === 'paused', 'Download progress')}{/if}
            </div>
            {@render controls(d, false)}
          </li>
        {:else}
          {@const all = seriesEpisodes(group)}
          {@const unfolded = open[group.key] ?? false}
          {@const busy = pending(group.totals)}
          <li class="dl-card dl-series" class:failed={group.totals.failed > 0 && group.totals.underWay === 0}>
            <div class="dl-poster">
              {#if group.posterUrl}<img src={group.posterUrl} alt="" loading="lazy" />{:else}<span aria-hidden="true">{group.title.slice(0, 1)}</span>{/if}
            </div>
            <div class="dl-body">
              <h2>{group.title}</h2>
              <p class="dl-facts">
                Series · {group.seasons.length} {group.seasons.length === 1 ? 'season' : 'seasons'} · {group.totals.done}
                {group.totals.done === 1 ? 'episode' : 'episodes'} downloaded
              </p>
              <p class="dl-facts">{totalsLine(group.totals)}</p>
              {#if busy.length > 0}
                {@const going = group.totals.underWay + group.totals.paused > 0}
                <p class="dl-state" class:busy={going} class:error={!going}>{busy.join(' · ')}</p>
                {#if going}{@render bar(percentOfAll(all), group.totals.underWay === 0, 'Series download progress')}{/if}
              {:else}
                <p class="dl-state">Downloaded</p>
              {/if}
            </div>
            <div class="dl-actions">
              <button
                class="dl-fold"
                aria-expanded={unfolded}
                onclick={() => (open = { ...open, [group.key]: !unfolded })}
              >
                {unfolded ? 'Hide episodes' : 'Show episodes'}
                <span class="chevron" class:up={unfolded} aria-hidden="true">⌄</span>
              </button>
              {@render confirmDelete(group.key, all, group.title, 'Delete series')}
            </div>

            {#if unfolded}
              <div class="dl-seasons">
                {#each group.seasons as season (season.season)}
                  {@const key = `${group.key}:s${season.season}`}
                  <section class="dl-season">
                    <header class="dl-season-head">
                      <div>
                        <h3>Season {season.season}</h3>
                        <p class="dl-facts">
                          {seasonCountLabel(season.totals.done, seasonLengths[`${group.tmdbId}:${season.season}`] ?? null)}
                          · {totalsLine(season.totals)}
                          {#if pending(season.totals).length > 0}· {pending(season.totals).join(' · ')}{/if}
                        </p>
                      </div>
                      {@render confirmDelete(key, season.episodes, `${group.title} season ${season.season}`, 'Delete season')}
                    </header>
                    <ul class="dl-episodes">
                      {#each season.episodes as d (d.id)}
                        <li class="dl-ep" class:failed={d.state === 'failed'} class:done={d.state === 'done'}>
                          <div class="dl-body">
                            <p class="dl-ep-name">{episodeLabel(d)}</p>
                            <p class="dl-facts">{facts(d).slice(0, 4).join(' · ')}</p>
                            {#if d.state !== 'done'}
                              <p class="dl-state" class:busy={d.state !== 'failed'} class:error={d.state === 'failed'}>{stateLine(d)}</p>
                            {/if}
                            {#if isUnderWay(d) || d.state === 'paused'}{@render bar(percentOf(d), d.state === 'paused', 'Download progress')}{/if}
                          </div>
                          {@render controls(d, true)}
                        </li>
                      {/each}
                    </ul>
                  </section>
                {/each}
              </div>
            {/if}
          </li>
        {/if}
      {/each}
    </ul>
  {/if}
</div>

<style>
  .view {
    padding: var(--space-5) var(--space-6) var(--space-8);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .empty {
    margin: 0;
    max-width: 60ch;
    color: var(--text-secondary);
  }

  /* ── Overview ── */
  .dl-overview {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--bg-raised);
  }

  .dl-stats {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: var(--space-3) var(--space-4);
  }

  .dl-stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .dl-stat .value {
    font-family: var(--font-display);
    font-size: var(--text-lg);
    font-weight: var(--weight-bold);
    font-variant-numeric: tabular-nums;
    color: var(--text-primary);
  }

  .dl-stat .label {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }

  .dl-stat.failed .value {
    color: var(--danger);
  }

  .dl-storage {
    height: 6px;
    border-radius: var(--radius-full);
    background: var(--bg-elevated);
    overflow: hidden;
  }

  .dl-storage-fill {
    height: 100%;
    background: var(--accent);
  }

  /* ── Downloading now ── */
  .dl-now {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
    border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border-subtle));
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--accent) 7%, var(--bg-raised));
  }

  .eyebrow {
    margin: 0;
    font-size: var(--text-xs);
    font-weight: var(--weight-bold);
    letter-spacing: var(--tracking-caps);
    text-transform: uppercase;
    color: var(--accent);
  }

  .dl-now h2 {
    margin: 0;
    font-size: var(--text-md);
  }

  .sub {
    font-weight: normal;
    color: var(--text-secondary);
  }

  .dl-now-facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .dl-now .dl-bar {
    max-width: none;
    height: 6px;
  }

  /* ── Cards ── */
  .dl-groups {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .dl-card {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr) auto;
    gap: var(--space-4);
    align-items: center;
    padding: var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--bg-raised);
  }

  .dl-card.failed {
    border-color: color-mix(in srgb, var(--danger) 40%, var(--border-subtle));
  }

  .dl-poster {
    display: grid;
    place-items: center;
    width: 72px;
    aspect-ratio: 2 / 3;
    overflow: hidden;
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: var(--text-tertiary);
    font-size: var(--text-lg);
  }

  .dl-poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .dl-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .dl-card h2 {
    margin: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-emphasis);
  }

  .dl-facts,
  .dl-state {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
  }

  .dl-state {
    color: var(--success);
  }

  .dl-state.busy {
    color: var(--accent);
  }

  .dl-state.error {
    color: var(--danger);
  }

  .dl-bar {
    height: 4px;
    margin-top: var(--space-1);
    max-width: 420px;
    border-radius: var(--radius-full);
    background: var(--bg-elevated);
    overflow: hidden;
  }

  .dl-fill {
    height: 100%;
    background: var(--accent);
    transition: width var(--dur-mid) var(--ease-out);
  }

  .dl-fill.paused {
    background: var(--text-tertiary);
  }

  /* ── Actions ── */
  .dl-actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
  }

  .dl-actions button,
  .dl-confirm button,
  .dl-link {
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-full);
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-size: var(--text-sm);
    white-space: nowrap;
  }

  .dl-actions.small button {
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-xs);
  }

  .dl-actions.small .dl-icon {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    padding: 0;
  }

  .dl-icon svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .dl-icon svg .solid {
    fill: currentColor;
    stroke: none;
  }

  .dl-actions button:hover,
  .dl-confirm button:hover,
  .dl-link:hover {
    background: var(--bg-hover);
  }

  .dl-actions .primary {
    border-color: transparent;
    background: var(--accent);
    color: var(--text-on-accent, #fff);
  }

  .dl-actions .primary:hover {
    background: color-mix(in srgb, var(--accent) 85%, #fff);
  }

  .dl-actions .delete:hover,
  .dl-link.delete:hover {
    border-color: var(--danger);
    color: var(--danger);
  }

  .dl-fold {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .chevron {
    display: inline-block;
    line-height: 1;
    transform: translateY(-2px);
    transition: transform var(--dur-fast) var(--ease-out);
  }

  .chevron.up {
    transform: translateY(2px) rotate(180deg);
  }

  .dl-confirm {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .dl-confirm .danger {
    border-color: var(--danger);
    background: var(--danger);
    color: #fff;
  }

  /* ── A series' seasons and episodes ── */
  .dl-seasons {
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border-subtle);
  }

  .dl-season-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin-bottom: var(--space-2);
  }

  .dl-season-head h3 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-bold);
  }

  .dl-episodes {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .dl-ep {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--space-3);
    align-items: center;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
  }

  .dl-ep.failed {
    box-shadow: inset 3px 0 0 var(--danger);
  }

  .dl-ep-name {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dl-ep .dl-facts,
  .dl-ep .dl-state {
    font-size: var(--text-xs);
  }

  @media (max-width: 640px) {
    .view {
      padding: var(--space-4) var(--space-4) var(--space-8);
    }

    .dl-card {
      grid-template-columns: 56px minmax(0, 1fr);
      gap: var(--space-3);
    }

    .dl-poster {
      width: 56px;
    }

    .dl-card > .dl-actions {
      grid-column: 1 / -1;
      justify-content: flex-start;
    }

  }
</style>
