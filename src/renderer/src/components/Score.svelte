<script lang="ts">
  /**
   * A TMDB score, drawn the same way everywhere.
   *
   * It used to be drawn in exactly two places — the browse poster and the
   * browse row — each with its own markup and its own `> 0` check. Every other
   * view that lists titles simply had no score at all, which is what the user
   * noticed. One component is the only way that stays true as views are added.
   *
   * Renders nothing at all when there is no score. See `shared/score.ts` for
   * why 0 counts as "nobody has rated this" rather than as a rating of zero.
   */
  import { formatScore, hasScore } from '@shared/score'

  interface Props {
    rating: number | null | undefined
    /** `sm` for episode rows and dense grids, `md` for cards and headers. */
    size?: 'sm' | 'md'
    /** Drawn on top of artwork, where it needs its own background to be legible. */
    onArtwork?: boolean
  }

  let { rating, size = 'sm', onArtwork = false }: Props = $props()
</script>

{#if hasScore(rating)}
  <span
    class="score {size}"
    class:on-artwork={onArtwork}
    title="TMDB score, {formatScore(rating as number)} out of 10"
  >
    <span class="star" aria-hidden="true">★</span>{formatScore(rating as number)}
  </span>
{/if}

<style>
  .score {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    color: var(--accent, #ffce6a);
    font-variant-numeric: tabular-nums;
    line-height: 1;
    white-space: nowrap;
  }

  .sm {
    font-size: var(--text-xs, 12px);
  }

  .md {
    font-size: var(--text-sm, 13px);
    font-weight: 600;
  }

  .star {
    /* Slightly smaller than the number: the glyph reads heavier than digits at
       the same size and otherwise dominates the pair. */
    font-size: 0.9em;
  }

  /* Over a poster there is no telling what is underneath, so the chip brings
     its own contrast rather than hoping. */
  .on-artwork {
    padding: 3px 6px;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.72);
    backdrop-filter: blur(4px);
  }
</style>
