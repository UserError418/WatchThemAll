<script lang="ts">
  /**
   * The Releases surface — the tracked series and when their next episode lands.
   *
   * The countdown ticks live. It is one interval for the whole list rather than
   * one per row: the original kept a Map of timers keyed by element id and
   * leaked them whenever a row was re-rendered without being explicitly
   * stopped.
   *
   * Ordering is by urgency — anything airing soonest first, then series with no
   * scheduled episode, then ended ones. What the user opens this tab to find is
   * "what is next", so that has to be at the top.
   */
  import type { MediaSummary, ReleaseTracker } from '@shared/types'
  import { library } from '../lib/library.svelte'
  import { posterUrl } from '../lib/images'
  import { airDate, countdown, episodeCode, timeAgo } from '../lib/format'

  interface Props {
    onselect: (media: MediaSummary) => void
  }

  const { onselect }: Props = $props()

  /** Drives the countdown text. Updating this re-derives every visible timer. */
  let now = $state(Date.now())
  let checking = $state(false)
  let checkResult = $state<string | null>(null)

  async function checkNow(): Promise<void> {
    if (checking) return
    checking = true
    checkResult = null
    try {
      const { checked, found } = await window.wta.releases.checkNow()
      await library.reload()
      now = Date.now()
      checkResult =
        found > 0
          ? `${found} of ${checked} have new episodes`
          : `Checked ${checked} — nothing new`
    } catch (err) {
      checkResult = err instanceof Error ? err.message : 'Check failed'
    } finally {
      checking = false
    }
  }

  $effect(() => {
    const interval = setInterval(() => (now = Date.now()), 60_000)
    return () => clearInterval(interval)
  })

  function airTime(tracker: ReleaseTracker): number {
    const date = tracker.nextEpisode?.airDate
    if (!date) return Number.POSITIVE_INFINITY
    const parsed = new Date(`${date}T00:00:00`).getTime()
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed
  }

  const ordered = $derived(
    [...library.trackers].sort((a, b) => {
      const ended = (t: ReleaseTracker): number =>
        t.status === 'Ended' || t.status === 'Canceled' ? 1 : 0
      if (ended(a) !== ended(b)) return ended(a) - ended(b)
      const diff = airTime(a) - airTime(b)
      return diff !== 0 ? diff : a.title.localeCompare(b.title)
    }),
  )

  function asMedia(tracker: ReleaseTracker): MediaSummary {
    return {
      tmdbId: tracker.tmdbId,
      type: 'tv',
      title: tracker.title,
      posterPath: tracker.posterPath,
      backdropPath: null,
      overview: '',
      rating: 0,
      releaseDate: null,
      genreIds: [],
    }
  }

  /** What to show when there is no scheduled next episode. */
  function statusLine(tracker: ReleaseTracker): string {
    if (tracker.status === 'Ended') return 'Series ended'
    if (tracker.status === 'Canceled') return 'Cancelled'
    if (tracker.status === 'Returning Series') return 'Waiting on a schedule'
    return tracker.status || 'Listening for new episodes'
  }
</script>

