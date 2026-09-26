<script lang="ts">
  /**
   * A landscape title card, and the expanded preview it grows into.
   *
   * On the phone it is a poster instead, and never grows — see `lib/cardart.ts`
   * and the card tokens in `mobile.css`.
   *
   * This is the Netflix browse-row gesture: hover a card, it lifts and widens
   * in place, the artwork gives way to a muted trailer, and a row of circular
   * actions appears beneath it with the metadata.
   *
   * Two decisions here are what separate this from an animation that merely
   * looks similar.
   *
   * **The card grows by changing width, not by `transform: scale()`.** Scaling
   * would blur every glyph in the panel, and the panel is mostly text. Growing
   * the box means the text is laid out at its natural size and stays crisp.
   *
   * **Nothing visible happens until the pointer has settled.** Sweeping across
   * a row would otherwise expand every card in turn and start a trailer in
   * each. The card expands after `EXPAND_DELAY_MS`, and the trailer starts at
   * that same moment — see `onEnter` for why it no longer waits longer, and
   * why the trailer *lookup* starts earlier than either.
   */
  import type { MediaSummary } from '@shared/types'
  import { library } from '../lib/library.svelte'
  import { backdropUrl, logoUrl, posterUrl } from '../lib/images'
  import { year } from '../lib/format'
  import { previewAudio, previewId } from '../lib/preview.svelte'
  import { canHover } from '../lib/pointer'
  import { cardArt } from '../lib/cardart'
  import { titleFacts, whenVisible } from '../lib/titlefacts.svelte'
  import TrailerEmbed, { trailerUnavailable } from './TrailerEmbed.svelte'
  import Score from './Score.svelte'

  interface Props {
    media: MediaSummary
    onselect?: (media: MediaSummary) => void
    /** 0–100. Draws a progress bar along the bottom of the art when > 0. */
    progress?: number
    /** Overrides the year line, e.g. with a resume position. */
    subtitle?: string
    /**
     * Which way to grow. Edge cards must expand inward or they are clipped by
     * the scroll container — the row sets this for its first and last child.
     */
    anchor?: 'start' | 'center' | 'end'
  }

  const { media, onselect, progress = 0, subtitle, anchor = 'center' }: Props = $props()

  let expanded = $state(false)
  let trailerKey = $state<string | null>(null)
  let showTrailer = $state(false)

  /** How long the pointer must rest on a card before it expands and its trailer starts. */
  const EXPAND_DELAY_MS = 340

  let expandTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * The TMDB lookup for this card's trailer, shared by every hover of it.
   *
   * Kept as the promise rather than the result so a lookup already in flight
   * when the card expands is awaited instead of being sent a second time.
   */
  let trailerRequest: Promise<string | null> | null = null

  /**
   * The poster, when the stylesheet shapes cards as posters — the phone's rows.
   *
   * See `lib/cardart.ts`. A title without a poster keeps its backdrop, cropped,
   * and its printed name, rather than a blank tile.
   */
  const showsPoster = $derived(cardArt() === 'poster' && Boolean(media.posterPath))

  /**
   * What TMDB says about the title beyond the summary the card was given:
   * its logo, and a backdrop when the card came without one.
   *
   * Fetched when the card first comes near the screen (`titlefacts`, cached
   * for a week), so a row does not ask about titles nobody scrolls to. Not for
   * posters, which need neither.
   */
  const facts = $derived(
    showsPoster || !media.tmdbId ? null : titleFacts.get(media.type, media.tmdbId),
  )

  /**
   * Otherwise landscape art, falling back to the poster.
   *
   * Browse rows come from TMDB and nearly always have a backdrop. Continue
   * Watching builds its cards from library entries, which store none, so it
   * takes the one from the facts. The poster fallback is for what is left —
   * IMDB-sourced results carry poster art only.
   */
  const backdrop = $derived(media.backdropPath ?? facts?.backdropPath ?? null)
  const art = $derived(
    showsPoster
      ? posterUrl(media.posterPath)
      : (backdropUrl(backdrop, 'w780') ?? posterUrl(media.posterPath)),
  )
  const hasBackdrop = $derived(Boolean(backdrop))

  /**
   * The title's logo over the backdrop, the way a streaming service's cards
   * carry their name — a backdrop never does (none of 186 measured), and the
   * plain text line under it is what the user had to read instead.
   *
   * Only over a backdrop. A poster cropped into the frame usually shows its
   * own lettering, and a logo on top of that printed the name twice. The
   * text name stays until the logo has actually loaded, and stays for good
   * when there is none — about one title in twenty.
   */
  const logo = $derived(hasBackdrop ? logoUrl(facts?.logoPath ?? null) : null)
  let logoLoaded = $state(false)

  function wantFacts(): void {
    if (!showsPoster && media.tmdbId) titleFacts.want(media.type, media.tmdbId)
  }
  const saved = $derived(library.isInWatchlist(media.tmdbId))
  const tracked = $derived(library.isTracked(media.tmdbId))
  const label = $derived(subtitle ?? year(media.releaseDate))

  function clearTimers(): void {
    if (expandTimer) clearTimeout(expandTimer)
    expandTimer = null
  }

  function onEnter(): void {
    /**
     * A tap is not a hover, whatever the browser says.
     *
     * Android synthesises a `mouseenter` on tap and never sends the matching
     * `mouseleave`, so both timers below ran after a tap that had *also*
     * opened the detail overlay — and 560 ms later a trailer started playing,
     * with sound, behind the sheet the user was reading. It then stayed,
     * because the only thing that stops it is a `mouseleave` that never comes.
     *
     * Nothing is lost by returning early: the expansion it gates is a hover
     * affordance, and the panel it reveals duplicates what the detail overlay
     * — one tap away, and what the tap actually opened — already offers.
     */
    if (!canHover()) return

    clearTimers()

    /**
     * The lookup starts now, while the pointer is still deciding.
     *
     * It is one small request that the main process caches for ten minutes,
     * and it used to run *after* the expansion delay, adding its whole round
     * trip — 130–200 ms measured — to every preview. Started here it finishes
     * inside the delay instead. A pointer sweeping across a row does now send
     * one lookup per card it crosses; that is the price, and it buys nothing
     * visible — no expansion, no iframe — for the cards merely passed over.
     */
    void requestTrailer()

    expandTimer = setTimeout(() => {
      expanded = true
      /**
       * The trailer starts with the expansion, not after a further wait.
       *
       * There used to be another 220 ms here, to keep an iframe from appearing
       * as a black box on a card the pointer might still leave. The embed no
       * longer draws anything until its first video frame — its page is made
       * transparent, see `main/embedchrome.ts` — so the artwork stays in view
       * until there is motion to replace it, and the wait only delayed that
       * motion. Measured: pointer-to-moving went from about 1.56 s to about
       * 1.2 s with this and the early lookup together.
       */
      void startTrailer()
    }, EXPAND_DELAY_MS)
  }

  function onLeave(): void {
    clearTimers()
    expanded = false
    showTrailer = false
    // Hands the sound back, which lets the billboard pick it up again.
    previewAudio.release(audioId)
  }

  function requestTrailer(): Promise<string | null> {
    // IMDB-sourced results have no TMDB id yet, and TMDB is where trailers
    // come from. They simply keep their artwork until opened.
    if (media.tmdbId === 0) return Promise.resolve(null)
    trailerRequest ??= window.wta.tmdb.trailer(media.tmdbId, media.type).catch(() => {
      // A missing trailer is not worth surfacing — the artwork stays. Forget
      // the failure so the next hover asks again rather than inheriting it.
      trailerRequest = null
      return null
    })
    return trailerRequest
  }

  async function startTrailer(): Promise<void> {
    const key = await requestTrailer()
    // The pointer may have left while the request was in flight.
    if (!key || !expanded) return
    trailerKey = key
    showTrailer = true
    // Hovering a card is a deliberate act, so it takes the sound from
    // whatever was playing ambiently behind it.
    previewAudio.claim(audioId)
  }

  const audioId = previewId('card')
  /**
   * Silent unless the user wants sound *and* this card is the surface that
   * currently owns it — otherwise a hovered card and the billboard behind it
   * both play out loud. See `lib/preview.svelte.ts`.
   */
  const muted = $derived(!library.settings.previewAudio || !previewAudio.holds(audioId))

  function stop(event: MouseEvent): void {
    // The card itself opens the detail view; quick actions must not.
    event.stopPropagation()
  }

  function toggleSaved(event: MouseEvent): void {
    stop(event)
    if (saved) library.removeFromWatchlist(media.tmdbId)
    else library.addToWatchlist(media)
  }

  function toggleTracked(event: MouseEvent): void {
    stop(event)
    if (tracked) library.removeTracker(media.tmdbId)
    else library.addTracker(media)
  }
