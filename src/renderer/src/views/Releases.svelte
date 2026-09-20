<script lang="ts">
  /**
   * The Releases surface — a schedule, not a list.
   *
   * ## Why a timeline and not History's heatmap
   *
   * They answer different questions and the shapes follow from that. History
   * asks "how much have I watched lately", where no individual event is worth
   * naming and density over time is the whole point — a heat grid. This asks
   * "what airs when", where every single event *is* the point and the exact
   * day matters. So: a spine with real day markers, and a rule for now.
   *
   * ## The axis runs one way, and now is the middle of it
   *
   * Everything on the spine descends through time: furthest ahead at the top,
   * tomorrow immediately above the rule, yesterday immediately below it, then
   * back through the fortnight. The first cut ran upcoming the other way, and
   * the two days either side of this moment — which are the entire reason
   * anyone opens this tab — ended up as far apart as the page could put them.
   *
   * The page therefore opens *anchored on the rule* rather than at its top.
   * Scrolling up is looking further ahead and scrolling down is looking
   * further back, which is the only reading of a vertical time axis that does
   * not need a legend.
   *
   * ## The rail
   *
   * The spine is a column of dated rows and it is bad at three questions: what
   * is literally next, what does the coming week look like as a *week*, and
   * what am I tracking that never appears because it has nothing scheduled.
   * Those are the rail, on the right, where they also take the width a
   * timetable row has no use for.
   *
   * The bucketing, the ordering, the run strips and the window live in
   * `schedule.ts` with their tests, because every interesting case there is a
   * midnight boundary. This file is layout.
   *
   * The countdown ticks from one interval for the whole page rather than one
   * per row: the original kept a Map of timers keyed by element id and leaked
   * them whenever a row re-rendered without being explicitly stopped.
   */
  import type { MediaSummary, ReleaseTracker } from '@shared/types'
  import { library } from '../lib/library.svelte'
  import { posterUrl } from '../lib/images'
  import { countdown, episodeCode, timeAgo } from '../lib/format'
  import {
    buildTimeline,
    countEpisodes,
    nextUp,
    seriesRun,
    trackerRows,
    WINDOWS,
    weekStrip,
    type TimelineEpisode,
  } from '../lib/schedule'
  import { stagger } from '../lib/motion'
  import { fly } from 'svelte/transition'
  import Score from '../components/Score.svelte'

  interface Props {
    onselect: (media: MediaSummary) => void
  }

  const { onselect }: Props = $props()

  /** Drives the countdown text. Updating this re-derives every visible timer. */
  let now = $state(Date.now())
  let windowDays = $state<number>(14)
  let checking = $state(false)
  let checkResult = $state<string | null>(null)
  let showLater = $state(false)

  $effect(() => {
    const interval = setInterval(() => (now = Date.now()), 60_000)
    return () => clearInterval(interval)
  })

  const seen = (tmdbId: number, season: number, episode: number): boolean =>
    library.isWatched(tmdbId, season, episode)

  const timeline = $derived(buildTimeline(library.trackers, { now, windowDays }))
  const upcomingCount = $derived(countEpisodes(timeline.upcoming))
  const laterCount = $derived(countEpisodes(timeline.later))
  const recentCount = $derived(countEpisodes(timeline.recent))

  const soonest = $derived(nextUp(timeline))
  const week = $derived(weekStrip(library.trackers, now))
  const weekPeak = $derived(Math.max(1, ...week.map((day) => day.count)))
  const weekTotal = $derived(week.reduce((total, day) => total + day.count, 0))
  const tracking = $derived(trackerRows(library.trackers, seen, now))
  const behind = $derived(tracking.reduce((total, row) => total + row.unwatched, 0))

  /**
   * Put the now rule on screen on arrival, once.
   *
   * Without this the page opens on the *furthest* scheduled day, which is the
   * least interesting row on it. Once, because the countdown re-renders this
   * component every minute and a scroll that reasserts itself while you are
   * reading is worse than no scroll at all.
   */
  let ruleEl = $state<HTMLElement | null>(null)
  let anchored = false
  $effect(() => {
    const element = ruleEl
    if (anchored || element === null) return
    anchored = true
    // One frame, so the day rows have been laid out and the target is where
    // it will still be a moment later.
    requestAnimationFrame(() => element.scrollIntoView({ block: 'center' }))
  })

  async function checkNow(): Promise<void> {
    if (checking) return
    checking = true
    checkResult = null
    try {
      const { checked, found } = await window.wta.releases.checkNow()
      await library.reload()
      now = Date.now()
      checkResult =
        found > 0 ? `${found} of ${checked} have new episodes` : `Checked ${checked} — nothing new`
    } catch (err) {
      checkResult = err instanceof Error ? err.message : 'Check failed'
    } finally {
      checking = false
    }
  }

  function asMedia(source: {
    tmdbId: number
    title: string
    posterPath: string | null
  }): MediaSummary {
    return {
      tmdbId: source.tmdbId,
      type: 'tv',
      title: source.title,
      posterPath: source.posterPath,
      backdropPath: null,
      overview: '',
      rating: 0,
      releaseDate: null,
      genreIds: [],
    }
  }

  /** What to show when there is no scheduled next episode. */
  function statusLine(tracker: ReleaseTracker): string {
    if (tracker.status === 'Ended') return 'Ended'
    if (tracker.status === 'Canceled') return 'Cancelled'
    if (tracker.status === 'Returning Series') return 'No date yet'
    return tracker.status || 'Listening'
  }

  async function play(episode: {
    tmdbId: number
    title: string
    season: number
    number: number
  }): Promise<void> {
    const saved = library.watchlistEntry(episode.tmdbId)
    await window.wta.play({
      tmdbId: episode.tmdbId,
      imdbId: saved?.imdbId ?? null,
      type: 'tv',
      title: episode.title,
      season: episode.season,
      episode: episode.number,
      providerId: saved?.providerId ?? null,
      runtimeMinutes: null,
    })
  }

  /** The tracker an episode came from, for its run strip. */
  function trackerOf(tmdbId: number): ReleaseTracker | undefined {
    return library.trackers.find((tracker) => tracker.tmdbId === tmdbId)
  }
