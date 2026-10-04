<script lang="ts">
  /**
   * Download one episode or film, and say how it is going: the detail view's
   * button (the film, or the episode Resume would play) and, `compact`, each
   * episode row's. One control for every state, so pressing it always does
   * the obvious next thing: download, pause, resume. Deleting lives on the
   * Downloads page, where the size it frees is shown.
   *
   * Renders nothing where the platform has no downloads (`downloads.available`).
   */
  import type { DownloadRequest } from '@shared/ipc'
  import { downloads } from '../lib/downloads.svelte'
  import { isUnderWay, percentOf, stateLine } from '../lib/downloads'

  interface Props {
    request: DownloadRequest
    compact?: boolean
  }

  const { request, compact = false }: Props = $props()

  const download = $derived(downloads.of(request))
  const state = $derived(download?.state ?? null)
  const percent = $derived(download ? percentOf(download) : 0)

  const label = $derived.by(() => {
    if (download === null) return '↓ Download'
    if (state === 'done') return '✓ Downloaded'
    if (state === 'paused') return `▶ Resume download · ${percent}%`
    if (state === 'failed') return '↻ Retry download'
    if (state === 'downloading') return `Downloading ${percent}%`
    return state === 'capturing' ? 'Preparing…' : 'Waiting…'
  })

  /** What pressing it does, and what it is doing, for the tooltip and screen readers. */
  const title = $derived.by(() => {
    if (download === null) return 'Download to watch without a connection'
    if (state === 'done') return 'Downloaded: plays from this device, offline'
    if (isUnderWay(download)) return `${stateLine(download)} (press to pause)`
    return stateLine(download) + (state === 'failed' ? ' (press to try again)' : ' (press to resume)')
  })

  function press(event: MouseEvent): void {
    // Inside an episode row, whose other parts play the episode.
    event.stopPropagation()
    if (download === null) void downloads.download(request)
    else if (isUnderWay(download)) downloads.pause(download.id)
    else if (state === 'paused' || state === 'failed') downloads.resume(download.id)
  }
</script>

{#if downloads.available}
  {#if compact}
    <button
      class="compact"
      class:done={state === 'done'}
      class:busy={download !== null && isUnderWay(download)}
      class:failed={state === 'failed'}
      onclick={press}
      disabled={state === 'done'}
      {title}
      aria-label={title}
    >
      {#if download === null}
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" /></svg>
      {:else if state === 'done'}
        ✓
      {:else if state === 'failed'}
        !
      {:else if state === 'paused'}
        ❚❚
      {:else}
        <span class="ring" style:--p={percent}></span><span class="pct">{state === 'downloading' ? percent : '…'}</span>
      {/if}
    </button>
  {:else}
    <button
      class="secondary full"
      class:done={state === 'done'}
      class:failed={state === 'failed'}
      onclick={press}
      disabled={state === 'done'}
      {title}
    >
      {#if download !== null && state === 'downloading'}
        <span class="fill" style:width="{percent}%" aria-hidden="true"></span>
      {/if}
      <span class="text">{label}</span>
    </button>
  {/if}
{/if}

<style>
  /* Sized and coloured like the detail view's other secondary buttons. */
  .full {
    position: relative;
    overflow: hidden;
    padding: var(--space-3) var(--space-5);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-full);
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-weight: var(--weight-emphasis);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .full:hover:not(:disabled) {
    background: var(--bg-hover);
  }

  .full.done {
    border-color: color-mix(in srgb, var(--success) 60%, transparent);
    color: var(--success);
    cursor: default;
  }

  .full.failed {
    border-color: color-mix(in srgb, var(--danger) 60%, transparent);
  }

  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: color-mix(in srgb, var(--accent) 28%, transparent);
    transition: width var(--dur-mid) var(--ease-out);
  }

  .text {
    position: relative;
  }

  .compact {
    position: relative;
    display: grid;
    place-items: center;
    flex: none;
    width: 32px;
    height: 32px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .compact:hover:not(:disabled) {
    color: var(--text-primary);
    border-color: var(--border-strong);
  }

  .compact svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .compact.done {
    color: var(--success);
    border-color: color-mix(in srgb, var(--success) 50%, transparent);
    cursor: default;
  }

  .compact.failed {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 50%, transparent);
  }

  /* Progress as a ring around the number: the row has no room for a bar. */
  .ring {
    position: absolute;
    inset: -1px;
    border-radius: var(--radius-full);
    background: conic-gradient(var(--accent) calc(var(--p) * 1%), transparent 0);
    mask: radial-gradient(circle, transparent 13px, #000 14px);
  }

  .compact.busy {
    color: var(--text-primary);
  }

  .pct {
    position: relative;
  }
</style>
