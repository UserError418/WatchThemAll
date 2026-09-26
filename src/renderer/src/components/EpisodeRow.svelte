<script lang="ts">
  /**
   * One episode in the detail view's season list.
   *
   * Colour carries the state, as in the original — but with the meaning fixed
   * to something a user can actually infer: watched is filled, unaired is
   * dimmed and not clickable, everything else is available.
   */
  import type { Episode } from '@shared/types'
  import { airDate, countdown, countdownParts, episodeCode, hasAired, runtime } from '../lib/format'
  import { stillUrl } from '../lib/images'
  import Score from './Score.svelte'

  interface Props {
    episode: Episode
    watched: boolean
    /** The position the user is resuming from, highlighted distinctly. */
    current: boolean
    onplay: (episode: Episode) => void
    ontoggleWatched: (episode: Episode, watched: boolean) => void
    /**
     * True for the *single* soonest unaired episode in the list.
     *
     * Only that one gets a countdown. Putting a timer on every future episode
     * turns a season list into a wall of near-identical numbers, and the answer
     * anyone actually wants — "when is the next one" — gets harder to find, not
     * easier. Later episodes keep the plain "Airs <date>" line.
     */
    next?: boolean
    /**
     * How far into this episode the user got last time, or null if they have
     * not started it.
     *
     * Null rather than zero on purpose: a bar sitting at 0% under every episode
     * of a season nobody has opened is noise that makes the two or three real
     * ones harder to find.
     */
    progress?: { percent: number; minutesIn: number } | null
    /** Clock supplied by the parent, so one interval drives the whole list. */
    now?: number
  }

  const {
    episode,
    watched,
    current,
    onplay,
    ontoggleWatched,
    next = false,
    progress = null,
    now = Date.now(),
  }: Props = $props()

  const aired = $derived(hasAired(episode.airDate))
  const still = $derived(stillUrl(episode.stillPath))
  const remaining = $derived(next && !aired ? countdown(episode.airDate, now) : '')
  const parts = $derived(next && !aired ? countdownParts(episode.airDate, now) : null)
</script>

<!--
  `episode-row` is a marker for the phone's global sheet and is styled nowhere
  in this file. `mobile.css` needs to reach in here to re-proportion the row at
  412px, and the class it used to reach with was `.episode` — which is also the
  Releases timeline's row and the Watchlist card's caption. See the note beside
  those rules.
-->
<div
  class="episode episode-row"
  class:watched
  class:current
  class:unaired={!aired}
  class:next-up={remaining}
