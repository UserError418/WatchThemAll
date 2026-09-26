<script lang="ts">
  /**
   * The Browse hero.
   *
   * Its subject is the most urgent thing in the user's own library: a tracked
   * series airing soon, otherwise something they are part-way through,
   * otherwise the top trending title. A hero showing a generic promo is
   * decoration; this one answers "what should I open".
   *
   * The backdrop is fetched at detail resolution for whichever subject wins,
   * because watchlist and tracker entries only store a poster path — a poster
   * stretched across a 60vh banner looks exactly as bad as it sounds.
   */
  import type { MediaSummary } from '@shared/types'
  import { library } from '../lib/library.svelte'
  import { backdropUrl, posterUrl } from '../lib/images'
  import { countdown, episodeCode } from '../lib/format'

  interface Props {
    fallback: MediaSummary | null
    onselect: (media: MediaSummary) => void
  }

  const { fallback, onselect }: Props = $props()

  interface Subject {
    media: MediaSummary
    kicker: string
    detail: string
  }

  function toMedia(entry: {
    tmdbId: number
    title: string
    posterPath: string | null
    genreIds?: number[]
  }): MediaSummary {
    return {
      tmdbId: entry.tmdbId,
      type: 'tv',
      title: entry.title,
      posterPath: entry.posterPath,
      backdropPath: null,
      overview: '',
      rating: 0,
      releaseDate: null,
      genreIds: entry.genreIds ?? [],
    }
  }

  const subject = $derived.by<Subject | null>(() => {
    // 1. A tracked series with an episode airing soonest.
    const upcoming = library.trackers
      .filter((t) => t.nextEpisode?.airDate)
      .sort(
        (a, b) =>
          new Date(`${a.nextEpisode!.airDate}T00:00:00`).getTime() -
          new Date(`${b.nextEpisode!.airDate}T00:00:00`).getTime(),
      )[0]

    if (upcoming?.nextEpisode) {
      const next = upcoming.nextEpisode
      return {
        media: toMedia(upcoming),
        kicker: 'Airing soon',
        detail: `${episodeCode(next.season, next.episode)}${next.name ? ` · ${next.name}` : ''} — in ${countdown(next.airDate)}`,
      }
    }

    // 2. Something already in progress.
    const inProgress = library.listedWatchlist.find(
      (w) => w.type === 'tv' && w.watchedEpisodes.length > 0,
    )
    if (inProgress) {
      return {
        media: toMedia(inProgress),
        kicker: 'Continue watching',
        detail: `Up next: ${episodeCode(inProgress.lastSeason ?? 1, inProgress.lastEpisode ?? 1)}`,
      }
    }

    // 3. Whatever is trending.
    if (fallback) {
      return { media: fallback, kicker: 'Trending now', detail: fallback.overview }
    }
    return null
  })

  let backdropPath = $state<string | null>(null)

  /**
   * The billboard does not autoplay a trailer, and that is deliberate.
   *
   * Its subject is the most urgent thing in the user's *own* library — the
   * series they are part-way through, or one airing soon. So unlike a browse
   * card, it is the same title on every visit, and it is a title they have
   * already chosen and already know. An autoplaying trailer for it is not
   * discovery, it is the same thirty seconds of footage and audio starting
   * again every time the app opens, with no way to opt out short of muting
   * every preview in the app.
   *
   * Hover previews on cards keep their trailers: those are titles the user has
   * *not* chosen, where motion answers "what is this" and the user asked by
   * pointing at it. The distinction is who picked the subject.
   */
  $effect(() => {
    const media = subject?.media
    if (!media) return

    backdropPath = media.backdropPath
    if (media.tmdbId === 0) return

    let cancelled = false

    // Still worth the request: library entries store only a poster path, and
    // the billboard needs landscape art to fill the width.
    void window.wta.tmdb
      .detail(media.tmdbId, media.type)
      .then((detail) => {
        if (cancelled || !detail) return
        backdropPath = detail.backdropPath ?? media.backdropPath
      })
      .catch(() => {
        // The hero degrades to whatever art the summary carried.
      })

    return () => {
      cancelled = true
    }
  })

  const backdrop = $derived(backdropUrl(backdropPath, 'original'))

  /**
   * Portrait art for the narrow layout.
   *
   * The billboard's box is landscape on a desktop and very nearly square on a
   * phone — measured at 412x460, a ratio of 0.87 against the backdrop's 1.78.
   * `object-fit: cover` then discards 51% of the frame, and what survives is
   * whatever happened to be in the middle: an actor's shoulder, a cropped
   * skyline. TMDB's poster is 0.67, so the same box throws away 26% and does it
   * along the axis posters are composed to tolerate.
   *
   * `<picture>` rather than a second `<img>` or a JS width check: the browser
   * picks before it fetches, so only one image is ever requested, and the
   * breakpoint stays next to the one in this component's stylesheet.
   */
  const portrait = $derived(posterUrl(subject?.media.posterPath ?? null, 'w500'))
</script>