</script>

<!--
  One row, three times over.

  A snippet rather than three near-identical blocks of markup: before this the
  upcoming, beyond-the-window and recently-aired lists each carried their own
  copy, and a change to the artwork size had to be made three times or it was
  made once and looked like a bug.
-->
{#snippet episodeRow(item: TimelineEpisode, past: boolean)}
  {@const watched = seen(item.tmdbId, item.episode.season, item.episode.episode)}
  {@const tracker = trackerOf(item.tmdbId)}
  {@const run = tracker
    ? seriesRun(tracker, seen, { now, focus: { season: item.episode.season, episode: item.episode.episode } })
    : []}
  {@const outstanding = run.filter((segment) => segment.aired && !segment.seen).length}
  <li>
    <!-- A row, not a button: the actions on its right are buttons themselves,
         and a button cannot contain one. -->
    <div class="episode" class:seen={watched && past}>
      <button class="hit" onclick={() => onselect(asMedia(item))}>
        {#if posterUrl(item.posterPath, 'w154')}
          <img
            class="art"
            src={posterUrl(item.posterPath, 'w154')}
            alt=""
            loading="lazy"
            decoding="async"
            width="68"
            height="102"
          />
        {:else}
          <span class="art blank" aria-hidden="true">{item.title.slice(0, 1)}</span>
        {/if}
        <span class="lines">
          <span class="series">{item.title}</span>
          <span class="ep">
            <span class="code">{episodeCode(item.episode.season, item.episode.episode)}</span>
            {#if item.episode.name}<span class="ep-name">{item.episode.name}</span>{/if}
          </span>
          <!-- Score only. The day marker on the left already carries the
               countdown, and it is the same value for every row under it. -->
          <span class="chips">
            <Score rating={library.scoreFor(item.tmdbId)} />
          </span>
        </span>
      </button>

      <!--
        The run strip: the season this episode belongs to, one segment per
        episode, filled where it has been watched. It is the only thing on the
        page that answers "am I keeping up" without opening anything, and it
        is what the middle of a 1900px row is for.
      -->
      {#if run.length > 1}
        <div class="run" aria-hidden="true">
          <div class="segments">
            {#each run as segment (segment.key)}
              <!--
                A mark on an episode that has not aired is not drawn as
                watched. His library has several — an import numbered its
                seasons the way MyAnimeList does and TMDB numbers them
                differently, so a dozen episodes of one series carry marks
                against dates still in the future. The strip reports what has
                aired and whether it was seen; "seen, but it has not happened
                yet" is not a state it can honestly draw.
              -->
              <span
                class="seg"
                class:aired={segment.aired}
                class:watched={segment.aired && segment.seen}
                class:focus={segment.focus}
              ></span>
            {/each}
          </div>
          <span class="run-note">
            Season {run[0]?.season}
            {#if outstanding > 0}
              <span class="run-behind">· {outstanding} unwatched</span>
            {/if}
          </span>
        </div>
      {:else}
        <span class="run"></span>
      {/if}

      <span class="tail">
        {#if past}
          {#if watched}
            <span class="seen-tag">✓ watched</span>
          {:else}
            <!-- The two actions that matter for something that has already
                 aired and has not been seen. -->
            <button
              class="act"
              onclick={() =>
                void play({
                  tmdbId: item.tmdbId,
                  title: item.title,
                  season: item.episode.season,
                  number: item.episode.episode,
                })}>▶ Play</button
            >
            <button
              class="act ghost"
              onclick={() =>
                library.setWatched(
                  item.tmdbId,
                  item.episode.season,
                  item.episode.episode,
                  true,
                )}
              aria-label="Mark {item.title} {episodeCode(
                item.episode.season,
                item.episode.episode,
              )} watched">✓</button
            >
          {/if}
        {/if}
      </span>
    </div>
  </li>
{/snippet}

{#snippet dayBlock(
  day: { key: string; at: number; label: string; isToday: boolean; episodes: TimelineEpisode[] },
  index: number,
  past: boolean,
  faint: boolean,
)}
  <section class="day" class:today={day.isToday} class:past class:faint in:fly={stagger(index, 16, 8)}>
    <div class="marker">
      <span class="dot" class:pulse={day.isToday}></span>
      <span class="label">{day.label}</span>
      <span class="when">
        {#if past}{timeAgo(day.at, now)}{:else}{countdown(day.episodes[0]?.episode.airDate ?? null, now)}{/if}
      </span>
    </div>
    <ul class="episodes">
      {#each day.episodes as item (item.tmdbId + ':' + item.episode.season + ':' + item.episode.episode)}
        {@render episodeRow(item, past)}
      {/each}
    </ul>
  </section>
{/snippet}

<div class="view">
  <header class="head">
    <div>
      <h2>Releases</h2>
      <p class="lede">
        <!-- "a notification", not "a desktop notification": this renderer is
             also the Android app, where the same sentence was describing a
             platform the reader is not on. -->
        {library.trackers.length} series tracked. New episodes raise a notification when they air.
      </p>
    </div>
    <div class="tools">
      <!-- The window reaches equally in both directions, so it belongs to the
           page rather than to the half it used to sit in. -->
      <div class="windows" role="group" aria-label="How far either side of now to show">
        {#each WINDOWS as days (days)}
          <button class:active={windowDays === days} onclick={() => (windowDays = days)}
            >±{days}d</button
          >
        {/each}
      </div>
      <label class="toggle">
        <input
          type="checkbox"
          checked={library.settings.notificationsEnabled}
          onchange={(e) => library.setNotificationsEnabled(e.currentTarget.checked)}
        />
        Notifications
      </label>
      <button class="check" onclick={checkNow} disabled={checking || library.trackers.length === 0}>
        {checking ? 'Checking…' : '↻ Check now'}
      </button>
      {#if checkResult}
        <span class="check-result" role="status">{checkResult}</span>
      {/if}
    </div>
  </header>

  {#if library.trackers.length === 0}
    <p class="state">
      Nothing tracked yet. Open any series and choose <strong>Track Releases</strong> to be told when
      its next episode airs.
    </p>
  {:else}
    <div class="board">
      <div class="timeline">
        <div class="section-label">
          <span class="section-name">Upcoming</span>
          <span class="section-count">{upcomingCount}</span>
        </div>

        <!-- ── Beyond the horizon ──────────────────────────────────────
             Above the dated days, because it is further away than all of
             them, and under the heading it belongs to. -->
        {#if laterCount > 0}
          <button class="more" onclick={() => (showLater = !showLater)}>
            <span class="arrow" class:down={showLater}>▸</span>
            {laterCount} scheduled beyond {windowDays} days
          </button>

          {#if showLater}
            {#each timeline.later as day, index (day.key)}
              {@render dayBlock(day, index, false, true)}
            {/each}
          {/if}
        {/if}

        <!-- ── Upcoming, furthest first ───────────────────────────────── -->
        {#if timeline.upcoming.length === 0}
          <p class="state thin">Nothing scheduled. Check back, or press <em>Check now</em>.</p>
        {:else}
          {#each timeline.upcoming as day, index (day.key)}
            {@render dayBlock(day, index, false, false)}
          {/each}
        {/if}

        <!-- ── The now rule, and the page's anchor ────────────────────── -->
        <div class="rule" bind:this={ruleEl}><span>now</span></div>

        <!-- ── Recently aired ────────────────────────────────────────── -->
        <div class="section-label">
          <span class="section-name">Recently aired</span>
          <span class="section-count">{recentCount}</span>
        </div>

        {#if timeline.recent.length === 0}
          <p class="state thin">Nothing aired in the last {windowDays} days.</p>
        {:else}
          {#each timeline.recent as day, index (day.key)}
            {@render dayBlock(day, index, true, false)}
          {/each}
        {/if}
      </div>

      <!-- ── The rail ──────────────────────────────────────────────────── -->
      <aside class="rail" aria-label="At a glance">
        {#if soonest}
          <section class="next">
            <span class="eyebrow">Next up</span>
            <button class="next-body" onclick={() => onselect(asMedia(soonest))}>
              {#if posterUrl(soonest.posterPath, 'w342')}
                <img
                  class="next-art"
                  src={posterUrl(soonest.posterPath, 'w342')}
                  alt=""
                  decoding="async"
                  width="96"
                  height="144"
                />
              {:else}
                <span class="next-art blank" aria-hidden="true">{soonest.title.slice(0, 1)}</span>
              {/if}
              <span class="next-lines">
                <span class="next-count">{countdown(soonest.episode.airDate, now)}</span>
                <span class="next-title">{soonest.title}</span>
                <span class="next-ep">
                  {episodeCode(soonest.episode.season, soonest.episode.episode)}
                  {#if soonest.episode.name}· {soonest.episode.name}{/if}
                </span>
              </span>
            </button>
          </section>
        {/if}

        <!--
          The week as a week.

          The spine below only draws days that have something on them, which is
          right for a list and loses the shape: four episodes on Saturday and
          nothing until Wednesday reads as "two days" there and as an actual
          week here.
        -->
        <section class="panel">
          <div class="panel-head">
            <h3>This week</h3>
            <span class="panel-note">{weekTotal} {weekTotal === 1 ? 'episode' : 'episodes'}</span>
          </div>
          <div class="week">
            {#each week as day (day.key)}
              <div class="wday" class:today={day.isToday} class:empty={day.count === 0}>
                <span class="wbar" title="{day.label} — {day.count} scheduled">
                  <span class="wfill" style="height: {Math.round((day.count / weekPeak) * 100)}%"
                  ></span>
                </span>
                <span class="wcount">{day.count > 0 ? day.count : ''}</span>
                <span class="wletter">{day.letter}</span>
              </div>
            {/each}
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <h3>Tracking</h3>
            <span class="panel-note">
              {#if behind > 0}{behind} unwatched{:else}all caught up{/if}
            </span>
          </div>
          <ul class="tracked">
            {#each tracking as row (row.tracker.id)}
              <li class="track" class:dormant={row.nextAt === null}>
                <button class="track-hit" onclick={() => onselect(asMedia(row.tracker))}>
                  {#if posterUrl(row.tracker.posterPath, 'w154')}
                    <img
                      class="track-art"
                      src={posterUrl(row.tracker.posterPath, 'w154')}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      width="28"
                      height="42"
                    />
                  {:else}
                    <span class="track-art blank" aria-hidden="true"
                      >{row.tracker.title.slice(0, 1)}</span
                    >
                  {/if}
                  <span class="track-lines">
                    <span class="track-title">{row.tracker.title}</span>
                    <span class="track-meta">
                      {#if row.next}
                        {countdown(row.next.airDate, now)} · {episodeCode(
                          row.next.season,
                          row.next.episode,
                        )}
                      {:else}
                        {statusLine(row.tracker)}
                      {/if}
                    </span>
                  </span>
                  {#if row.unwatched > 0}
                    <span class="track-badge" title="{row.unwatched} aired and unwatched"
                      >{row.unwatched}</span
                    >
                  {/if}
                </button>
                <button
                  class="untrack"
                  onclick={() => library.removeTracker(row.tracker.tmdbId)}
                  aria-label="Stop tracking {row.tracker.title}"
                  title="Stop tracking">✕</button
                >
              </li>
            {/each}
          </ul>
        </section>
      </aside>
    </div>
  {/if}
</div>

<style>
  .view {
    padding: var(--space-5) var(--space-6) var(--space-8);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }

  h2 {
    margin: 0;
    font-size: var(--text-lg);
  }

  .lede {
    margin: var(--space-1) 0 0;
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }

  .tools {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }

  .check {
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    background: var(--bg-raised);
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .check:disabled {
    opacity: 0.5;
  }

  .check-result {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }

  /*
    Two columns past this width, one below it.

    A media query rather than `auto-fit`, because the two are not
    interchangeable: the spine wants the room and the rail wants a fixed,
    readable measure, so they need different shares rather than equal ones.
    `clamp` keeps the rail from growing into a second timeline on a wide
    monitor.
  */
  .board {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  @media (min-width: 1080px) {
    .board {
      display: grid;
      grid-template-columns: minmax(0, 1fr) clamp(280px, 22vw, 360px);
      gap: var(--space-6);
      align-items: start;
    }
  }

  /*
   * The spine. One continuous line down the left, with each day's dot sitting
   * on it — which is what makes this read as a timeline rather than as a list
   * of headed groups.
   */
  .timeline {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-left: var(--space-5);
    min-width: 0;
  }

  .timeline::before {
    content: '';
    position: absolute;
    left: 5px;
    top: 4px;
    bottom: 4px;
    width: 2px;
    background: linear-gradient(
      to bottom,
      transparent 0%,
      var(--border-strong) 6%,
      var(--border-strong) 94%,
      transparent 100%
    );
  }

  .section-label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }

  .section-name {
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-tertiary);
  }

  .section-count {
    font-size: var(--text-xs);
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }

  .windows {
    display: flex;
    gap: var(--space-1);
  }

  .windows button {
    padding: 2px var(--space-2);
    border-radius: var(--radius-full);
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
    background: var(--bg-raised);
  }

  .windows button.active {
    background: var(--accent);
    color: var(--text-on-accent);
  }

  /*
   * A timetable, not a stack of headed groups: the date is a column, not a
   * row. Stacked, each day cost about 110px whether it held one episode or
   * four, so ten days of upcoming pushed the recently-aired half — half of
   * what the tab is for — a thousand pixels down the page.
   */
  .day {
    display: grid;
    grid-template-columns: 116px minmax(0, 1fr);
    align-items: start;
    gap: var(--space-2);
    padding-bottom: var(--space-1);
  }

  .marker {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0 var(--space-2);
    /* Pulls the dot back onto the spine, which the padding moved the row off. */
    margin-left: calc(var(--space-5) * -1);
    padding-left: 0;
    /* Lines the dot up with the first episode's artwork rather than with the
       top of the block, so the spine reads as marking the row. */
    padding-top: var(--space-4);
  }

  @media (max-width: 760px) {
    /* Below this the date column costs more than it earns. */
    .day {
      grid-template-columns: 1fr;
    }

    .marker {
      padding-top: var(--space-2);
    }
  }

  .dot {
    width: 11px;
    height: 11px;
    flex: none;
    border-radius: 50%;
    background: var(--bg-base);
    border: 2px solid var(--border-strong);
    /* Centred on the spine: 5px line offset + 1px to account for the border. */
    margin-left: -1px;
  }

  .today .dot,
  .dot.pulse {
    border-color: var(--accent);
    background: var(--accent);
  }

  /*
   * The one genuinely alive element on the page, and rare enough not to be
   * noise — most days nothing airs. Collapsed by the reduced-motion token
   * like everything else.
   */
  .dot.pulse {
    animation: pulse 2.4s var(--ease-out) infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 60%, transparent);
    }
    50% {
      box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 0%, transparent);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .dot.pulse {
      animation: none;
    }
  }

  .label {
    font-size: var(--text-sm);
    color: var(--text-primary);
    font-weight: 600;
    /* The date and its countdown stack in the narrow column. */
    flex-basis: 100%;
  }

  .today .label {
    color: var(--accent);
  }

  .when {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
  }

  .episodes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  /*
   * The row. Three columns: who and what, the run strip, the actions.
   *
   * The middle column exists because at 1900px the first cut put a 30px
   * thumbnail and two lines of text on the left, a score on the far right,
   * and roughly a thousand pixels of nothing in between.
   */
  .episode {
    display: grid;
    /*
      A fixed measure for the text rather than a fraction of the row. At
      1920px a 1.15fr first column was 620px wide for 380px of title, and the
      run strip started a couple of hundred pixels adrift of the words it
      belongs to.
    */
    grid-template-columns: minmax(0, 460px) minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-4);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    transition: background var(--dur-fast) var(--ease-out);
  }

  .episode:hover {
    background: var(--bg-raised);
  }

  /* The part that opens the title. */
  .hit {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
    text-align: left;
  }

  /* Already seen: present, but not competing with what has not been. */
  .episode.seen {
    opacity: 0.5;
  }

  .past .episode {
    /* Nothing structural — just enough to read as behind the rule. */
    filter: saturate(0.9);
  }

  .art {
    width: 68px;
    height: 102px;
    flex: none;
    border-radius: var(--radius-sm);
    object-fit: cover;
    background: var(--bg-raised);
    box-shadow: var(--shadow-sm);
    transition: transform var(--dur-fast) var(--ease-out);
  }

  /*
    The artwork lifts, the row does not.
    A row that changes height on hover reflows every row below it, which in a
    list this long is the whole page moving under the pointer.
  */
  .episode:hover .art {
    transform: scale(1.04);
  }

  .art.blank {
    display: grid;
    place-items: center;
    color: var(--text-tertiary);
    font-size: var(--text-lg);
  }

  .lines {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    flex: 1;
  }

  .series {
    font-size: var(--text-md);
    color: var(--text-primary);
    font-weight: var(--weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ep {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    min-width: 0;
  }

  .code {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: 0.02em;
    color: var(--text-tertiary);
    flex: none;
  }

  .ep-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chips {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: 2px;
  }

  /*
    The run strip: one segment per episode of this season.

    Same idiom as the Watchlist card's pips on purpose — one series, one
    meaning, on both surfaces.
  */
  .run {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  .segments {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 16px;
  }

  /*
    Capped, so a four-episode run is a row of pips and not four slabs. Without
    the cap `flex: 1` stretched each segment to about fifty pixels and the
    strip read as a broken progress bar rather than as a run of episodes.
  */
  .seg {
    flex: 1;
    min-width: 3px;
    max-width: 34px;
    height: 6px;
    border-radius: var(--radius-full);
    background: var(--border-subtle);
    transition:
      height var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }

  /*
    Three states, and they have to be told apart at a glance from a metre
    away. The first pass used two rgba-white borders one step apart, which on
    a dark panel is no difference at all.
  */
  .seg.aired {
    height: 10px;
    background: var(--text-disabled);
  }

  .seg.watched {
    height: 10px;
    background: var(--accent);
  }

  .seg.focus {
    height: 16px;
    background: var(--text-primary);
  }

  .seg.focus.watched {
    background: var(--accent-hover);
  }

  .run-note {
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
    white-space: nowrap;
  }

  .run-behind {
    color: var(--accent);
  }

  /*
    The run strip is the first thing to go on a narrow screen: it is the only
    part of the row that is texture rather than text.

    This block sits *after* the `.run` rules it overrides, not next to the
    `.episode` grid it also changes. Same specificity means source order
    decides, and declared earlier it lost to the `display: flex` below it —
    which showed up as a twelve-segment strip squeezing the title down to
    "LIAR G…" at 412px, with the media query apparently doing nothing.
  */
  @media (max-width: 1000px) {
    .episode {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .run {
      display: none;
    }
  }

  .tail {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-1);
    flex: none;
    min-width: 0;
  }

  .seen-tag {
    font-size: var(--text-xs);
    color: var(--success);
    flex: none;
    white-space: nowrap;
  }

  .act {
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    background: var(--accent);
    color: var(--text-on-accent);
    white-space: nowrap;
  }

  .act.ghost {
    background: var(--bg-elevated);
    color: var(--text-secondary);
  }

  .act.ghost:hover {
    color: var(--text-primary);
  }

  /*
   * The now rule. Full-bleed across the spine so the split between what is
   * coming and what has gone is a single unmissable line — and it is what the
   * page scrolls itself to on arrival.
   */
  .rule {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-4) 0 var(--space-4) calc(var(--space-5) * -1);
    color: var(--accent);
    font-size: var(--text-2xs);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .rule::before {
    content: '';
    width: 12px;
    height: 2px;
    background: var(--accent);
    flex: none;
  }

  .rule::after {
    content: '';
    flex: 1;
    height: 1px;
    background: linear-gradient(to right, var(--accent), transparent);
    opacity: 0.4;
  }

  /*
   * The disclosure for what is beyond the horizon. Deliberately quiet: it
   * exists so nothing is lost, not to compete with the fortnight either side
   * of now that the page is actually about. Above the upcoming days, because
   * everything behind it is further away than everything in them.
   */
  .more {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    align-self: flex-start;
    padding: var(--space-1) 0;
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }

  .more:hover {
    color: var(--text-secondary);
  }

  .day.faint {
    opacity: 0.7;
  }

  .arrow {
    display: inline-block;
    transition: transform var(--dur-fast) var(--ease-out);
  }

  .arrow.down {
    transform: rotate(90deg);
  }

  /* ── The rail ──────────────────────────────────────────────────────── */

  .rail {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }

  @media (min-width: 1080px) {
    /* `main` is the scroller, so this sticks against the page's own viewport.
       The nav floats over the top of it and has to be cleared by hand. */
    .rail {
      position: sticky;
      top: calc(var(--nav-height) + var(--space-4));
    }
  }

  .eyebrow {
    font-size: var(--text-2xs);
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-tertiary);
  }

  .next {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
    border-radius: var(--radius-lg);
    background: linear-gradient(
      160deg,
      var(--accent-muted) 0%,
      var(--bg-raised) 55%,
      var(--bg-raised) 100%
    );
    border: 1px solid var(--border-subtle);
  }

  .next-body {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    text-align: left;
    min-width: 0;
  }

  .next-art {
    width: 96px;
    height: 144px;
    flex: none;
    border-radius: var(--radius-md);
    object-fit: cover;
    background: var(--bg-elevated);
    box-shadow: var(--shadow-card);
    transition: transform var(--dur-mid) var(--ease-out);
  }

  .next-body:hover .next-art {
    transform: scale(1.03);
  }

  .next-art.blank {
    display: grid;
    place-items: center;
    color: var(--text-tertiary);
    font-size: var(--text-xl);
  }

  .next-lines {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .next-count {
    font-size: var(--text-xl);
    font-weight: var(--weight-bold);
    color: var(--accent);
    font-variant-numeric: tabular-nums;
    line-height: var(--leading-tight);
  }

  .next-title {
    font-size: var(--text-sm);
    color: var(--text-primary);
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .next-ep {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    border-radius: var(--radius-lg);
    background: var(--bg-raised);
    border: 1px solid var(--border-subtle);
  }

  .panel-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .panel h3 {
    margin: 0;
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-tertiary);
  }

  .panel-note {
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
  }

  .week {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: var(--space-1);
    align-items: end;
  }

  .wday {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
  }

  .wbar {
    display: flex;
    align-items: flex-end;
    width: 100%;
    height: 44px;
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    overflow: hidden;
  }

  .wfill {
    width: 100%;
    border-radius: var(--radius-sm);
    background: var(--accent);
    opacity: 0.8;
    transition: height var(--dur-mid) var(--ease-out);
  }

  .wday.empty .wfill {
    background: transparent;
  }

  .wday.today .wbar {
    outline: 1px solid var(--accent);
    outline-offset: 1px;
  }

  .wcount {
    font-size: var(--text-2xs);
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
    min-height: 12px;
  }

  .wletter {
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
    text-transform: uppercase;
  }

  .wday.today .wletter {
    color: var(--accent);
  }

  .tracked {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  /* Twenty-one series is a column taller than the viewport, and the rail is
     sticky — so on a desktop the list scrolls inside it rather than dragging
     the page. Only there: single-column, the rail is just more page, and a
     scroller inside a scroller under a thumb is the worst of both. */
  @media (min-width: 1080px) {
    .tracked {
      max-height: 42vh;
      overflow-y: auto;
    }
  }

  .track {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    border-radius: var(--radius-sm);
    transition: background var(--dur-fast) var(--ease-out);
  }

  .track:hover {
    background: var(--bg-elevated);
  }

  .track.dormant {
    opacity: 0.55;
  }

  .track-hit {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 1;
    min-width: 0;
    padding: var(--space-1);
    text-align: left;
  }

  .track-art {
    width: 28px;
    height: 42px;
    flex: none;
    border-radius: var(--radius-xs);
    object-fit: cover;
    background: var(--bg-elevated);
  }

  .track-art.blank {
    display: grid;
    place-items: center;
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
  }

  .track-lines {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    flex: 1;
  }

  .track-title {
    font-size: var(--text-xs);
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .track-meta {
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .track-badge {
    flex: none;
    min-width: 17px;
    padding: 0 5px;
    border-radius: var(--radius-full);
    background: var(--accent-muted);
    color: var(--accent);
    font-size: var(--text-2xs);
    text-align: center;
  }

  .untrack {
    width: 20px;
    height: 20px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: var(--radius-full);
    color: var(--text-tertiary);
    opacity: 0;
    transition:
      opacity var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }

  .track:hover .untrack,
  .untrack:focus-visible {
    opacity: 1;
  }

  .untrack:hover {
    color: #fff;
    background: var(--danger);
  }

  .state {
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }

  .state.thin {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    margin: 0;
  }
</style>
