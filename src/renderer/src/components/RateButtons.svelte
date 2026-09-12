<script lang="ts">
  /**
   * Liked it / didn't.
   *
   * Two values rather than a score. A five-star scale invites deliberation over
   * a judgement people make in half a second, and the recommendation only needs
   * the sign — more like this, or less. It is also the difference between a
   * control someone will actually use on a list of two hundred titles and one
   * they will not.
   *
   * Pressing the rating a title already holds clears it, so the same pair of
   * buttons states and retracts an opinion. Without that there is no way back
   * from a mis-tap except a separate "clear" affordance nobody would look for.
   */
  import type { MediaSummary } from '@shared/types'
  import { library } from '../lib/library.svelte'

  interface Props {
    media: MediaSummary
    /** Compact enough to sit on a card; the default suits a row. */
    size?: 'sm' | 'md'
  }

  const { media, size = 'md' }: Props = $props()

  const rating = $derived(library.ratingFor(media.tmdbId))

  function rate(value: 'like' | 'dislike', event: MouseEvent): void {
    // These sit inside cards that open a detail overlay on click.
    event.stopPropagation()
    library.rate(media, value)
  }
</script>

<div class="rate" class:sm={size === 'sm'}>
  <button
    class="up"
    class:on={rating === 'like'}
    onclick={(e) => rate('like', e)}
    aria-pressed={rating === 'like'}
    title={rating === 'like' ? 'Liked — click to clear' : 'I liked this'}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" />
      <path d="M7 10l4.2-7.2a1 1 0 0 1 1.9.5V9h5.3a2 2 0 0 1 2 2.4l-1.4 7a2 2 0 0 1-2 1.6H7z" />
    </svg>
  </button>

  <button
    class="down"
    class:on={rating === 'dislike'}
    onclick={(e) => rate('dislike', e)}
    aria-pressed={rating === 'dislike'}
    title={rating === 'dislike' ? 'Disliked — click to clear' : 'Not for me'}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M17 14V3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1z" />
      <path d="M17 14l-4.2 7.2a1 1 0 0 1-1.9-.5V15H5.6a2 2 0 0 1-2-2.4l1.4-7a2 2 0 0 1 2-1.6H17z" />
    </svg>
  </button>
</div>

<style>
  .rate {
    display: flex;
    gap: var(--space-2);
  }

  button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    transition:
      color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }

  .sm button {
    width: 28px;
    height: 28px;
  }

  svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linejoin: round;
  }

  .sm svg {
    width: 13px;
    height: 13px;
  }

  button:hover {
    color: var(--text-primary);
    border-color: var(--border-strong);
    background: var(--bg-elevated);
  }

  /* Filled once chosen: an outline that only changes colour is easy to miss on
     a grid of two hundred, where the whole point is seeing what is still blank. */
  .up.on {
    color: var(--success);
    border-color: var(--success);
  }

  .down.on {
    color: var(--danger);
    border-color: var(--danger);
  }

  .up.on svg,
  .down.on svg {
    fill: currentColor;
  }
</style>