</script>

<!--
  `onmouseenter`/`onmouseleave` rather than CSS `:hover`, because the expansion
  is delayed and the trailer is fetched — both need real timers.
-->
<div
  class="card"
  class:expanded
  class:playing={showTrailer && trailerKey && !trailerUnavailable(trailerKey)}
  data-anchor={anchor}
  onmouseenter={onEnter}
  onmouseleave={onLeave}
  use:whenVisible={wantFacts}
  role="presentation"
>
  <div class="inner">
    <!--
      `aria-label`, not `title`. A `title` puts the browser's own tooltip in the
      middle of the card within a second of the pointer resting — which is
      exactly when the trailer starts, so every preview played under a grey
      label box. The name is already printed on the card itself.
    -->
    <button class="hit" onclick={() => onselect?.(media)} aria-label={media.title}>
      <div class="art">
        {#if art}
          <img
            src={art}
            alt=""
            loading="lazy"
            decoding="async"
            class:contain={!showsPoster && !hasBackdrop}
            width={showsPoster ? 154 : 254}
            height={showsPoster ? 231 : 143}
          />
        {:else}
          <div class="placeholder" aria-hidden="true">{media.title.slice(0, 1)}</div>
        {/if}

        {#if showTrailer && trailerKey && !previewAudio.suspended}
          <TrailerEmbed
            videoKey={trailerKey}
            {muted}
            title="{media.title} trailer"
          />
        {/if}

        <!--
          Always-on gradient so the title stays legible over any artwork.
          Not on a poster: the poster prints its own title, and a second one
          across the bottom of a 120px tile covers a third of the art.
        -->
        {#if !showsPoster}
          <div class="scrim" aria-hidden="true"></div>
          {#if logo}
            <img
              class="logo"
              class:loaded={logoLoaded}
              src={logo}
              alt=""
              decoding="async"
              onload={() => (logoLoaded = true)}
            />
          {/if}
          <span class="name" class:replaced={logoLoaded}>{media.title}</span>
        {/if}

        {#if progress > 0}
          <div class="progress" aria-hidden="true">
            <span style:width="{progress}%"></span>
          </div>
        {/if}
      </div>
    </button>

    {#if expanded}
      <div class="panel">
        <div class="actions">
          <button class="round primary" onclick={(e) => { stop(e); onselect?.(media) }} title="Play">
            ▶
          </button>
          <button class="round" onclick={toggleSaved} title={saved ? 'In your watchlist' : 'Add to watchlist'}>
            {saved ? '✓' : '+'}
          </button>
          {#if media.type === 'tv'}
            <button class="round" onclick={toggleTracked} title={tracked ? 'Tracking releases' : 'Track releases'}>
              {#if tracked}<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a5 5 0 0 0-5 5v3.6L5.6 15h12.8L17 11.6V8a5 5 0 0 0-5-5z"/><path d="M10 18a2 2 0 0 0 4 0"/></svg>{:else}<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a5 5 0 0 0-5 5v3.6L5.6 15h12.8L17 11.6V8a5 5 0 0 0-5-5z"/><path d="M10 18a2 2 0 0 0 4 0"/><path d="M4 3.5l16 17"/></svg>{/if}
            </button>
          {/if}
          <button class="round more" onclick={(e) => { stop(e); onselect?.(media) }} title="More info">
            ⌄
          </button>
        </div>

        <div class="meta">
          <Score rating={media.rating} />
          {#if label}<span>{label}</span>{/if}
          <span class="kind">{media.type === 'tv' ? 'Series' : 'Film'}</span>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .card {
    position: relative;
    width: var(--card-width);
    aspect-ratio: var(--card-ratio);
    flex: 0 0 auto;
  }

  /**
   * The growing box. Absolutely positioned so widening it cannot reflow the
   * row — the neighbours stay exactly where they are and the card floats over
   * them, which is what Netflix does.
   */
  .inner {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    border-radius: var(--radius-md);
    background: var(--bg-raised);
    transition:
      width var(--dur-slow) var(--ease-pop),
      transform var(--dur-slow) var(--ease-pop),
      box-shadow var(--dur-slow) var(--ease-pop);
  }

  /**
   * One variable drives both the width and the centring transform, so the two
   * cannot drift apart — a card whose transform assumed a different scale from
   * its width grows off-centre, which reads as a glitch rather than a size.
   *
   * Two steps on the same axis. Hovering says "you are pointing at this"; a
   * running preview says "this is the thing you are looking at now", and the
   * extra room makes the row read as one focused card rather than a grid of
   * equals. Neither reflows the neighbours — `.inner` is out of flow.
   */
  .card {
    --card-active-scale: 1;
  }

  .card.expanded {
    --card-active-scale: var(--card-hover-scale);
  }

  .card.playing {
    --card-active-scale: var(--card-play-scale);
  }

  .card.expanded .inner {
    width: calc(var(--card-width) * var(--card-active-scale));
    z-index: 40;
    box-shadow: var(--shadow-lg);
    background: var(--bg-elevated);
  }

  .card.playing .inner {
    z-index: 41;
  }

  /* Grow from the centre, except at the row edges where that would push the
     card out of the scroll container and clip it. */
  .card.expanded[data-anchor='center'] .inner {
    transform: translateX(calc(var(--card-width) * (1 - var(--card-active-scale)) / 2))
      translateY(calc(var(--card-height) * (1 - var(--card-active-scale)) / 2));
  }

  .card.expanded[data-anchor='start'] .inner,
  .card.expanded[data-anchor='end'] .inner {
    transform: translateY(
      calc(var(--card-height) * (1 - var(--card-active-scale)) / 2)
    );
  }

  .card.expanded[data-anchor='end'] .inner {
    left: auto;
    right: 0;
  }

  .hit {
    display: block;
    width: 100%;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
  }

  .art {
    position: relative;
    width: 100%;
    aspect-ratio: var(--card-ratio);
    overflow: hidden;
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
  }

  .card.expanded .art {
    border-radius: var(--radius-md) var(--radius-md) 0 0;
  }

  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  /**
   * A portrait poster in a landscape frame.
   *
   * Letterboxing it whole looked worse than cropping: a 2:3 poster inside a
   * 16:9 box becomes a narrow strip with wide black bars, and a row of those
   * beside real backdrops reads as broken. Cropping from the upper third keeps
   * the part of a poster that carries the title and the faces.
   */
  .art img.contain {
    object-fit: cover;
    object-position: center 28%;
  }

  .scrim {
    position: absolute;
    inset: 0;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.82) 0%, transparent 52%);
    pointer-events: none;
  }

  .name {
    font-family: var(--font-display);
    letter-spacing: var(--tracking-snug);
    position: absolute;
    left: var(--space-3);
    right: var(--space-3);
    bottom: var(--space-2);
    color: var(--text-primary);
    font-size: var(--text-sm);
    font-weight: 700;
    text-align: left;
    text-shadow: 0 2px 8px rgba(0, 0, 0, 0.9);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    pointer-events: none;
  }

  /*
    Where the name was, capped both ways so a long flat logo and a stacked one
    both sit in the corner at a readable size. `.art img.logo`, not `.logo`:
    the artwork rule above sizes every image in the frame to fill it.

    The shadow is what keeps a dark logo readable on a dark backdrop; the scrim
    only darkens the bottom edge, and logos come in every colour.
  */
  .art img.logo {
    position: absolute;
    left: var(--space-3);
    bottom: var(--space-3);
    width: auto;
    height: auto;
    max-width: 55%;
    max-height: 38%;
    object-fit: contain;
    object-position: left bottom;
    filter: drop-shadow(0 1px 6px rgba(0, 0, 0, 0.75));
    opacity: 0;
    transition: opacity var(--dur-mid) var(--ease-out);
    pointer-events: none;
  }

  .art img.logo.loaded {
    opacity: 1;
  }

  .name {
    transition: opacity var(--dur-mid) var(--ease-out);
  }

  .name.replaced {
    opacity: 0;
  }

  .progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 3px;
    background: rgba(255, 255, 255, 0.24);
  }

  .progress span {
    display: block;
    height: 100%;
    background: var(--accent);
  }

  .panel {
    padding: var(--space-3);
    border-radius: 0 0 var(--radius-md) var(--radius-md);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .round {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 1px solid var(--border-strong);
    background: rgba(255, 255, 255, 0.06);
    color: var(--text-primary);
    font-size: var(--text-sm);
    cursor: pointer;
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }

  .round:hover {
    background: rgba(255, 255, 255, 0.16);
    border-color: var(--text-primary);
  }

  .round.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--text-on-accent);
  }

  .round.primary:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }

  /* Pushed to the right, away from the play/add cluster. */
  .round.more {
    margin-left: auto;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-3);
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .kind {
    padding: 1px var(--space-2);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    color: var(--text-tertiary);
  }

  .placeholder {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    color: var(--text-tertiary);
    font-size: var(--text-2xl);
    font-weight: 700;
  }

  @media (prefers-reduced-motion: reduce) {
    .inner {
      transition: none;
    }
  }

  /* Stroked line icon, inheriting the button's colour so it reads as chrome
     rather than as an image dropped into the label. */
  .glyph {
    width: 1.05em;
    height: 1.05em;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
    vertical-align: -0.18em;
  }
</style>
