<script lang="ts">
  /**
   * The Downloads tab (the owner, 2026-10-04): every download on this device,
   * what it is, how big, at what quality, from which source, and how it is
   * going; play, pause, resume, delete; and the space they take.
   *
   * Works with no network: everything shown is in the downloads' own records
   * and folders (the poster is a file beside the segments), and Play opens
   * the player on the download, which is a page on the local server.
   */
  import PageHeader from '../components/PageHeader.svelte'
  import { downloads } from '../lib/downloads.svelte'
  import { downloadTitle, formatBytes, isUnderWay, percentOf, qualityLabel, stateLine } from '../lib/downloads'
  import { clock } from '../lib/format'
  import { toast } from '../lib/toast.svelte'
  import type { DownloadView } from '@shared/ipc'

  const list = $derived(downloads.list)
  const status = $derived(downloads.status)

  const lede = $derived.by(() => {
    if (status === null) return null
    const used = `${formatBytes(status.usedBytes)} used`
    return status.freeBytes === null ? used : `${used} · ${formatBytes(status.freeBytes)} free on this device`
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
</script>

<div class="view">
  <PageHeader title="Downloads" count={list.length || null} {lede} />

  {#if list.length === 0}
    <p class="state">
      Nothing downloaded yet. Open a film or a series and press <strong>Download</strong>: it plays here without a
      connection, in the same player.
    </p>
  {:else}
    <ul class="downloads">
      {#each list as download (download.id)}
        {@const names = downloadTitle(download)}
        <li class="download" class:failed={download.state === 'failed'} class:done={download.state === 'done'}>
          <div class="poster">
            {#if download.posterUrl}
              <img src={download.posterUrl} alt="" loading="lazy" />
            {:else}
              <span aria-hidden="true">{names.title.slice(0, 1)}</span>
            {/if}
          </div>

          <div class="body">
            <h2>{names.title}</h2>
            {#if names.episode}<p class="episode">{names.episode}</p>{/if}
            <p class="facts">{facts(download).join(' · ')}</p>
            <p class="state-line" class:error={download.state === 'failed'}>{stateLine(download)}</p>
            {#if isUnderWay(download) || download.state === 'paused'}
              <div
                class="bar"
                role="progressbar"
                aria-valuenow={percentOf(download)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Download progress"
              >
                <div class="fill" class:paused={download.state === 'paused'} style:width="{percentOf(download)}%"></div>
              </div>
            {/if}
          </div>

          <div class="actions">
            {#if download.state === 'done'}
              <button class="primary" onclick={() => play(download)}>▶ Play</button>
            {:else if isUnderWay(download)}
              <button onclick={() => downloads.pause(download.id)}>Pause</button>
            {:else}
              <button onclick={() => downloads.resume(download.id)}>{download.state === 'failed' ? 'Try again' : 'Resume'}</button>
            {/if}
            <button class="delete" onclick={() => remove(download)} title="Delete the download and its files">Delete</button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .view {
    padding: var(--space-5) var(--space-6) var(--space-8);
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  .state {
    margin: 0;
    max-width: 60ch;
    color: var(--text-secondary);
  }

  .downloads {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .download {
    display: grid;
    grid-template-columns: 72px 1fr auto;
    gap: var(--space-4);
    align-items: center;
    padding: var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--bg-raised);
  }

  .download.failed {
    border-color: color-mix(in srgb, var(--danger) 40%, var(--border-subtle));
  }

  .poster {
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

  .poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  h2 {
    margin: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-emphasis);
  }

  .episode,
  .facts,
  .state-line {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .facts {
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
  }

  .done .state-line {
    color: var(--success);
  }

  .state-line.error {
    color: var(--danger);
  }

  .bar {
    height: 4px;
    margin-top: var(--space-1);
    max-width: 420px;
    border-radius: var(--radius-full);
    background: var(--bg-elevated);
    overflow: hidden;
  }

  .fill {
    height: 100%;
    background: var(--accent);
    transition: width var(--dur-mid) var(--ease-out);
  }

  .fill.paused {
    background: var(--text-tertiary);
  }

  .actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .actions button {
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-full);
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-size: var(--text-sm);
  }

  .actions button:hover {
    background: var(--bg-hover);
  }

  .actions .primary {
    border-color: transparent;
    background: var(--accent);
    color: var(--text-on-accent, #fff);
  }

  .actions .delete:hover {
    border-color: var(--danger);
    color: var(--danger);
  }

  @media (max-width: 640px) {
    .download {
      grid-template-columns: 56px 1fr;
    }

    .poster {
      width: 56px;
    }

    .actions {
      grid-column: 1 / -1;
      justify-content: flex-start;
    }
  }
</style>
