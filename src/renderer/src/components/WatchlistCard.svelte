<script lang="ts">
  /**
   * One Watchlist entry: a poster that turns into where you actually are.
   *
   * ## Why it does not resize on hover
   *
   * The brief asked for the card to "get bigger". The obvious reading — grow
   * the card — is the one this codebase has already rejected twice in writing:
   * `PosterCard`'s header says expansion "reflows the whole row under the
   * cursor, and this app's rows are dense enough that it makes the row feel
   * unstable", and `TitleCard`'s says growth must come from width rather than
   * `transform: scale()` because scaling re-rasterises text. A grid is worse
   * than a rail for both, because a reflow moves the rows underneath as well
   * as the neighbours.
   *
   * So the size increase is paid at rest — these are half again as wide as the
   * old watchlist tiles — and hover changes *content* rather than geometry:
   * the poster crossfades to the still of the episode you are on, the caption
   * gains the episode name, and the controls rise over the artwork. Nothing
   * moves in layout. The card reads as bigger because it is fuller.
   *
   * ## Why the still is fetched here and not by the view
   *
   * Three gates, in order: the device must be able to hover at all, the
   * pointer must stay for `--hover-intent`, and the season must not already be
   * cached. A pointer swept across twenty cards starts nothing, because the
   * timer never fires. See `episodecache.ts` for the rest.
   */
  import type { MediaSummary, WatchlistEntry } from '@shared/types'
  import { library } from '../lib/library.svelte'
  import { removeFromWatchlist } from '../lib/undo'
  import { posterUrl, stillUrl } from '../lib/images'
  import { episodeCode, runtime } from '../lib/format'
  import { canHover } from '../lib/pointer'
  import { findEpisode } from '../lib/episodecache'
  import { loadListing, peekListing, seriesPickUp, settlePickUp } from '../lib/pickup.svelte'
  import { whenVisible } from '../lib/titlefacts.svelte'
  import { revealIn, revealOut } from '../lib/motion'
  import type { Activity } from '@shared/watchlistrank'
  import Score from './Score.svelte'

  interface Props {
    entry: WatchlistEntry
    activity: Activity
    onselect: (media: MediaSummary) => void
  }

  const { entry, activity, onselect }: Props = $props()

  let open = $state(false)
  let intentTimer: ReturnType<typeof setTimeout> | null = null

  const media = $derived<MediaSummary>({
    tmdbId: entry.tmdbId,
    type: entry.type,
    title: entry.title,
    posterPath: entry.posterPath,
    backdropPath: null,
    overview: '',
    rating: entry.rating,
    releaseDate: null,
    genreIds: entry.genreIds,
  })

  const poster = $derived(posterUrl(entry.posterPath, 'w342'))
  const isSeries = $derived(entry.type === 'tv')

  /**
   * Where this series picks up, and so what the play button plays.
   *
   * The rule the detail view's Resume and Continue Watching use too
   * (`pickup.svelte.ts`): the further of the episode last played and the last
   * one ticked, moved past anything finished, into the next season when this
   * one is done. Until 2.0.12 the card never crossed seasons, so after a
   * season finale its button replayed the finale. It needs the season's
   * listing, and the next season's at a season's end: until they are in, it
   * names where the user is. They are fetched once the card is near the
   * screen, and only for a series whose answer depends on them.
   */
  const target = $derived(isSeries ? seriesPickUp(entry).target : { season: 0, episode: 0 })

  /** The season Resume is in: for the still, the episode's name and the pips. */
  const episodes = $derived(isSeries ? (peekListing(entry.tmdbId, target.season) ?? []) : [])

  const current = $derived(
    isSeries && episodes.length > 0 ? findEpisode(episodes, target.season, target.episode) : null,
  )

  const still = $derived(stillUrl(current?.stillPath ?? null, 'w300'))

  /** The line under the title. Always available, unlike the percentage. */
  const positionLabel = $derived.by(() => {
    if (!isSeries) {
      const film = library.filmProgress(entry.tmdbId)
      return film ? `${runtime(film.minutesIn)} in` : 'Film'
    }
    const code = episodeCode(target.season, target.episode)
    return activity.total ? `${code} · ${activity.watched} of ${activity.total}` : code
  })

  const percent = $derived(activity.fraction === null ? null : Math.round(activity.fraction * 100))

  /**
   * Pips for the season you are on — one per episode, filled where watched,
   * with the resume target marked.
   *
   * Scoped to the season rather than the series on purpose. The series total
   * is the wrong unit at real sizes: this library holds runs of 279, 337 and
   * 416 episodes, and a bar of four hundred marks is a texture, not a count.
   * A season is a length a person actually thinks in, and it is also the one
   * the fetched listing can speak to episode by episode — so these say "you
   * are six into this season of ten", which is the question the card is for.
   *
   * Still capped: a few anime seasons run past thirty, and past that the marks
   * are thinner than the gaps between them.
   */
  const PIP_LIMIT = 30
  const pips = $derived.by(() => {
    if (!isSeries || episodes.length === 0 || episodes.length > PIP_LIMIT) return null
    return episodes.map((e) => ({
      key: `${e.season}:${e.episode}`,
      watched: library.isWatched(entry, e.season, e.episode),
      current: e.season === target.season && e.episode === target.episode,
    }))
  })

  function clearIntent(): void {
    if (intentTimer) clearTimeout(intentTimer)
    intentTimer = null
  }

  /**
   * Open, and fetch the listing the still comes from if this session has not.
   *
   * A cached listing reaches `episodes` synchronously, so the still is there
   * on the first frame of the reveal — a still that fades in a beat after the
   * panel reads as the card stuttering rather than as an image loading. A late
   * answer is harmless: the still is only drawn while the card is open.
   */
  function reveal(): void {
    open = true
    if (!isSeries || !entry.tmdbId) return
    void settlePickUp(entry).then((at) => loadListing(entry.tmdbId, at.season))
  }

  /** The caption names where Resume goes, so it is settled once the card is near the screen. */
  function settleCaption(): void {
    if (isSeries && entry.tmdbId) void settlePickUp(entry)
  }

  function hide(): void {
    clearIntent()
    open = false
  }

  function onEnter(): void {
    /*
     * A tap is not a hover, whatever the browser says. Touch fires a synthetic
     * `mouseenter` and then never fires `mouseleave`, so an opened card would
     * latch until the user happened to press something else — the exact bug
     * `pointer.ts` records `TitleCard` shipping.
     */
    if (!canHover()) return
    clearIntent()
    intentTimer = setTimeout(reveal, 260)
  }

  function onLeave(): void {
    if (!canHover()) return
    hide()
  }

  /**
   * Touch opens the title at once. The quick actions are for a pointer only
   * (the owner, 2026-09-28: gone from the phone, where the first tap used to
   * reveal them and only a second one opened anything).
   */
  function onArtClick(): void {
    onselect(media)
  }

  function stop(event: Event): void {
    event.stopPropagation()
  }

  async function resume(event: MouseEvent): Promise<void> {
    stop(event)
    // Settled first: before the listings are in, the target is where the user
    // is, which is often an episode already watched.
    const at = isSeries ? await settlePickUp(entry) : null
    await window.wta.play({
      tmdbId: entry.tmdbId,
      imdbId: entry.imdbId,
      type: entry.type,
      title: entry.title,
      season: at?.season ?? null,
      episode: at?.episode ?? null,
      providerId: entry.providerId,
      // The episode's own runtime when the season listing supplied one; null
      // otherwise, which is what main already expects when TMDB is silent.
      runtimeMinutes: at ? (findEpisode(peekListing(entry.tmdbId, at.season) ?? [], at.season, at.episode)?.runtime ?? null) : null,
    })
  }

  function markSeasonWatched(event: MouseEvent): void {
    stop(event)
    // Season-scoped, per 1.5.7 — marking a nine-season show from a card must
    // not claim all nine.
    library.addToWatched(media, 'user', isSeries ? target.season : null)
  }

  function remove(event: MouseEvent): void {
    stop(event)
    removeFromWatchlist(entry)
  }

  $effect(() => clearIntent)
