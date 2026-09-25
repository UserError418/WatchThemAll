<script lang="ts">
  /**
   * The title detail overlay — backdrop hero, actions, and season browsing.
   *
   * Opens over whatever surface the user was on rather than replacing it, so
   * closing it returns them to their exact scroll position in a browse row.
   * The original navigated away and rebuilt the dashboard from scratch.
   *
   * Only the selected season's episodes are fetched. A long-running series has
   * twenty seasons and the user is looking at one of them.
   */
  import type { MediaDetail, MediaSummary, Season } from '@shared/types'
  import { library } from '../lib/library.svelte'
  import { previewAudio, previewId } from '../lib/preview.svelte'
  import SourcePicker from './SourcePicker.svelte'
  import RateButtons from './RateButtons.svelte'
  import { backdropUrl, posterUrl } from '../lib/images'
  import { airDate, countdown, episodeCode, hasAired, runtime, year } from '../lib/format'
  import EpisodeRow from './EpisodeRow.svelte'
  import TrailerEmbed from './TrailerEmbed.svelte'
  import { modalIn, modalOut, scrimIn, scrimOut } from '../lib/motion'
  import { episodeToPlay, resumeTarget, type EpisodeRef } from '@shared/progress'
  import { resumeAnchor } from '../lib/watchlistrank'
  import Score from './Score.svelte'
  import { seasonScore } from '@shared/score'

  interface Props {
    media: MediaSummary
    onclose: () => void
  }

  const { media, onclose }: Props = $props()

  /**
   * The title actually being shown.
   *
   * Search results from IMDB carry `tmdbId: 0` — IMDB does not know TMDB's
   * ids. Everything this overlay displays comes from TMDB, so such a result
   * has to be bridged through `/find` before anything can be loaded. `subject`
   * is that resolved form; `media` stays as the prop it was handed.
   *
   * Seeded from `media` so the first render has something to show before the
   * bridge resolves; the effect below re-seeds it whenever a different title
   * is opened, which is what keeps the two in step.
   */
  // svelte-ignore state_referenced_locally
  let subject = $state<MediaSummary>(media)


  let detail = $state<MediaDetail | null>(null)
  let season = $state<Season | null>(null)
  /**
   * The season the user's position is in, which need not be the one on screen.
   * See `resumeAt` — "Resume" must not change its answer with the season picker.
   */
  let resumeSeason = $state<Season | null>(null)
  let selectedSeason = $state(1)
  let loadingDetail = $state(true)
  let loadingSeason = $state(false)
  let error = $state<string | null>(null)
  let playError = $state<string | null>(null)

  /**
   * TMDB has no record of this title, but we know its IMDB id.
   *
   * This is not an error state — it is most of the anime catalogue. IMDB
   * carries titles TMDB has never heard of, or files them under a name the
   * `/find` endpoint will not match, and the original app played them happily
   * because providers key on the IMDB id and never needed TMDB at all.
   * Refusing to show anything was a regression: everything except the episode
   * list still works.
   */
  let degraded = $state(false)

  /** Season/episode to play when there is no episode list to pick from. */
  let manualSeason = $state(1)
  let manualEpisode = $state(1)

  const inWatchlist = $derived(library.isInWatchlist(subject.tmdbId))
  const tracked = $derived(library.isTracked(subject.tmdbId))
  /**
   * Whether the thing the button is about has been watched.
   *
   * For a film that is the film. For a series it is *the selected season* —
   * which is the whole point of the change: "I have watched this" about a
   * nine-season show, said while looking at season one, used to file all nine.
   */
  const seen = $derived(
    subject.type === 'movie'
      ? library.hasSeen(subject.tmdbId)
      : library.hasSeenSeason(subject.tmdbId, selectedSeason),
  )
  const entry = $derived(library.watchlistEntry(subject.tmdbId))
  const backdrop = $derived(backdropUrl(detail?.backdropPath ?? subject.backdropPath))
  const poster = $derived(posterUrl(detail?.posterPath ?? subject.posterPath, 'w342'))

  /** Seasons are 1..n; TMDB's season 0 is specials and is deliberately hidden. */
  const seasonNumbers = $derived(
    Array.from({ length: detail?.seasonCount ?? 0 }, (_, i) => i + 1),
  )

  const progress = $derived.by(() => {
    if (!detail || detail.type !== 'tv' || !detail.episodeCount) return 0
    return Math.min(100, Math.round((library.watchedCount(subject.tmdbId) / detail.episodeCount) * 100))
  })

  $effect(() => {
    const opened = media
    subject = opened
    void openTitle(opened)
  })

  async function openTitle(opened: MediaSummary): Promise<void> {
    loadingDetail = true
    error = null

    degraded = false
    detail = null
    season = null
    resumeSeason = null

    if (opened.tmdbId === 0) {
      try {
        // `$state.snapshot` because Svelte's proxies cannot cross the IPC
        // boundary — `structuredClone` throws on them.
        const bridged = await window.wta.resolve($state.snapshot(opened))
        if (bridged) {
          subject = bridged
          await loadDetail(bridged.tmdbId, bridged.type)
          return
        }
      } catch (err) {
        console.warn('[detail] could not bridge to TMDB:', err)
      }

      // No TMDB record. Show what IMDB gave us and let it play anyway — the
      // provider only needs the IMDB id, which is the one thing we do have.
      degraded = Boolean(opened.imdbId)
      if (!degraded) {
        error = 'This title has no IMDB id, so no provider can play it.'
      }
      manualSeason = anchor.season
      manualEpisode = anchor.episode
      loadingDetail = false
      return
    }

    await loadDetail(opened.tmdbId, opened.type)
  }

  async function loadDetail(tmdbId: number, type: MediaSummary['type']): Promise<void> {
    loadingDetail = true
    error = null
    try {
      const result = await window.wta.tmdb.detail(tmdbId, type)
      if (!result) {
        error = 'TMDB has no record of this title.'
        return
      }
      detail = result
      // Persist the IMDB id: providers key off it, and re-resolving it on
      // every play is a wasted round trip.
      library.attachImdbId(tmdbId, result.imdbId)
      // Lets the watchlist draw a real progress bar without a request per tile.
      if (type === 'tv') library.setEpisodeCount(tmdbId, result.episodeCount)
      library.setRating(tmdbId, result.rating)

      if (type === 'tv' && result.seasonCount > 0) {
        // Open where the user is rather than always at season one: first the
        // season their position is in, which is what `resumeAt` needs...
        selectedSeason = Math.min(anchor.season, result.seasonCount)
        await loadSeason(selectedSeason)
        // ...then, if that season is finished and Resume moves on to the next,
        // that one — so the row the button names is the one on screen.
        if (resumeAt.season !== selectedSeason) {
          selectedSeason = resumeAt.season
          await loadSeason(selectedSeason)
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not load this title'
    } finally {
      loadingDetail = false
    }
  }

  async function loadSeason(number: number): Promise<void> {
    loadingSeason = true
    try {
      const loaded = await window.wta.tmdb.season(subject.tmdbId, number)
      season = loaded
      if (loaded?.season === anchor.season) resumeSeason = loaded
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not load this season'
    } finally {
      loadingSeason = false
    }
  }

  function selectSeason(number: number): void {
    selectedSeason = number
    void loadSeason(number)
  }

  /**
   * Seasons already reconciled against the Watched list, as `tmdbId:season`.
   *
   * A plain record rather than a `SvelteSet`, and deliberately so: this must
   * *not* be reactive. The effect below both reads it and writes to it, so a
   * tracked read would re-trigger the effect on its own write. Nothing renders
   * from it either — it is a guard, not state.
   */
  const reconciled: Record<string, true> = {}

  /**
   * A series in the Watched tab has its episodes ticked off when you open it.
   *
   * Watched holds whole titles while the episode browser holds individual
   * episodes, and nothing joined the two — so a MyAnimeList import of 212
   * completed shows filed every one of them as watched and then showed every
   * episode unwatched.
   *
   * Done here, on the season the user is actually looking at, rather than at
   * import time: marking episodes needs the episode list, and fetching one per
   * title would have been hundreds of TMDB requests for lists nobody had asked
   * to see. Here the list is already loaded because it is on screen.
   *
   * It writes real episode keys rather than deriving the answer, so unticking
   * one afterwards behaves normally. `reconciled` is what makes that stick: the
   * effect re-runs when the watchlist changes, and without the guard it would
   * put back every episode the user had just unticked.
   */
  $effect(() => {
    const loaded = season
    if (!loaded || subject.type !== 'tv') return
    if (!library.hasSeenSeason(subject.tmdbId, loaded.season)) return

    const key = `${subject.tmdbId}:${loaded.season}`
    if (reconciled[key]) return
    reconciled[key] = true

    const missing = loaded.episodes
      .filter((e) => !library.isWatched(subject.tmdbId, e.season, e.episode))
      .map((e) => e.episode)
    if (missing.length === 0) return

    // Episode state lives on the watchlist entry, so a title that reached
    // Watched without ever being in the watchlist needs one to write into.
    if (!library.isInWatchlist(subject.tmdbId)) library.addToWatchlist(detail ?? subject)
    library.setSeasonWatched(subject.tmdbId, loaded.season, missing, true)
  })

  /**
   * Which provider will serve this title: the per-title choice if there is one,
   * otherwise the global default, otherwise `null` meaning "let the app pick".
   */
  const chosenProvider = $derived(entry?.providerId ?? library.settings.defaultProviderId)

  function chooseProvider(providerId: string | null): void {
    library.setEntryProvider(playable, providerId)
    // A failed attempt against the previous provider is no longer relevant.
    playError = null
  }

  /**
   * The identity playback needs, from whichever source has it.
   *
   * `detail` when TMDB knows the title; the IMDB-sourced summary when it does
   * not. Providers key on the IMDB id, so a degraded title is just as playable
   * as a fully-resolved one.
   */
  const playable = $derived(detail ?? { ...subject, imdbId: subject.imdbId ?? null })

  async function play(episode: (EpisodeRef & { runtime?: number | null }) | null): Promise<void> {
    playError = null

    const result = await window.wta.play({
      tmdbId: playable.tmdbId,
      imdbId: playable.imdbId ?? null,
      type: playable.type,
      title: playable.title,
      season: episode?.season ?? null,
      episode: episode?.episode ?? null,
      providerId: chosenProvider,
      /**
       * The episode's own runtime when TMDB has it, the show's typical episode
       * length otherwise.
       *
       * Main needs it to judge whether half of this was watched, and it keeps
       * the figure across episode steps — the bar's steppers move without the
       * renderer's involvement, so a per-episode number would go stale on the
       * first press of next.
       */
      runtimeMinutes: episode?.runtime ?? detail?.runtime ?? null,
    })

    if (!result.ok) {
      playError = result.error ?? 'Could not open a player'
      return
    }

    // Playing something implies wanting it in the library. Watched is a
    // separate question, settled on the way out from how long it ran.
    if (!library.isInWatchlist(playable.tmdbId)) library.addToWatchlist(playable)
    library.recordWatch(playable, episode?.season ?? null, episode?.episode ?? null)
  }

  /**
   * Where the user is in this series: the further of the episode last played
   * and the episode last marked watched.
   *
   * The same anchor the watchlist card uses, so the two agree. Reading
   * `lastSeason`/`lastEpisode` alone is what this view used to do, and those
   * move only when an episode is opened in the app's own player — so a series
   * with seasons ticked off by hand kept offering to resume from before them.
   */
  const anchor = $derived<EpisodeRef>(entry ? resumeAnchor(entry) : { season: 1, episode: 1 })

  /**
   * Where this series picks up.
   *
   * Derived rather than read straight off the entry: the anchor is very often
   * an episode that was then finished — and a finished episode is not a place
   * to resume. See `shared/progress.ts` for the rule and for the write race it
   * sidesteps.
   *
   * Worked out from the anchor's own season, `resumeSeason`, never from the
   * season on screen. Otherwise the button changed its answer as the user
   * browsed: `resumeTarget` only trusts a listing of the anchor's season, and
   * given any other it falls back to the anchor itself.
   */
  const resumeAt = $derived(
    resumeTarget({
      episodes: resumeSeason?.season === anchor.season ? resumeSeason.episodes : [],
      lastSeason: anchor.season,
      lastEpisode: anchor.episode,
      seasonCount: detail?.seasonCount ?? 1,
      isWatched: (s, e) => library.isWatched(subject.tmdbId, s, e),
    }),
  )

  /**
   * Keeps `resumeSeason` on the anchor's season when the anchor moves.
   *
   * It moves when the user ticks or clears episodes, and "Clear season" can
   * move it back into a season nobody has loaded. The initial load needs none
   * of this — `loadSeason` fills `resumeSeason` in when it fetches the
   * anchor's season — hence the early return while that fetch is in flight.
   */
  $effect(() => {
    if (detail?.type !== 'tv') return
    const wanted = anchor.season
    if (resumeSeason?.season === wanted) return
    if (loadingSeason && selectedSeason === wanted) return

    const tmdbId = subject.tmdbId
    window.wta.tmdb.season(tmdbId, wanted).then(
      (loaded) => {
        if (loaded && subject.tmdbId === tmdbId && anchor.season === wanted) resumeSeason = loaded
      },
      () => {
        // Without the listing, `resumeTarget` stays on the anchor episode
        // itself: not the best answer, but never a wrong one.
      },
    )
  })

  /** Play exactly the episode the button names. */
  function resume(): void {
    if (playable.type === 'movie') {
      void play(null)
      return
    }
    if (degraded) {
      // No episode list to resume from — use the numbers the user picked.
      void play({ season: manualSeason, episode: manualEpisode })
      return
    }
    void play(episodeToPlay(resumeAt, [resumeSeason?.episodes ?? [], season?.episodes ?? []]))
  }

  /** What pressing "+ Watched" will actually file, in words. */
  const watchedScopeLabel = $derived(
    subject.type === 'movie' ? 'Watched' : `Season ${selectedSeason} watched`,
  )

  /**
   * Mark what is on screen as watched, or take it back.
   *
   * For a series this files the selected season and ticks off its episodes, so
   * the Watched tab and the episode browser agree — they disagreeing is the
   * original fault here, and it is why a MyAnimeList import of completed shows
   * showed every episode unwatched.
   */
  function toggleSeen(): void {
    const media = detail ?? subject
    if (subject.type === 'movie') {
      if (seen) library.removeFromWatched(subject.tmdbId)
      else library.addToWatched(media)
      return
    }

    if (seen) {
      library.removeFromWatched(subject.tmdbId, selectedSeason)
      return
    }

    library.addToWatched(media, 'user', selectedSeason)
    if (season) toggleSeasonWatched(true)
  }

  function toggleSeasonWatched(watched: boolean): void {
    if (!season) return
    if (!library.isInWatchlist(subject.tmdbId)) library.addToWatchlist(detail ?? subject)
    library.setSeasonWatched(
      subject.tmdbId,
      selectedSeason,
      season.episodes.map((e) => e.episode),
      watched,
    )
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') onclose()
  }
  /**
   * The one episode in this season that gets a live countdown, and the clock
   * that drives it.
   *
   * One interval for the whole list, and only while there is something to count
   * down to — a per-row timer on a 24-episode season is 24 intervals firing
   * forever for a season that finished airing in 2019.
   */
  const nextUnaired = $derived(
    season?.episodes.find((e) => e.airDate && !hasAired(e.airDate))?.episode ?? null,
  )
  let now = $state(Date.now())

  /**
   * The billboard preview.
   *
   * Same gesture as the browse hero, for the same reason: the overlay is where
   * the user decides whether to watch this, and a moving preview answers that
   * faster than a synopsis. It waits a beat so the title, facts and buttons can
   * be read against a still frame before motion starts competing with them.
   */
  let showHeroTrailer = $state(false)
  const audioId = previewId('detail')
  /**
   * The overlay is modal, so it takes the sound outright while it is open and
   * gives it back on close — nothing underneath it can be interacted with, and
   * a browse billboard still audible behind a detail view is just noise.
   */
  /**
   * Whether this hero plays out loud.
   *
   * There is no local switch any more — the one in the nav governs every
   * preview surface, and a second control that looked different and meant the
   * same thing was the confusing half of the pair.
   */
  const heroMuted = $derived(!library.settings.previewAudio || !previewAudio.holds(audioId))



  $effect(() => {
    // Re-runs whenever a different title's detail lands, which is exactly when
    // the previous title's trailer must stop.
    const key = detail?.trailerKey
    showHeroTrailer = false
    if (!key) return

    /**
     * Short, because opening a title is a deliberate act.
     *
     * This was 1.8s, from when the trailer appeared behind an opaque still that
     * took seconds more to fade — the wait was hidden inside a longer one. With
     * the still gone the delay is the whole cost, and the user has already told
     * us which title they want by opening it. What is left is just enough for
     * the artwork and text to paint first, so the panel does not assemble
     * itself around a video that arrived before it.
     */
    const timer = setTimeout(() => {
      showHeroTrailer = true
      previewAudio.claim(audioId)
    }, 350)

    return () => {
      clearTimeout(timer)
      previewAudio.release(audioId)
    }
  })

  $effect(() => {
    if (nextUnaired === null) return
    // Minute granularity: `countdown` never renders anything finer.
    const timer = setInterval(() => (now = Date.now()), 60_000)
    return () => clearInterval(timer)
  })

</script>

<svelte:window onkeydown={onKeydown} />

<div class="scrim" in:scrimIn out:scrimOut>
  <!--
    A real button as the click-catcher rather than a click handler on the
    scrim div: it keeps the "click outside to close" affordance without
    claiming a role the element does not have. It is out of the tab order
    because the visible close button and Escape are the keyboard paths.
  -->
  <button class="scrim-catch" onclick={onclose} tabindex="-1" aria-hidden="true"></button>

  <div
    class="panel"
    in:modalIn
    out:modalOut
    class:film={playable.type === 'movie'}
    role="dialog"
    aria-modal="true"
    aria-label={subject.title}
  >
    <header class="hero" style:background-image={backdrop ? `url("${backdrop}")` : undefined}>
      <button class="close" onclick={onclose} aria-label="Close">✕</button>

      {#if showHeroTrailer && detail?.trailerKey && !previewAudio.suspended}
        <TrailerEmbed
          videoKey={detail.trailerKey}
          muted={heroMuted}
          title="{subject.title} trailer"
        />
      {/if}

      <div class="hero-fade"></div>

      <div class="hero-content">
        {#if poster}
          <img class="poster" src={poster} alt="" width="140" height="210" />
        {/if}
        <div class="hero-text">
          <h1>{detail?.title ?? subject.title}</h1>
          <p class="facts">
            {#if year(detail?.releaseDate ?? subject.releaseDate)}
              <span>{year(detail?.releaseDate ?? subject.releaseDate)}</span>
            {/if}
            {#if detail?.status}<span>{detail.status}</span>{/if}
            {#if detail?.seasonCount}
              <span>{detail.seasonCount} season{detail.seasonCount === 1 ? '' : 's'}</span>
            {/if}
            {#if detail?.runtime}<span>{runtime(detail.runtime)}</span>{/if}
            <Score rating={detail?.rating ?? subject.rating} size="md" />
          </p>
          {#if detail?.genres.length}
            <p class="genres">{detail.genres.join(' · ')}</p>
          {/if}

          <div class="actions">
            <button class="primary" onclick={resume} disabled={!detail}>
              ▶ {entry && detail?.type === 'tv' ? `Resume ${episodeCode(resumeAt.season, resumeAt.episode)}` : 'Play'}
            </button>
            <!--
              `episode` is the one the Play button would start, so a scan
              measures what the user is about to watch. Coverage is
              episode-level — a provider carrying season one and not season four
              is the ordinary case — and a TV request with no episode renders no
              URL at all, which would mark every source dead.
            -->
            <SourcePicker
              selected={chosenProvider}
              media={{ type: subject.type, imdbId: detail?.imdbId ?? subject.imdbId ?? null, tmdbId: subject.tmdbId }}
              episode={subject.type === 'movie'
                ? null
                : { season: resumeAt.season, episode: resumeAt.episode }}
              onselect={chooseProvider}
            />
            <button
              class="secondary"
              onclick={() =>
                inWatchlist
                  ? library.removeFromWatchlist(subject.tmdbId)
                  : library.addToWatchlist(detail ?? subject)}
            >
              {inWatchlist ? '✓ In Watchlist' : '+ Watchlist'}
            </button>
            {#if (detail?.type ?? subject.type) === 'tv'}
              <button
                class="secondary"
                onclick={() =>
                  tracked ? library.removeTracker(subject.tmdbId) : library.addTracker(detail ?? subject)}
                title="Get notified when new episodes air"
              >
                {#if tracked}✓ Tracking Releases{:else}<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a5 5 0 0 0-5 5v3.6L5.6 15h12.8L17 11.6V8a5 5 0 0 0-5-5z"/><path d="M10 18a2 2 0 0 0 4 0"/></svg> Track Releases{/if}
              </button>
            {/if}

            <!--
              Seen it, and what you thought.

              Together rather than apart, because they are one thought: the
              rating is only meaningful about something already watched, and
              putting the two side by side is what makes rating something the
              user does in passing rather than a chore on another screen.
            -->
            <button
              class="secondary"
              class:on={seen}
              onclick={() => toggleSeen()}
              title={seen ? 'In your watched list' : watchedScopeLabel}
            >
              {seen ? '✓ Watched' : `+ ${watchedScopeLabel}`}
            </button>

            {#if seen}
              <!-- Scoped to match the button beside it: an opinion about season
                   three is a different thing from an opinion about the show. -->
              <RateButtons
                media={detail ?? subject}
                season={subject.type === 'movie' ? null : selectedSeason}
              />
            {/if}
          </div>

          {#if playError}
            <p class="play-error" role="alert">{playError}</p>
          {/if}

          {#if detail?.nextEpisode?.airDate}
            <p class="next">
              Next: {episodeCode(detail.nextEpisode.season, detail.nextEpisode.episode)}
              {detail.nextEpisode.name ? `· ${detail.nextEpisode.name}` : ''}
              · {airDate(detail.nextEpisode.airDate)}
              <strong>in {countdown(detail.nextEpisode.airDate)}</strong>
            </p>
          {/if}
        </div>
      </div>
    </header>

    <div class="body">
      {#if error}
        <p class="state error" role="alert">{error}</p>
      {:else if loadingDetail}
        <p class="state">Loading…</p>
      {:else if degraded}
        <!--
          TMDB does not carry this title. Everything except the episode list
          still works, because providers key on the IMDB id.
        -->
        {#if subject.overview}
          <p class="overview">{subject.overview}</p>
        {/if}

        <p class="degraded-note">
          TMDB has no entry for this title, so there are no episode listings or
          air dates for it. It will still play — pick the episode below, or use
          the arrow keys in the player window to move through them.
        </p>

        {#if subject.type === 'tv'}
          <div class="manual">
            <label>
              <span>Season</span>
              <input type="number" min="1" bind:value={manualSeason} />
            </label>
            <label>
              <span>Episode</span>
              <input type="number" min="1" bind:value={manualEpisode} />
            </label>
            <button
              class="manual-play"
              onclick={() => play({ season: manualSeason, episode: manualEpisode })}
            >
              ▶ Play {episodeCode(manualSeason, manualEpisode)}
            </button>
          </div>
        {/if}
      {:else if detail}
        {#if detail.overview}
          <p class="overview">{detail.overview}</p>
        {/if}

        {#if detail.type === 'tv' && seasonNumbers.length > 0}
          {#if entry && detail.episodeCount}
            <div class="progress" aria-label="Watch progress">
              <div class="bar"><div class="fill" style:width="{progress}%"></div></div>
              <span>{library.watchedCount(subject.tmdbId)} / {detail.episodeCount} episodes</span>
            </div>
          {/if}

          <div class="season-bar">
            <label>
              <span class="sr-only">Season</span>
              <select
                value={selectedSeason}
                onchange={(e) => selectSeason(Number(e.currentTarget.value))}
              >
                {#each seasonNumbers as number (number)}
                  <option value={number}>Season {number}</option>
                {/each}
              </select>
            </label>
            <!-- Averaged from the episodes: TMDB has no season score in the
                 payload this app fetches, and asking for one would be a request
                 per season purely to draw a number. -->
            <Score rating={seasonScore(season?.episodes ?? [])} size="md" />
            <div class="bulk">
              <button onclick={() => toggleSeasonWatched(true)}>Mark season watched</button>
              <button onclick={() => toggleSeasonWatched(false)}>Clear season</button>
            </div>
          </div>

          {#if loadingSeason}
            <p class="state">Loading season {selectedSeason}…</p>
          {:else if season}
            <div class="episodes">
              {#each season.episodes as episode (episode.episode)}
                <EpisodeRow
                  {episode}
                  {now}
                  next={episode.episode === nextUnaired}
                  progress={library.episodeProgress(subject.tmdbId, episode.season, episode.episode)}
                  watched={library.isWatched(subject.tmdbId, episode.season, episode.episode)}
                  current={resumeAt.season === episode.season &&
                    resumeAt.episode === episode.episode}
                  onplay={(e) => play(e)}
                  ontoggleWatched={(e, watched) => {
                    if (!library.isInWatchlist(subject.tmdbId)) library.addToWatchlist(detail ?? subject)
                    library.setWatched(subject.tmdbId, e.season, e.episode, watched)
                  }}
                />
              {/each}
            </div>
          {/if}
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    justify-content: center;
    padding: var(--space-6) var(--space-4);
    background: var(--bg-scrim);
    overflow-y: auto;
    cursor: default;
  }

  .scrim-catch {
    position: fixed;
    inset: 0;
    cursor: default;
  }

  .panel {
    position: relative;
    width: min(1040px, 100%);
    height: fit-content;
    background: var(--bg-raised);
    border-radius: var(--radius-lg);
    overflow: hidden;
    box-shadow: var(--shadow-pop);
  }

  /*
    A film gets a bigger box, because it has less to put in it.

    The width below is sized for a series: under the hero sits a season picker
    and a list of episodes, and past about 1040px those rows stretch into
    unreadably long lines. A film has none of that — the hero is followed by a
    paragraph of overview and nothing else — so the same width leaves a band of
    empty panel under the preview and a preview smaller than it needed to be.
    Wider and taller spends that space on the only thing on the screen worth
    looking at.
  */
  .panel.film {
    width: min(1320px, 100%);
  }

  .panel.film .hero {
    max-height: 78vh;
  }

  /**
   * The billboard, laid out the way Netflix does it.
   *
   * The preview owns the whole box and the metadata sits **over its lower
   * third**, rather than the metadata occupying a band at the top with the
   * video squeezed into whatever was left. Two things follow from that: the
   * preview is as large as the modal allows, and the title, poster and buttons
   * read against the darkest part of the gradient instead of competing with
   * moving footage behind them.
   *
   * Sized by `aspect-ratio`, not `min-height`.
   *
   * The obvious `min-height: calc(<modal width> * 9 / 16)` is silently invalid:
   * a percentage inside a `min-height` calc resolves against the parent's
   * *height*, not its width, so the whole declaration is dropped and the hero
   * collapses to exactly the height of its content — leaving no visible preview
   * at all, which looks like the video failing to load.
   *
   * `aspect-ratio` derives height from the width the panel already has.
   * `max-height` keeps a short window from pushing the episode list off-screen,
   * and `min-height` guarantees the content has somewhere to sit when it does.
   */
  .hero {
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    /* `width: 100%` is load-bearing. With an auto width, `max-height` clamping
       the box makes `aspect-ratio` shrink the *width* to keep the ratio — the
       hero came out 750px wide inside a 982px panel, with dead space beside the
       preview. Pinning the width leaves height as the only derived dimension. */
    width: 100%;
    aspect-ratio: 16 / 9;
    max-height: 62vh;
    min-height: 340px;
    background-color: var(--bg-elevated);
    background-size: cover;
    background-position: center 20%;
  }

  /* Top-right, opposite the close button: the bottom is the content's now. */
  /**
   * Weighted to the bottom, because that is where the text now is.
   *
   * Opaque under the content and almost clear over the top two-thirds, so the
   * preview is genuinely visible rather than being viewed through a scrim. The
   * final stop reaches the panel background exactly, or the seam between the
   * hero and the body shows as a band.
   */
  .hero-fade {
    position: absolute;
    inset: 0;
    /* Above the video, so the title stays readable over moving footage. */
    pointer-events: none;
    background: linear-gradient(
      to top,
      var(--bg-raised) 0%,
      rgb(var(--bg-raised-rgb) / 0.94) 26%,
      rgb(var(--bg-raised-rgb) / 0.55) 55%,
      rgb(var(--bg-raised-rgb) / 0.15) 100%
    );
  }

  .hero-content {
    position: relative;
    display: flex;
    align-items: flex-end;
    gap: var(--space-5);
    /* Generous top padding is what pushes the content down onto the gradient
       while leaving the preview above it uncovered. */
    padding: var(--space-8) var(--space-6) var(--space-5);
  }

  .poster {
    width: 140px;
    /*
      The ratio comes from CSS, not from the `width`/`height` attributes.
      Those give the right shape only while the CSS width matches the attribute
      width — and the narrow breakpoint below overrides the width alone, which
      left the image 100px wide and still 210px tall. `object-fit` defaults to
      `fill` on an <img>, so that was a 29% vertical stretch rather than a crop:
      a visibly elongated poster on every window under 720px, phone included.
    */
    aspect-ratio: var(--poster-ratio);
    height: auto;
    object-fit: cover;
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-card);
    flex: 0 0 auto;
  }

  h1 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-2xl);
    line-height: 1.15;
  }

  .facts,
  .genres {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    margin: 0 0 var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }

  .actions button {
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 600;
    transition: background var(--dur-fast) var(--ease-out);
  }

  .primary {
    background: var(--accent);
    color: var(--text-on-media);
  }
  .primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }
  .primary:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .secondary {
    background: var(--bg-elevated);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
  }
  .secondary:hover {
    background: var(--bg-hover);
  }

  .degraded-note {
    max-width: 62ch;
    margin: var(--space-4) 0 0;
    padding: var(--space-3);
    border: 1px solid var(--border-subtle);
    border-left: 3px solid var(--warning);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: var(--text-sm);
    line-height: 1.55;
  }

  .manual {
    display: flex;
    align-items: flex-end;
    gap: var(--space-3);
    margin-top: var(--space-4);
  }

  .manual label {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }

  .manual input {
    width: 88px;
    padding: var(--space-2);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: var(--text-primary);
    font-size: var(--text-sm);
  }

  .manual-play {
    padding: var(--space-2) var(--space-5);
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--text-on-media);
    font-size: var(--text-sm);
    font-weight: 700;
  }

  .manual-play:hover {
    background: var(--accent-hover);
  }

  .play-error {
    margin: var(--space-3) 0 0;
    font-size: var(--text-sm);
    color: var(--danger);
  }

  .next {
    margin: var(--space-3) 0 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .next strong {
    color: var(--success);
  }

  .close {
    position: absolute;
    top: var(--space-3);
    right: var(--space-3);
    z-index: 1;
    width: 32px;
    height: 32px;
    border-radius: var(--radius-full);
    background: var(--bg-scrim);
    color: var(--text-primary);
  }

  .body {
    padding: var(--space-5) var(--space-6) var(--space-6);
  }

  .overview {
    margin: 0 0 var(--space-5);
    max-width: 76ch;
    color: var(--text-secondary);
    line-height: 1.6;
  }

  .progress {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }

  .bar {
    flex: 1;
    height: 5px;
    border-radius: var(--radius-full);
    background: var(--bg-elevated);
    overflow: hidden;
  }

  .fill {
    height: 100%;
    background: var(--success);
    transition: width var(--dur-mid) var(--ease-out);
  }

  .season-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
    flex-wrap: wrap;
  }

  select {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    font-size: var(--text-sm);
  }

  .bulk {
    display: flex;
    gap: var(--space-2);
  }

  .bulk button {
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }
  .bulk button:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .episodes {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .state {
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }
  .state.error {
    color: var(--danger);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  @media (max-width: 720px) {
    .hero-content {
      flex-direction: column;
      /*
        `flex-end` in the row layout means "sit the poster's bottom edge on the
        text block's baseline". Rotating the axis silently reinterprets it as
        "hug the right edge", which parked the poster in the top-right corner
        while the title underneath stayed left-aligned.
      */
      align-items: flex-start;
      padding: var(--space-6) var(--space-4) var(--space-4);
    }
    .poster {
      width: 100px;
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