>
  <button
    class="thumb"
    onclick={() => aired && onplay(episode)}
    disabled={!aired}
    aria-label={aired ? `Play ${episodeCode(episode.season, episode.episode)}` : 'Not yet aired'}
  >
    {#if still}
      <img src={still} alt="" loading="lazy" decoding="async" width="150" height="84" />
    {:else if !parts}
      <!-- Not under the countdown: the number showed through it as a ghost "3". -->
      <div class="thumb-empty" aria-hidden="true">{episode.episode}</div>
    {/if}
    {#if aired}<span class="play" aria-hidden="true">▶</span>{/if}
    {#if progress && !watched}
      <span
        class="progress"
        title={`${progress.minutesIn} min in — ${progress.percent}%`}
        aria-label={`${progress.percent}% watched`}
      >
        <span class="progress-fill" style:width={`${progress.percent}%`}></span>
      </span>
    {/if}
    {#if parts}
      <span class="countdown" aria-label="Airs in {remaining}">
        <span class="cd-eyebrow" aria-hidden="true">Airs in</span>
        <span class="cd-parts" aria-hidden="true">
          {#each parts as part (part.unit)}
            <span class="cd-part">
              <span class="cd-value">{part.value}</span>
              <span class="cd-unit">{part.unit}</span>
            </span>
          {/each}
        </span>
      </span>
    {/if}
  </button>

  <div class="body">
    <div class="line">
      <span class="code">{episodeCode(episode.season, episode.episode)}</span>
      <span class="name">{episode.name || 'TBA'}</span>
      {#if episode.runtime}<span class="meta">{runtime(episode.runtime)}</span>{/if}
      <Score rating={episode.rating} />
    </div>
    {#if episode.overview}
      <p class="overview">{episode.overview}</p>
    {:else if !aired && episode.airDate}
      <p class="overview">Airs {airDate(episode.airDate)}</p>
    {/if}
  </div>

  <button
    class="check"
    class:on={watched}
    onclick={() => ontoggleWatched(episode, !watched)}
    aria-pressed={watched}
    aria-label={watched ? 'Mark as unwatched' : 'Mark as watched'}
    title={watched ? 'Mark as unwatched' : 'Mark as watched'}
  >
    ✓
  </button>
</div>

<style>
  .episode {
    display: grid;
    grid-template-columns: 150px 1fr auto;
    gap: var(--space-4);
    align-items: start;
    padding: var(--space-3);
    border-radius: var(--radius-md);
    transition: background var(--dur-fast) var(--ease-out);
  }

  .episode:hover {
    background: var(--bg-raised);
  }

  .episode.current {
    background: var(--accent-muted);
    box-shadow: inset 3px 0 0 var(--accent);
  }

  .episode.unaired {
    opacity: 0.55;
  }

  /* The next one is the episode people came to the list for; dimming it as
     hard as the rest of the unaired block hides the thing being highlighted. */
  .episode.next-up {
    opacity: 1;
  }

  .thumb {
    position: relative;
    width: 150px;
    aspect-ratio: 16 / 9;
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--bg-elevated);
    padding: 0;
  }

  .thumb:disabled {
    cursor: default;
  }

  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .thumb-empty {
    display: grid;
    place-items: center;
    height: 100%;
    color: var(--text-disabled);
    font-size: var(--text-lg);
    font-weight: 600;
  }

  .play {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.45);
    color: var(--text-on-media);
    font-size: 20px;
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease-out);
  }

  .thumb:hover .play,
  .thumb:focus-visible .play {
    opacity: 1;
  }

  /*
   * The countdown tile for the next episode.
   *
   * Opaque, and the placeholder number is not drawn under it: the tile used
   * to be a translucent wash over the episode number, which showed through as
   * a ghost digit behind "UNTIL AIR". Set as a clock — each figure large, its
   * unit small beneath — because a countdown is read at a glance, and "5d 7h"
   * in body type had to be read.
   */
  .countdown {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    background:
      radial-gradient(120% 90% at 0% 0%, rgb(232 176 75 / 0.3), transparent 60%),
      linear-gradient(160deg, var(--bg-elevated), var(--bg-base));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: inherit;
  }

  .cd-eyebrow {
    font-size: 9px;
    font-weight: var(--weight-bold);
    letter-spacing: var(--tracking-caps);
    text-transform: uppercase;
    color: var(--accent);
  }

  .cd-parts {
    display: flex;
    gap: var(--space-3);
  }

  .cd-part {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 26px;
  }

  .cd-value {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: var(--weight-bold);
    line-height: 1;
    font-variant-numeric: tabular-nums;
    color: var(--text-primary);
  }

  .cd-unit {
    margin-top: 2px;
    font-size: 9px;
    letter-spacing: var(--tracking-caps);
    text-transform: uppercase;
    color: var(--text-tertiary);
  }

  /**
   * The resume bar, along the bottom edge of the still.
   *
   * Inside the thumbnail rather than under it, so the row keeps its height and
   * the bar reads as belonging to the picture — the same place every streaming
   * app puts it, and the same amber the app uses for "in progress" elsewhere.
   *
   * Hidden once the episode is watched: the two would say contradictory things,
   * and "watched" is the more useful of the two answers.
   */
  .progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 3px;
    background: rgba(0, 0, 0, 0.55);
  }

  .progress-fill {
    display: block;
    height: 100%;
    background: var(--accent);
  }

  .line {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .code {
    font-size: var(--text-xs);
    font-weight: 700;
    color: var(--text-tertiary);
    letter-spacing: 0.4px;
  }

  .name {
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .watched .name {
    color: var(--text-secondary);
  }

  .meta {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }

  .overview {
    margin: var(--space-1) 0 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .check {
    width: 26px;
    height: 26px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border-strong);
    color: var(--text-tertiary);
    font-size: var(--text-xs);
    line-height: 1;
  }

  .check.on {
    background: var(--success);
    border-color: var(--success);
    color: var(--bg-base);
    font-weight: 700;
  }
</style>
