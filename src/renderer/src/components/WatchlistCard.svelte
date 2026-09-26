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
  import type { Episode, MediaSummary, WatchlistEntry } from '@shared/types'
  import { library } from '../lib/library.svelte'
  import { posterUrl, stillUrl } from '../lib/images'
  import { episodeCode, runtime } from '../lib/format'
  import { canHover } from '../lib/pointer'
  import { findEpisode, loadSeason, peekSeason } from '../lib/episodecache'
  import { revealIn, revealOut } from '../lib/motion'
  import { resumeTarget } from '@shared/progress'
  import { resumeAnchor, type Activity } from '@shared/watchlistrank'
  import Score from './Score.svelte'

  interface Props {
    entry: WatchlistEntry
    activity: Activity
    onselect: (media: MediaSummary) => void
  }

  const { entry, activity, onselect }: Props = $props()

  let open = $state(false)
  let episodes = $state<Episode[]>([])
  let intentTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Guards a late response against a card that has moved on.
   *
   * Bumped on every open and close. A fetch that resolves after the pointer
   * has left compares its own token and drops the result — the episodes are
   * still cached for the next hover, so nothing is wasted, but this card does
   * not flash a still for a title the user is no longer looking at.
   */
  let generation = 0

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
  const tracked = $derived(library.isTracked(entry.tmdbId))

  /**
   * The season this card is about.
   *
   * From the marks rather than `lastSeason`, which is only written when an
   * episode is opened in the app's own player and is therefore stale for any
   * title watched elsewhere — see `resumeAnchor`. This decides which season is
   * fetched, so getting it wrong would show the still for the wrong episode as
   * well as sending "Resume" to the wrong place.
   */
  const anchor = $derived(resumeAnchor(entry))

  /** Where "Resume" goes: the last episode reached, unless it is finished. */
  const target = $derived(
    isSeries
      ? resumeTarget({
          episodes: episodes.map((e) => ({ season: e.season, episode: e.episode })),
          lastSeason: anchor.season,
          lastEpisode: anchor.episode,
          // Only the anchor season is loaded, so this never crosses into the
          // next one — which is correct rather than a limitation:
          // `resumeTarget` refuses to guess forward without the episode list
          // to prove the season is actually finished.
          seasonCount: anchor.season,
          isWatched: (s, e) => library.isWatched(entry.tmdbId, s, e),
        })
      : { season: 0, episode: 0 },
  )

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
      watched: library.isWatched(entry.tmdbId, e.season, e.episode),
      current: e.season === target.season && e.episode === target.episode,
    }))
  })

  function clearIntent(): void {
    if (intentTimer) clearTimeout(intentTimer)
    intentTimer = null
  }

  /**
   * Open, and fetch the still if this is a series we have not looked at.
   *
   * The cached case sets `episodes` synchronously so the still is there on the
   * first frame of the reveal — a still that fades in a beat after the panel
   * reads as the card stuttering rather than as an image loading.
   */
  function reveal(): void {
    open = true
    generation += 1
    if (!isSeries || !entry.tmdbId) return

    const season = anchor.season
    const cached = peekSeason(entry.tmdbId, season)
    if (cached) {
      episodes = cached
      return
    }

    const mine = generation
    void loadSeason(entry.tmdbId, season).then((result) => {
      if (mine === generation) episodes = result
    })
  }

  function hide(): void {
    clearIntent()
    open = false
    generation += 1
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

  /** Touch: the first tap reveals the controls, a second opens the title. */
  function onArtClick(): void {
    if (!canHover() && !open) {
      reveal()
      return
    }
    onselect(media)
  }

  function stop(event: Event): void {
    event.stopPropagation()
  }

  async function resume(event: MouseEvent): Promise<void> {
    stop(event)
    await window.wta.play({
      tmdbId: entry.tmdbId,
      imdbId: entry.imdbId,
      type: entry.type,
      title: entry.title,
      season: isSeries ? target.season : null,
      episode: isSeries ? target.episode : null,
      providerId: entry.providerId,
      // The episode's own runtime when the season listing supplied one; null
      // otherwise, which is what main already expects when TMDB is silent.
      runtimeMinutes: current?.runtime ?? null,
    })
  }

  function markSeasonWatched(event: MouseEvent): void {
    stop(event)
    // Season-scoped, per 1.5.7 — marking a nine-season show from a card must
    // not claim all nine.
    library.addToWatched(media, 'user', isSeries ? target.season : null)
  }

  function toggleTracked(event: MouseEvent): void {
    stop(event)
    if (tracked) library.removeTracker(entry.tmdbId)
    else library.addTracker(media)
  }

  function remove(event: MouseEvent): void {
    stop(event)
    library.removeFromWatchlist(entry.tmdbId)
  }

  $effect(() => clearIntent)
</script>

<!--
  `onmouseenter`/`onmouseleave` on the wrapper rather than the button so the
  controls strip is inside the hover region — a strip that dismisses itself
  when the pointer moves onto it is a control nobody can press.
-->
<div
  class="card"
  class:open
  onmouseenter={onEnter}
  onmouseleave={onLeave}
  onfocusin={() => canHover() && reveal()}
  onfocusout={(e) => {
    if (canHover() && !e.currentTarget.contains(e.relatedTarget as Node)) hide()
  }}
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

      <div class="buttons">
        <button class="go" onclick={resume}>
          ▶ {isSeries ? episodeCode(target.season, target.episode) : 'Resume'}
        </button>
        <button
          class="icon"
          onclick={markSeasonWatched}
          title={isSeries ? `Mark season ${target.season} watched` : 'Mark watched'}
          aria-label={isSeries ? `Mark season ${target.season} watched` : 'Mark watched'}>✓</button
        >
        {#if isSeries}
          <button
            class="icon"
            class:on={tracked}
            onclick={toggleTracked}
            title={tracked ? 'Stop tracking releases' : 'Track releases'}
            aria-label={tracked ? 'Stop tracking releases' : 'Track releases'}>🔔</button
          >
        {/if}
        <button
          class="icon danger"
          onclick={remove}
          title="Remove from watchlist"
          aria-label="Remove {entry.title} from watchlist">✕</button
        >
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

  .buttons {
    display: flex;
    gap: var(--space-1);
    align-items: center;
  }

  .go {
    flex: 1;
    min-width: 0;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-full);
    background: var(--accent);
    color: var(--text-on-accent);
    font-size: var(--text-xs);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .icon {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    flex: none;
    border-radius: var(--radius-full);
    background: rgb(255 255 255 / 16%);
    backdrop-filter: blur(4px);
    color: #fff;
    font-size: var(--text-xs);
    transition: background var(--dur-fast) var(--ease-out);
  }

  .icon:hover {
    background: rgb(255 255 255 / 32%);
  }

  .icon.on {
    background: var(--accent);
    color: var(--text-on-accent);
  }

  .icon.danger:hover {
    background: var(--danger);
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
