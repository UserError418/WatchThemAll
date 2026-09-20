<script lang="ts">
  /**
   * One episode in the detail view's season list.
   *
   * Colour carries the state, as in the original — but with the meaning fixed
   * to something a user can actually infer: watched is filled, unaired is
   * dimmed and not clickable, everything else is available.
   */
  import type { Episode } from '@shared/types'
  import { airDate, countdown, episodeCode, hasAired, runtime } from '../lib/format'
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
</script>

<div class="episode" class:watched class:current class:unaired={!aired} class:next-up={remaining}>
  <button
    class="thumb"
    onclick={() => aired && onplay(episode)}
    disabled={!aired}
    aria-label={aired ? `Play ${episodeCode(episode.season, episode.episode)}` : 'Not yet aired'}
  >
    {#if still}
      <img src={still} alt="" loading="lazy" decoding="async" width="150" height="84" />
    {:else}
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
    {#if remaining}
      <span class="countdown">
        <span class="value">{remaining}</span>
        <span class="label">until air</span>
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

  /* Covers the still — usually absent for an unaired episode, so this sits on
     the empty placeholder rather than obscuring artwork. */
  .countdown {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    gap: 2px;
    background: linear-gradient(160deg, var(--accent-muted), rgba(0, 0, 0, 0.72));
    text-align: center;
  }

  .countdown .value {
    font-size: var(--text-base);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--text-primary);
  }

  .countdown .label {
    font-size: 10px;
    letter-spacing: 0.08em;
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