<div class="view">
  <header class="head">
    <div>
      <h2>Releases</h2>
      <p class="lede">
        Series you are tracking. New episodes raise a desktop notification when they air.
      </p>
    </div>
    <div class="tools">
      <label class="toggle">
        <input
          type="checkbox"
          checked={library.settings.notificationsEnabled}
          onchange={(e) => library.setNotificationsEnabled(e.currentTarget.checked)}
        />
        Notifications
      </label>
      <button class="check" onclick={checkNow} disabled={checking || ordered.length === 0}>
        {checking ? 'Checking…' : '↻ Check now'}
      </button>
      {#if checkResult}
        <span class="check-result" role="status">{checkResult}</span>
      {/if}
    </div>
  </header>

  {#if ordered.length === 0}
    <p class="state">
      Nothing tracked yet. Open any series and choose <strong>Track Releases</strong> to be told when
      its next episode airs.
    </p>
  {:else}
    <ul class="list">
      {#each ordered as tracker (tracker.id)}
        {@const poster = posterUrl(tracker.posterPath, 'w185')}
        {@const next = tracker.nextEpisode}
        {@const remaining = next?.airDate ? countdown(next.airDate, now) : ''}
        <li class:ended={tracker.status === 'Ended' || tracker.status === 'Canceled'}>
          <button class="row" onclick={() => onselect(asMedia(tracker))}>
            <div class="art">
              {#if poster}
                <img src={poster} alt="" loading="lazy" decoding="async" width="64" height="96" />
              {:else}
                <div class="art-empty" aria-hidden="true">{tracker.title.slice(0, 1)}</div>
              {/if}
            </div>

            <div class="info">
              <span class="title">{tracker.title}</span>
              {#if next}
                <span class="next">
                  {episodeCode(next.season, next.episode)}
                  {next.name ? `· ${next.name}` : ''}
                </span>
                <span class="date">{airDate(next.airDate)}</span>
              {:else}
                <span class="next muted">{statusLine(tracker)}</span>
              {/if}
              {#if tracker.lastChecked > 0}
                <span class="checked">Checked {timeAgo(tracker.lastChecked, now)}</span>
              {:else}
                <span class="checked">Not checked yet</span>
              {/if}
            </div>

            {#if remaining}
              <div class="countdown" class:imminent={remaining === 'Airing now'}>
                <span class="value">{remaining}</span>
                <span class="label">{remaining === 'Airing now' ? '' : 'to air'}</span>
              </div>
            {/if}
          </button>

          <button
            class="remove"
            onclick={() => library.removeTracker(tracker.tmdbId)}
            aria-label="Stop tracking {tracker.title}"
            title="Stop tracking">✕</button
          >
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .view {
    padding: var(--space-5) var(--space-6) var(--space-8);
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    margin-bottom: var(--space-5);
    flex-wrap: wrap;
  }

  h2 {
    margin: 0 0 var(--space-1);
    font-size: var(--text-lg);
  }

  .lede {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-tertiary);
    max-width: 60ch;
  }

  .check {
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-size: var(--text-sm);
  }
  .check:hover:not(:disabled) {
    background: var(--bg-hover);
  }
  .check:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .check-result {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    cursor: pointer;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  li {
    position: relative;
  }

  li.ended {
    opacity: 0.6;
  }

  .row {
    display: grid;
    grid-template-columns: 64px 1fr auto;
    align-items: center;
    gap: var(--space-4);
    width: 100%;
    padding: var(--space-3);
    padding-right: var(--space-7);
    text-align: left;
    border-radius: var(--radius-md);
    background: var(--bg-raised);
    transition: background var(--dur-fast) var(--ease-out);
  }

  .row:hover {
    background: var(--bg-elevated);
  }

  .art {
    width: 64px;
    aspect-ratio: var(--poster-ratio);
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--bg-elevated);
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
    color: var(--text-disabled);
  }

  .info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .title {
    font-size: var(--text-md);
    font-weight: 600;
  }

  .next {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .next.muted {
    color: var(--text-tertiary);
  }

  .date,
  .checked {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }

  .countdown {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    white-space: nowrap;
  }

  .countdown .value {
    font-size: var(--text-lg);
    font-weight: 700;
    color: var(--success);
    font-variant-numeric: tabular-nums;
  }

  .countdown.imminent .value {
    color: var(--warning);
  }

  .countdown .label {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }

  .remove {
    position: absolute;
    top: var(--space-3);
    right: var(--space-3);
    width: 24px;
    height: 24px;
    border-radius: var(--radius-full);
    color: var(--text-tertiary);
    font-size: var(--text-xs);
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease-out);
  }

  li:hover .remove,
  .remove:focus-visible {
    opacity: 1;
  }

  .remove:hover {
    color: var(--danger);
    background: var(--bg-hover);
  }

  .state {
    color: var(--text-tertiary);
    font-size: var(--text-sm);
    max-width: 60ch;
  }
</style>
