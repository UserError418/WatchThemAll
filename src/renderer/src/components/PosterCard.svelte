<script lang="ts">
  /**
   * One tile in a row or grid.
   *
   * Hover reveals quick actions over the art rather than expanding the card
   * into its neighbours. Expansion is the more familiar streaming-UI gesture,
   * but it reflows the whole row under the cursor, and this app's rows are
   * dense enough that it makes the row feel unstable.
   *
   * Images carry explicit dimensions and lazy loading so a row does not reflow
   * as posters arrive. The original had no intrinsic sizing at all, so every
   * image load shifted the layout under the pointer.
   */
  import type { MediaSummary } from '@shared/types'
  import { library } from '../lib/library.svelte'
  import { posterSrcset, posterUrl } from '../lib/images'
  import { year } from '../lib/format'

  interface Props {
    media: MediaSummary
    onselect?: (media: MediaSummary) => void
    /** 0–100. Draws a progress bar along the bottom of the art when > 0. */
    progress?: number
    /** Overrides the year line, e.g. with a resume position. */
    subtitle?: string
  }

  const { media, onselect, progress = 0, subtitle }: Props = $props()

  const src = $derived(posterUrl(media.posterPath))
  const srcset = $derived(posterSrcset(media.posterPath))
  const saved = $derived(library.isInWatchlist(media.tmdbId))
  const label = $derived(subtitle ?? year(media.releaseDate))

  function toggleSaved(event: MouseEvent): void {
    // The card itself opens the detail view; the quick action must not.
    event.stopPropagation()
    if (saved) library.removeFromWatchlist(media.tmdbId)
    else library.addToWatchlist(media)
  }
</script>

<div class="card">
  <button class="hit" onclick={() => onselect?.(media)} title={media.title}>
    <div class="art">
      {#if src}
        <!--
          `sizes` is an HTML attribute and cannot read a CSS custom property.
          It used to say `var(--poster-width)`, which parses as nothing, and an
          unparseable `sizes` means `100vw` — so every poster in a grid fetched
          the 500w asset for a slot a fifth that wide, on the platform least able
          to afford it.

          `auto` is the real fix: it tells the browser to use the element's own
          laid-out width, which is what the custom property was reaching for. It
          needs `loading="lazy"`, which is already here. The two entries after it
          are the fallback for anything that does not support it, and are the
          desktop and phone values of `--poster-width` — duplicated knowingly,
          because the attribute has no way to reach the token.
        -->
        <img
          {src}
          {srcset}
          sizes="auto, (max-width: 600px) 104px, 168px"
          alt=""
          loading="lazy"
          decoding="async"
          width="168"
          height="252"
        />
      {:else}
        <div class="placeholder" aria-hidden="true">{media.title.slice(0, 1)}</div>
      {/if}

      {#if media.rating > 0}
        <span class="rating">{media.rating.toFixed(1)}</span>
      {/if}

      <div class="overlay">
        <span class="play" aria-hidden="true">▶</span>
      </div>

      {#if progress > 0}
        <div class="progress" aria-label="{Math.round(progress)}% watched">
          <div class="progress-fill" style:width="{Math.min(100, progress)}%"></div>
        </div>
      {/if}
    </div>

    <span class="title">{media.title}</span>
    {#if label}<span class="label">{label}</span>{/if}
  </button>

  <button
    class="save"
    class:on={saved}
    onclick={toggleSaved}
    aria-pressed={saved}
    aria-label={saved ? `Remove ${media.title} from watchlist` : `Add ${media.title} to watchlist`}
    title={saved ? 'In your watchlist' : 'Add to watchlist'}
  >
    {saved ? '✓' : '+'}
  </button>
</div>

<style>
  .card {
    position: relative;
    width: var(--poster-width);
  }

  .hit {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    width: 100%;
    padding: 0;
    text-align: left;
    transition: transform var(--dur-fast) var(--ease-out);
  }

  .card:hover .hit,
  .hit:focus-visible {
    transform: translateY(-5px);
  }

  .art {
    position: relative;
    aspect-ratio: var(--poster-ratio);
    border-radius: var(--radius-md);
    overflow: hidden;
    background: var(--bg-elevated);
    box-shadow: var(--shadow-card);
    transition: box-shadow var(--dur-fast) var(--ease-out);
  }

  .card:hover .art {
    box-shadow: var(--shadow-pop);
  }

  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .placeholder {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    font-size: var(--text-2xl);
    color: var(--text-disabled);
  }

  .rating {
    position: absolute;
    top: var(--space-2);
    left: var(--space-2);
    padding: 1px var(--space-2);
    border-radius: var(--radius-full);
    background: var(--bg-scrim);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  .overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.15));
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease-out);
  }

  .card:hover .overlay,
  .hit:focus-visible .overlay {
    opacity: 1;
  }

  .play {
    font-size: 22px;
    color: var(--text-on-media);
    text-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
  }

  .progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 3px;
    background: rgba(255, 255, 255, 0.22);
  }

  .progress-fill {
    height: 100%;
    background: var(--accent);
  }

  .save {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
    z-index: 1;
    width: 24px;
    height: 24px;
    border-radius: var(--radius-full);
    background: var(--bg-scrim);
    border: 1px solid var(--border-strong);
    color: var(--text-primary);
    font-size: var(--text-sm);
    line-height: 1;
    opacity: 0;
    transition: opacity var(--dur-fast) var(--ease-out);
  }

  .card:hover .save,
  .save:focus-visible,
  .save.on {
    opacity: 1;
  }

  /*
    Visible wherever there is no pointer to reveal it with.

    `opacity: 0` hides a button without disabling it, so on a touch device this
    was an invisible, full-size watchlist toggle sitting in the corner of every
    poster — a stray tap added or removed a title with no affordance and no
    feedback. Showing it is the honest option: it is a real action, and the
    alternative (`pointer-events: none` until hover) is an action the phone
    then has no way to reach at all.
  */
  @media (hover: none) {
    .save {
      opacity: 1;
    }
  }

  .save.on {
    background: var(--success);
    border-color: var(--success);
    color: var(--bg-base);
    font-weight: 700;
  }

  .title {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    line-height: var(--leading-snug);
    letter-spacing: var(--tracking-snug);
    /* Two lines then ellipsis — a long title must not resize its row. */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .label {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }
</style>
