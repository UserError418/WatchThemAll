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
   * day matters. So: a spine with real day markers, upcoming above, what has
   * already aired below, and a rule between them for now.
   *
   * ## Upcoming first
   *
   * What the user opens this tab to find is what is next, so that leads. The
   * recent half exists because "did I miss anything" is the other half of
   * tracking releases, and before 1.6.0 nothing in the app could answer it —
   * `nextEpisode` looks one episode forward and `lastNotified` is a
   * notification bookmark, not a record of what aired.
   *
   * The bucketing, the day labels and the window live in `schedule.ts` with
   * their tests, because every interesting case there is a midnight boundary.
   * This file is layout.
   *
   * The countdown ticks from one interval for the whole page rather than one
   * per row: the original kept a Map of timers keyed by element id and leaked
   * them whenever a row re-rendered without being explicitly stopped.
   */
  import type { MediaSummary, ReleaseTracker } from '@shared/types'
  import { library } from '../lib/library.svelte'
  import { posterUrl } from '../lib/images'
  import { countdown, episodeCode, timeAgo } from '../lib/format'
  import { buildTimeline, countEpisodes, WINDOWS } from '../lib/schedule'
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
  let showUnscheduled = $state(false)
  let showLater = $state(false)

  $effect(() => {
    const interval = setInterval(() => (now = Date.now()), 60_000)
    return () => clearInterval(interval)
  })

  const timeline = $derived(buildTimeline(library.trackers, { now, windowDays }))
  const upcomingCount = $derived(countEpisodes(timeline.upcoming))
  const laterCount = $derived(countEpisodes(timeline.later))
  const recentCount = $derived(countEpisodes(timeline.recent))

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

  function asMedia(source: { tmdbId: number; title: string; posterPath: string | null }): MediaSummary {
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
    if (tracker.status === 'Ended') return 'Series ended'
    if (tracker.status === 'Canceled') return 'Cancelled'
    if (tracker.status === 'Returning Series') return 'Waiting on a schedule'
    return tracker.status || 'Listening for new episodes'
  }

  async function play(
    episode: { tmdbId: number; title: string; season: number; number: number },
  ): Promise<void> {
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
</script>

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
    <div class="timeline">
      <!-- ── Upcoming ──────────────────────────────────────────────── -->
      <div class="section-label">
        <span class="section-name">Upcoming</span>
        <span class="section-count">{upcomingCount}</span>
      </div>

      {#if timeline.upcoming.length === 0}
        <p class="state thin">Nothing scheduled. Check back, or press <em>Check now</em>.</p>
      {:else}
        {#each timeline.upcoming as day, index (day.key)}
          <section class="day" class:today={day.isToday} in:fly={stagger(index, 16, 8)}>
            <div class="marker">
              <span class="dot" class:pulse={day.isToday}></span>
              <span class="label">{day.label}</span>
              {#if day.episodes[0]}
                <span class="when">{countdown(day.episodes[0].episode.airDate, now)}</span>
              {/if}
            </div>

            <ul class="episodes">
              {#each day.episodes as item (item.tmdbId + ':' + item.episode.season + ':' + item.episode.episode)}
                <li>
                  <div class="episode">
                    <button class="hit" onclick={() => onselect(asMedia(item))}>
                      {#if posterUrl(item.posterPath, 'w154')}
                        <img
                          class="thumb"
                          src={posterUrl(item.posterPath, 'w154')}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          width="34"
                          height="51"
                        />
                      {:else}
                        <span class="thumb blank" aria-hidden="true">{item.title.slice(0, 1)}</span>
                      {/if}
                      <span class="lines">
                        <span class="series">{item.title}</span>
                        <span class="ep">
                          {episodeCode(item.episode.season, item.episode.episode)}
                          {#if item.episode.name}<span class="ep-name">· {item.episode.name}</span
                            >{/if}
                        </span>
                      </span>
                    </button>
                    <span class="score"><Score rating={library.scoreFor(item.tmdbId)} /></span>
                  </div>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      {/if}

      {#if laterCount > 0}
        <button class="more" onclick={() => (showLater = !showLater)}>
          <span class="arrow" class:down={showLater}>▸</span>
          {laterCount} scheduled beyond {windowDays} days
        </button>

        {#if showLater}
          {#each timeline.later as day (day.key)}
            <section class="day faint">
              <div class="marker">
                <span class="dot"></span>
                <span class="label">{day.label}</span>
                {#if day.episodes[0]}
                  <span class="when">{countdown(day.episodes[0].episode.airDate, now)}</span>
                {/if}
              </div>
              <ul class="episodes">
                {#each day.episodes as item (item.tmdbId + ':' + item.episode.season + ':' + item.episode.episode)}
                  <li>
                    <div class="episode">
                      <button class="hit" onclick={() => onselect(asMedia(item))}>
                        {#if posterUrl(item.posterPath, 'w154')}
                          <img
                            class="thumb"
                            src={posterUrl(item.posterPath, 'w154')}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            width="34"
                            height="51"
                          />
                        {:else}
                          <span class="thumb blank" aria-hidden="true">{item.title.slice(0, 1)}</span
                          >
                        {/if}
                        <span class="lines">
                          <span class="series">{item.title}</span>
                          <span class="ep">
                            {episodeCode(item.episode.season, item.episode.episode)}
                            {#if item.episode.name}<span class="ep-name">· {item.episode.name}</span
                              >{/if}
                          </span>
                        </span>
                      </button>
                    </div>
                  </li>
                {/each}
              </ul>
            </section>
          {/each}
        {/if}
      {/if}

      <!-- ── The now rule ──────────────────────────────────────────── -->
      <div class="rule"><span>now</span></div>

      <!-- ── Recently aired ────────────────────────────────────────── -->
      <div class="section-label">
        <span class="section-name">Recently aired</span>
        <span class="section-count">{recentCount}</span>
        <div class="windows">
          {#each WINDOWS as days (days)}
            <button class:active={windowDays === days} onclick={() => (windowDays = days)}
              >{days}d</button
            >
          {/each}
        </div>
      </div>

      {#if timeline.recent.length === 0}
        <p class="state thin">Nothing aired in the last {windowDays} days.</p>
      {:else}
        {#each timeline.recent as day, index (day.key)}
          <section class="day past" in:fly={stagger(index, 16, 8)}>
            <div class="marker">
              <span class="dot"></span>
              <span class="label">{day.label}</span>
              <span class="when">{timeAgo(day.at, now)}</span>
            </div>

            <ul class="episodes">
              {#each day.episodes as item (item.tmdbId + ':' + item.episode.season + ':' + item.episode.episode)}
                {@const seen = library.isWatched(
                  item.tmdbId,
                  item.episode.season,
                  item.episode.episode,
                )}
                <li>
                  <!-- A row, not a button: the actions on its right are
                       buttons themselves, and a button cannot contain one. -->
                  <div class="episode" class:seen>
                    <button class="hit" onclick={() => onselect(asMedia(item))}>
                      {#if posterUrl(item.posterPath, 'w154')}
                        <img
                          class="thumb"
                          src={posterUrl(item.posterPath, 'w154')}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          width="34"
                          height="51"
                        />
                      {:else}
                        <span class="thumb blank" aria-hidden="true">{item.title.slice(0, 1)}</span>
                      {/if}
                      <span class="lines">
                        <span class="series">{item.title}</span>
                        <span class="ep">
                          {episodeCode(item.episode.season, item.episode.episode)}
                          {#if item.episode.name}<span class="ep-name">· {item.episode.name}</span
                            >{/if}
                        </span>
                      </span>
                    </button>

                    {#if seen}
                      <span class="seen-tag">✓ watched</span>
                    {:else}
                      <!-- The two actions that matter for something that has
                           already aired and has not been seen. -->
                      <span class="actions">
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
                      </span>
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      {/if}
    </div>

    <!-- ── Not scheduled ───────────────────────────────────────────── -->
    {#if timeline.unscheduled.length > 0}
      <section class="parked">
        <button class="parked-head" onclick={() => (showUnscheduled = !showUnscheduled)}>
          <span class="arrow" class:down={showUnscheduled}>▸</span>
          Not scheduled
          <span class="section-count">{timeline.unscheduled.length}</span>
          <span class="hint">Ended, cancelled, or no date yet</span>
        </button>

        {#if showUnscheduled}
          <ul class="parked-list">
            {#each timeline.unscheduled as tracker (tracker.id)}
              <li>
                <div class="episode">
                  <button class="hit" onclick={() => onselect(asMedia(tracker))}>
                    {#if posterUrl(tracker.posterPath, 'w154')}
                      <img
                        class="thumb"
                        src={posterUrl(tracker.posterPath, 'w154')}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        width="34"
                        height="51"
                      />
                    {:else}
                      <span class="thumb blank" aria-hidden="true">{tracker.title.slice(0, 1)}</span
                      >
                    {/if}
                    <span class="lines">
                      <span class="series">{tracker.title}</span>
                      <span class="ep muted">{statusLine(tracker)}</span>
                    </span>
                  </button>
                  <button
                    class="act ghost"
                    onclick={() => library.removeTracker(tracker.tmdbId)}
                    aria-label="Stop tracking {tracker.title}">✕</button
                  >
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
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
    margin-left: auto;
  }

  .windows button {
    padding: 1px var(--space-2);
    border-radius: var(--radius-full);
    font-size: 10px;
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
    grid-template-columns: 116px 1fr;
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
    padding-top: var(--space-3);
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
    background: var(--bg-base, #101013);
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
    gap: 1px;
  }

  .episode {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    transition: background var(--dur-fast) var(--ease-out);
  }

  .episode:hover {
    background: var(--bg-raised);
  }

  /* The part that opens the title. Takes the whole row minus the actions, so
     there is no dead strip between the episode name and the buttons. */
  .hit {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex: 1;
    min-width: 0;
    text-align: left;
  }

  /* Already seen: present, but not competing with what has not been. */
  .episode.seen {
    opacity: 0.55;
  }

  .past .episode {
    /* Nothing structural — just enough to read as behind the rule. */
    filter: saturate(0.85);
  }

  .thumb {
    width: 30px;
    height: 45px;
    flex: none;
    border-radius: var(--radius-sm);
    object-fit: cover;
    background: var(--bg-raised);
  }

  .thumb.blank {
    display: grid;
    place-items: center;
    color: var(--text-tertiary);
    font-size: var(--text-xs);
  }

  .lines {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .series {
    font-size: var(--text-sm);
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ep {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ep-name {
    color: var(--text-tertiary);
  }

  .ep.muted {
    color: var(--text-tertiary);
  }

  .seen-tag {
    font-size: var(--text-xs);
    color: var(--positive, #5ac887);
    flex: none;
  }

  .actions {
    display: flex;
    gap: var(--space-1);
    flex: none;
  }

  .act {
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    background: var(--accent);
    color: var(--text-on-accent);
    white-space: nowrap;
  }

  .act.ghost {
    background: var(--bg-raised);
    color: var(--text-secondary);
  }

  .act.ghost:hover {
    color: var(--text-primary);
  }

  /*
   * The now rule. Full-bleed across the spine so the split between what is
   * coming and what has gone is a single unmissable line.
   */
  .rule {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-3) 0 var(--space-3) calc(var(--space-5) * -1);
    color: var(--accent);
    font-size: 10px;
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
   * of now that the page is actually about.
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

  .parked {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .parked-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    text-align: left;
  }

  .arrow {
    display: inline-block;
    transition: transform var(--dur-fast) var(--ease-out);
  }

  .arrow.down {
    transform: rotate(90deg);
  }

  .hint {
    color: var(--text-tertiary);
    opacity: 0.75;
  }

  .parked-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
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