</script>

<!--
  `onmouseenter`/`onmouseleave` on the wrapper rather than the button so the
  controls strip is inside the hover region — a strip that dismisses itself
  when the pointer moves onto it is a control nobody can press.
-->
<div
  class="card watchlist-card"
  class:open
  onmouseenter={onEnter}
  onmouseleave={onLeave}
  onfocusin={() => canHover() && reveal()}
  onfocusout={(e) => {
    if (canHover() && !e.currentTarget.contains(e.relatedTarget as Node)) hide()
  }}
  use:whenVisible={settleCaption}
  role="group"
>
  <button class="art" onclick={onArtClick} aria-label={entry.title}>
    {#if poster}
      <img
        class="poster"
        class:dim={open && still !== null}
        src={poster}
        alt=""
        loading="lazy"
        decoding="async"
        width="230"
        height="345"
      />
    {:else}
      <span class="empty" aria-hidden="true">{entry.title.slice(0, 1)}</span>
    {/if}

    {#if open && still}
      <!-- Crossfaded over the poster rather than replacing it, so a still that
           fails to load leaves the artwork rather than a hole. -->
      <img class="still" src={still} alt="" decoding="async" />
    {/if}

    <span class="score"><Score rating={entry.rating} onArtwork /></span>

    {#if percent !== null}
      <div class="bar" aria-hidden="true"><span style:width="{percent}%"></span></div>
    {/if}

    {#if open}
      <div class="veil" transition:revealIn|local></div>
    {/if}
  </button>

  {#if open}
    <div class="controls" in:revealIn|local out:revealOut|local>
      {#if current}
        <p class="episode" title={current.name}>
          {episodeCode(current.season, current.episode)} · {current.name}
        </p>
      {/if}

      {#if pips}
        <div class="pips" aria-hidden="true">
          {#each pips as pip (pip.key)}<span
              class:filled={pip.watched}
              class:current={pip.current}
            ></span>{/each}
        </div>
      {/if}

      <!--
        Three actions, not four (the owner, 2026-09-28): the release bell
        went, and tracking lives on the detail view's "Track releases". Icons
        are SVG rather than ✓ ✕ 🔔: an emoji takes the platform's colour font,
        and a glyph a build's fonts lack draws as a box.
      -->
      <div class="buttons">
        <button class="go" onclick={resume}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" /></svg>
          <span>{isSeries ? episodeCode(target.season, target.episode) : 'Resume'}</span>
        </button>
        <button
          class="icon"
          onclick={markSeasonWatched}
          title={isSeries ? `Mark season ${target.season} watched` : 'Mark watched'}
          aria-label={isSeries ? `Mark season ${target.season} watched` : 'Mark watched'}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" class="stroke" /></svg>
        </button>
        <button
          class="icon danger"
          onclick={remove}
          title="Remove from watchlist"
          aria-label="Remove {entry.title} from watchlist"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" class="stroke" /></svg>
        </button>
      </div>
    </div>
  {/if}

  <button class="caption" onclick={() => onselect(media)} tabindex="-1">
    <span class="title">{entry.title}</span>
    <span class="sub">
      {positionLabel}{#if percent !== null}<span class="pct">&nbsp;· {percent}%</span>{/if}
    </span>
  </button>
</div>

<style>
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    border-radius: var(--radius-lg);
    transition:
      transform var(--dur-mid) var(--ease-out),
      filter var(--dur-mid) var(--ease-out);
  }

  /*
   * The lift is the whole geometric change. 6px and a shadow is enough to say
   * "this one", and unlike a scale it cannot blur the caption or disturb the
   * grid: `translate` does not participate in layout.
   */
  .card.open {
    transform: translateY(-6px);
    z-index: 2;
  }

  .art {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: var(--poster-ratio);
    border-radius: var(--radius-lg);
    overflow: hidden;
    background: var(--bg-raised);
    box-shadow: var(--shadow-sm);
    transition:
      box-shadow var(--dur-mid) var(--ease-out),
      outline-color var(--dur-mid) var(--ease-out);
    outline: 2px solid transparent;
    outline-offset: 0;
  }

  .card.open .art {
    box-shadow: var(--shadow-lg);
    outline-color: var(--accent);
  }

  .poster,
  .still {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .poster {
    transition:
      filter var(--dur-mid) var(--ease-out),
      transform var(--dur-mid) var(--ease-out);
  }

  /*
   * Blurred and darkened rather than hidden. The still is 16:9 inside a 2:3
   * frame, so the poster is what fills the space above and below it —
   * removing it would leave two bars of flat background. Blurring it turns
   * that leftover into a backdrop for the still instead of a second image
   * competing with it, which is what merely dimming it looked like.
   */
  .poster.dim {
    filter: blur(10px) brightness(0.45) saturate(0.9);
    transform: scale(1.06);
  }

  .still {
    height: auto;
    inset: auto 0 auto 0;
    top: 50%;
    transform: translateY(-50%);
    aspect-ratio: 16 / 9;
    box-shadow: 0 6px 20px rgb(0 0 0 / 55%);
    animation: still-in var(--dur-mid) var(--ease-out);
  }

  @keyframes still-in {
    from {
      opacity: 0;
      transform: translateY(-50%) scale(0.98);
    }
  }

  .empty {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    font-size: var(--text-2xl);
    color: var(--text-tertiary);
  }

  .veil {
    position: absolute;
    inset: 0;
    background: linear-gradient(to top, rgb(0 0 0 / 78%) 0%, rgb(0 0 0 / 10%) 55%);
    pointer-events: none;
  }

  .score {
    position: absolute;
    top: var(--space-2);
    right: var(--space-2);
    z-index: 1;
  }

  .bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 3px;
    background: rgb(255 255 255 / 18%);
    z-index: 1;
  }

  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width var(--dur-mid) var(--ease-out);
  }

  /*
   * Absolutely positioned so revealing it cannot change the card's height —
   * which would reflow the grid row and move every neighbour, the exact thing
   * the module header is about.
   */
  .controls {
    position: absolute;
    left: var(--space-2);
    right: var(--space-2);
    /* Clear of the caption, which sits below the art. */
    bottom: calc(var(--space-8) + var(--space-2));
    z-index: 3;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .episode {
    margin: 0;
    font-size: var(--text-xs);
    color: #fff;
    text-shadow: 0 1px 3px rgb(0 0 0 / 80%);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pips {
    display: flex;
    gap: 2px;
  }

  .pips span {
    flex: 1;
    height: 3px;
    border-radius: 2px;
    background: rgb(255 255 255 / 30%);
  }

  .pips span.filled {
    background: var(--accent);
  }

  /*
   * The one you would resume. Taller and lighter than its neighbours so it
   * reads as a position marker rather than as one more watched episode — the
   * colour alone would not survive sitting next to a run of filled pips.
   */
  .pips span.current {
    background: #fff;
    height: 6px;
    margin-top: -1.5px;
  }

  /*
    One row of 40px targets, up from 26px circles and a pill of small text
    (the owner, 2026-09-28: "make the buttons bigger"). Frosted glass for the
    two secondary actions, so they read over any poster without competing
    with the one amber action.
  */
  .buttons {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }

  .go {
    flex: 1;
    min-width: 0;
    height: 40px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 0 var(--space-3);
    border-radius: var(--radius-full);
    background: var(--accent);
    color: var(--text-on-accent);
    font-size: var(--text-sm);
    font-weight: 700;
    box-shadow: 0 6px 18px rgb(0 0 0 / 35%);
    transition:
      transform var(--dur-fast) var(--ease-out),
      filter var(--dur-fast) var(--ease-out);
  }

  .go span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .go svg {
    width: 18px;
    height: 18px;
    flex: none;
    fill: currentColor;
  }

  .go:hover {
    filter: brightness(1.08);
  }

  .go:active,
  .icon:active {
    transform: scale(0.95);
  }

  .icon {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    flex: none;
    border-radius: var(--radius-full);
    border: 1px solid rgb(255 255 255 / 18%);
    background: rgb(20 20 26 / 55%);
    backdrop-filter: blur(10px);
    color: #fff;
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      transform var(--dur-fast) var(--ease-out);
  }

  .icon svg {
    width: 20px;
    height: 20px;
  }

  .icon svg .stroke {
    fill: none;
    stroke: currentColor;
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .icon:hover {
    background: rgb(255 255 255 / 22%);
    border-color: rgb(255 255 255 / 30%);
  }

  .icon.danger:hover {
    background: var(--danger);
    border-color: transparent;
  }

  .caption {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    min-width: 0;
  }

  .title {
    font-size: var(--text-sm);
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sub {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pct {
    color: var(--text-tertiary);
  }
</style>