{#if subject}
  <section class="hero" class:has-art={!!backdrop}>
    {#if backdrop}
      <picture>
        {#if portrait}
          <source media="(max-width: 720px)" srcset={portrait} />
        {/if}
        <img
          class="art"
          src={backdrop}
          alt=""
          fetchpriority="high"
          decoding="async"
        />
      </picture>
    {/if}


    <div class="fade"></div>

    <div class="content">
      <span class="kicker">{subject.kicker}</span>
      <h1>{subject.media.title}</h1>
      {#if subject.detail}
        <p class="detail">{subject.detail}</p>
      {/if}
      <div class="actions">
        <button class="play" onclick={() => onselect(subject.media)}>
          <span class="glyph">▶</span> Play
        </button>
        <button class="info" onclick={() => onselect(subject.media)}>
          <span class="glyph">ⓘ</span> More Info
        </button>
      </div>
    </div>
  </section>
{/if}

<style>
  .hero {
    position: relative;
    /**
     * Netflix's billboard is a 16:9 slab that fills the fold. Taller than the
     * previous banner on purpose — a hero that shares the fold with a full row
     * of cards reads as a header, not as the page's subject.
     *
     * The lower bound keeps it usable on a short window; the upper stops it
     * becoming absurd on a 4K display.
     */
    height: clamp(440px, 72vh, 820px);
    display: flex;
    align-items: flex-end;
    /* Rows begin under the billboard's fade rather than after it, so the page
       reads as one surface. */
    margin-bottom: calc(var(--space-7) * -1);
    background: var(--bg-raised);
    overflow: hidden;
  }

  /*
    Taken out of flow, behind everything.

    `.hero` is a flex row with `align-items: flex-end`, so an in-flow image is a
    flex *item* — it takes the full width and pushes `.content` out past the
    right edge of the slab, where `overflow: hidden` clips it. The title, the
    kicker and the Play button were rendering at x = 1014 in a 1014px hero:
    present in the DOM, correct in every other respect, and invisible.
  */
  .art {
    position: absolute;
    inset: 0;
    z-index: 0;
    width: 100%;
    height: 100%;
    /* `cover`, or a backdrop whose aspect ratio differs from the slab's is
       stretched — the default for an <img> with both dimensions set is `fill`. */
    object-fit: cover;
    transition: opacity var(--dur-slow) var(--ease-out);
  }


  .fade {
    position: absolute;
    inset: 0;
    /* Three stops rather than two: the bottom fade has to reach the page
       background exactly, or the seam between hero and first row shows as a
       band on wide displays. */
    background:
      linear-gradient(
        to top,
        var(--bg-base) 0%,
        rgb(var(--bg-base-rgb) / 0.72) 18%,
        rgb(var(--bg-base-rgb) / 0.18) 46%,
        transparent 72%
      ),
      linear-gradient(to right, rgb(var(--bg-base-rgb) / 0.92) 0%, rgb(var(--bg-base-rgb) / 0.05) 58%);
  }

  .content {
    position: relative;
    /* Bottom padding sits above the fade, not below it — too much and the
       content overflows the slab and is clipped by `overflow: hidden`. */
    padding: var(--space-6) var(--page-inset) var(--space-8);
    max-width: 44ch;
  }


  .kicker {
    display: inline-block;
    margin-bottom: var(--space-2);
    padding: 2px var(--space-2);
    border-radius: var(--radius-full);
    background: var(--accent-muted);
    color: var(--accent-hover);
    font-size: var(--text-xs);
    font-weight: 700;
    letter-spacing: 0.6px;
    text-transform: uppercase;
  }

  h1 {
    margin: 0 0 var(--space-2);
    font-size: clamp(var(--text-xl), 4.5vw, 52px);
    line-height: 1.05;
    letter-spacing: -1px;
    text-shadow: 0 2px 24px rgba(0, 0, 0, 0.55);
  }

  .detail {
    margin: 0 0 var(--space-4);
    color: var(--text-secondary);
    font-size: var(--text-md);
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .actions {
    display: flex;
    gap: var(--space-2);
  }

  .actions button {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-6);
    border-radius: var(--radius-sm);
    font-size: var(--text-md);
    font-weight: 700;
    transition:
      background var(--dur-fast) var(--ease-out),
      opacity var(--dur-fast) var(--ease-out);
  }

  .glyph {
    font-size: var(--text-lg);
    line-height: 1;
  }

  /*
    Accent, not white.

    A white play button is the single most borrowed element in the app, and it
    was only white because the old indigo looked wrong on artwork. The amber
    does not, so the primary action can finally be the brand colour — which is
    also what makes it read as *the* action rather than as one of two grey
    pills.
  */
  .play {
    background: var(--accent);
    color: var(--text-on-accent);
    box-shadow: var(--shadow-sm);
  }
  .play:hover {
    background: var(--accent-hover);
  }
  .play:active {
    background: var(--accent-press);
  }

  .info {
    background: rgb(255 255 255 / 0.14);
    color: var(--text-primary);
    /* Glass rather than a flat tint: it sits on artwork, and letting the image
       through is what stops it reading as a sticker. */
    backdrop-filter: blur(12px);
    box-shadow: var(--edge-highlight);
  }
  .info:hover {
    background: rgb(255 255 255 / 0.22);
  }

  @media (max-width: 720px) {
    .hero {
      height: 340px;
    }
    .content {
      padding: var(--space-5) var(--space-4) var(--space-6);
    }
  }
</style>
