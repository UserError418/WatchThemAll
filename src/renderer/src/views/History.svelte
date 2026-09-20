<script lang="ts">
  /**
   * The History surface — what was watched, when, and for how long.
   *
   * This used to be a collapsible list at the bottom of the Watchlist tab, and
   * as a list it could answer exactly one question: what was the last thing
   * played. Everything a person actually wants from a viewing history — whether
   * they watched anything this week, which evenings they watch on, whether they
   * finished the episode or gave up nine minutes in — was either absent from
   * the data or invisible in the presentation.
   *
   * Three layers, in the order the eye reads them:
   *
   * 1. **Totals.** Five numbers, largest first. Answers "how much" without
   *    anyone having to count rows.
   * 2. **The calendar.** Half a year of days, one square each. Answers "when",
   *    which is a question about *shape* and is unreadable as a list of dates.
   * 3. **The timeline.** The rows themselves, grouped by day. Answers "what",
   *    and is where the detail lives.
   *
   * The calendar is also the filter: clicking a day narrows the timeline to it.
   * That is the whole reason the two are on one screen rather than being a
   * chart tab and a list tab — a shape you cannot interrogate is decoration.
   */
  import type { HistoryEntry, MediaSummary } from '@shared/types'
  import { library } from '../lib/library.svelte'
  import { posterUrl } from '../lib/images'
  import { episodeCode } from '../lib/format'
  import {
    clockTime,
    completion,
    dayKey,
    dayLabel,
    duration,
    groupByDay,
    heatmap,
    playedMs,
    shortDate,
    summarise,
  } from '../lib/historystats'

  interface Props {
    onselect: (media: MediaSummary) => void
  }

  const { onselect }: Props = $props()

  let query = $state('')
  /** The day the calendar is focused on, or null for the whole history. */
  let pickedDay = $state<string | null>(null)
  let confirmingClear = $state(false)

  /**
   * Re-derived once a minute rather than on every render.
   *
   * "Today" has to stop meaning today at midnight, and a tab left open across
   * an evening is the normal case here — the app is a video player.
   */
  let now = $state(Date.now())
  $effect(() => {
    const tick = setInterval(() => (now = Date.now()), 60_000)
    return () => clearInterval(tick)
  })

  /**
   * The strip runs oldest to newest, so the interesting end is the right one.
   *
   * Scrolled there once the grid exists rather than reversed in CSS: a
   * reversed flex row puts the *newest* week on the left, which is the wrong
   * way round for every calendar anyone has seen, and reversing twice to get
   * back was how this first shipped looking backwards.
   */
  let strip = $state<HTMLDivElement | null>(null)
  $effect(() => {
    if (strip !== null) strip.scrollLeft = strip.scrollWidth
  })

  const summary = $derived(summarise(library.history, now))
  /** Whether any play in the whole history carries a measured duration. */
  const timed = $derived(summary.measured > 0)
  const grid = $derived(heatmap(library.history, now, 26))

  const visible = $derived.by(() => {
    const needle = query.trim().toLowerCase()
    return library.history.filter((entry) => {
      if (needle && !entry.title.toLowerCase().includes(needle)) return false
      if (pickedDay !== null && dayKey(entry.watchedAt) !== pickedDay) return false
      return true
    })
  })

  const days = $derived(groupByDay(visible))

  /** A history entry is nearly a `MediaSummary`; the overlay needs the rest. */
  function asMedia(entry: HistoryEntry): MediaSummary {
    return {
      tmdbId: entry.tmdbId,
      imdbId: null,
      type: entry.type,
      title: entry.title,
      posterPath: entry.posterPath,
      backdropPath: null,
      overview: '',
      releaseDate: null,
      rating: 0,
      genreIds: [],
    }
  }

  function pickDay(key: string, plays: number): void {
    if (plays === 0) return
    pickedDay = pickedDay === key ? null : key
  }

  /**
   * What a square says when the pointer rests on it.
   *
   * Kept as text rather than a styled popover on purpose: the grid has 182 of
   * them, and a tooltip component per cell is a lot of DOM for a hint.
   */
  function cellTitle(at: number, ms: number, plays: number): string {
    if (plays === 0) return `${shortDate(at)} — nothing`
    const what = plays === 1 ? '1 play' : `${plays} plays`
    return ms > 0 ? `${shortDate(at)} — ${what}, ${duration(ms)}` : `${shortDate(at)} — ${what}`
  }

  function clearAll(): void {
    library.clearHistory()
    confirmingClear = false
    pickedDay = null
  }

  const WEEKDAYS = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun']
</script>

<div class="view">
  <header class="head">
    <h1>History</h1>
    {#if library.history.length > 0}
      <div class="tools">
        <input
          bind:value={query}
          type="search"
          placeholder="Filter by title…"
          aria-label="Filter history by title"
        />
        {#if confirmingClear}
          <button class="danger" onclick={clearAll}>Delete everything</button>
          <button class="ghost" onclick={() => (confirmingClear = false)}>Keep it</button>
        {:else}
          <button class="ghost" onclick={() => (confirmingClear = true)}>Clear all</button>
        {/if}
      </div>
    {/if}
  </header>

  {#if library.history.length === 0}
    <p class="state">
      Nothing here yet. Press play on anything and it lands in this timeline — with how long you
      spent on it, and whether you made it to the end.
    </p>
  {:else}
    <!--
      The totals.

      Time first and in the largest type, because it is the only figure here
      that is about the user rather than about the catalogue. Counts are useful;
      "eleven hours this month" is the one that lands.
    -->
    <section class="stats" aria-label="Totals">
      <!--
        Counts rather than times when nothing has been measured yet.

        A library that predates 1.5.3 has a full history and no durations in
        it, so the headline figure would be an em dash — which reads as broken
        where "5 plays recorded" reads as true. The note below says why, once,
        and disappears the moment the first play is timed.
      -->
      <div class="stat wide">
        <span class="figure">{timed ? duration(summary.totalMs) : summary.plays}</span>
        <span class="label">{timed ? 'watched, all time' : 'plays recorded'}</span>
      </div>
      <div class="stat">
        <span class="figure">{timed ? duration(summary.weekMs) : summary.weekPlays}</span>
        <span class="label">last 7 days</span>
      </div>
      <div class="stat">
        <span class="figure">{summary.episodes}</span>
        <span class="label">{summary.episodes === 1 ? 'episode' : 'episodes'}</span>
      </div>
      <div class="stat">
        <span class="figure">{summary.films}</span>
        <span class="label">{summary.films === 1 ? 'film' : 'films'}</span>
      </div>
      <div class="stat">
        <span class="figure">{summary.titles}</span>
        <span class="label">{summary.titles === 1 ? 'title' : 'titles'}</span>
      </div>
      <div class="stat" class:lit={summary.streakDays > 1}>
        <span class="figure">{summary.streakDays}</span>
        <span class="label">day streak</span>
      </div>
    </section>

    {#if !timed}
      <p class="note">
        How long each play runs is recorded from this version onwards. Everything
        already in this timeline is kept, and counted — it just has no stopwatch
        against it.
      </p>
    {/if}

    <!--
      The calendar.

      Scrolls horizontally on a narrow screen rather than shrinking its squares,
      because a 4px square is a texture and not a control. It is anchored to the
      right on mount so the weeks that matter — the recent ones — are the ones
      on screen.
    -->
    <div class="board">
    <section class="calendar" aria-label="Viewing calendar">
      <div class="calendar-head">
        <h2>When</h2>
        {#if pickedDay !== null}
          <button class="ghost small" onclick={() => (pickedDay = null)}>
            Showing {dayLabel(new Date(`${pickedDay}T00:00:00`).getTime(), now)} · show everything
          </button>
        {:else}
          <span class="hint">The last 26 weeks. Pick a day to narrow the timeline.</span>
        {/if}
      </div>

      <div class="grid-scroll" bind:this={strip}>
        <div class="weekdays" aria-hidden="true">
          {#each WEEKDAYS as label, row (row)}<span>{label}</span>{/each}
        </div>
        <div class="grid" role="group" aria-label="Days">
          {#each grid as week, w (w)}
            <div class="week">
              {#each week as day (day.key)}
                {#if day.future}
                  <span class="cell future" aria-hidden="true"></span>
                {:else}
                  <button
                    class="cell level-{day.level}"
                    class:picked={pickedDay === day.key}
                    class:idle={day.plays === 0}
                    title={cellTitle(day.at, day.ms, day.plays)}
                    aria-label={cellTitle(day.at, day.ms, day.plays)}
                    onclick={() => pickDay(day.key, day.plays)}
                  ></button>
                {/if}
              {/each}
            </div>
          {/each}
        </div>
      </div>

      <div class="legend" aria-hidden="true">
        <span>Less</span>
        <span class="cell level-0"></span>
        <span class="cell level-1"></span>
        <span class="cell level-2"></span>
        <span class="cell level-3"></span>
        <span class="cell level-4"></span>
        <span>More</span>
      </div>
    </section>

    <!-- The timeline. -->
    <section class="timeline" aria-label="Timeline">
      {#if days.length === 0}
        <p class="state">
          {#if query.trim()}
            Nothing matches “{query.trim()}”.
          {:else}
            Nothing on that day.
          {/if}
        </p>
      {:else}
        {#each days as day (day.key)}
          <div class="day">
            <header class="day-head">
              <h2>{dayLabel(day.at, now)}</h2>
              <span class="day-total">
                {day.entries.length}
                {day.entries.length === 1 ? 'play' : 'plays'}
                {#if day.ms > 0}· {duration(day.ms)}{/if}
              </span>
            </header>

            <ul>
              {#each day.entries as item (item.id)}
                {@const thumb = posterUrl(item.posterPath, 'w154')}
                {@const through = completion(item)}
                {@const spent = playedMs(item)}
                <li>
                  <button class="row" onclick={() => onselect(asMedia(item))}>
                    {#if thumb}
                      <img
                        src={thumb}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        width="38"
                        height="57"
                      />
                    {:else}
                      <span class="thumb-empty" aria-hidden="true"></span>
                    {/if}

                    <span class="row-text">
                      <span class="row-title">
                        {item.title}
                        {#if item.season != null && item.episode != null}
                          <span class="code">{episodeCode(item.season, item.episode)}</span>
                        {/if}
                        {#if item.completed}
                          <span class="done" title="Watched to the end">✓</span>
                        {/if}
                      </span>
                      <span class="row-meta">
                        {clockTime(item.watchedAt)}
                        {#if spent > 0}· {duration(spent)} watched{/if}
                        {#if through !== null}· {Math.round(through * 100)}% through{/if}
                      </span>
                    </span>

                    <!--
                      The bar is the *position*, not the time spent. Skipping a
                      recap and reaching the credits is finishing an episode;
                      half an hour spent rewinding one scene is not.
                    -->
                    {#if through !== null}
                      <span class="progress" aria-hidden="true">
                        <span class="progress-fill" style="width: {Math.round(through * 100)}%"
                        ></span>
                      </span>
                    {/if}
                  </button>

                  <button
                    class="remove"
                    onclick={() => library.removeHistoryEntry(item.id)}
                    aria-label="Remove {item.title} from history"
                    title="Remove">✕</button
                  >
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      {/if}
    </section>
    </div>
  {/if}
</div>

<style>
  .view {
    padding: var(--space-5) var(--space-6) var(--space-8);
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  /*
    Below this the page is a single column, which is right for a phone and was
    wrong for a 1920px desktop: the calendar sat in a 300px corner and the
    timeline ran underneath it, leaving most of the window empty. Past it the
    two sit side by side and the calendar takes the space it can actually use.

    A media query rather than `auto-fit`, because these two panels are not
    interchangeable — the calendar wants to be as wide as it can get and the
    timeline wants a readable measure, so they need different shares of the row
    rather than equal ones.
  */
  @media (min-width: 1100px) {
    .board {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(320px, 1fr);
      gap: var(--space-6);
      align-items: start;
    }

    /* The timeline scrolls within the page, not the column, so a long history
       does not leave the calendar floating beside a strip of whitespace. */
    .board > .timeline {
      min-width: 0;
    }
  }

  /*
    The calendar's two tunables are read through `var(..., fallback)` and are
    declared nowhere in this file. That is not an oversight.

    Svelte scopes every selector here with a hash class, so a plain `.cell`
    rule in the phone's global sheet cannot beat `.cell.svelte-abc` without
    `!important`. Custom properties cascade normally and are the documented way
    round that — but only if this file does not declare them: a declaration on
    `.view` would win over an inherited value from `:root`, which is precisely
    what `mobile.css` sets. Declaring the default in the fallback instead
    leaves the property genuinely unset, so the phone's `:root` value inherits.
  */

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }

  h1 {
    font-family: var(--font-display);
    font-size: var(--text-xl);
    font-weight: var(--weight-bold);
    margin: 0;
  }

  .tools {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  input[type='search'] {
    background: var(--bg-elevated);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-full);
    color: var(--text-primary);
    padding: var(--space-2) var(--space-4);
    font: inherit;
    font-size: var(--text-sm);
    min-width: 200px;
  }

  input[type='search']:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .ghost,
  .danger {
    background: none;
    border: 1px solid var(--border-default);
    border-radius: var(--radius-full);
    color: var(--text-secondary);
    padding: var(--space-2) var(--space-4);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .ghost:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }

  .danger {
    color: var(--danger);
    border-color: var(--danger);
  }

  .ghost.small {
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-xs);
  }

  .note {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    max-width: 70ch;
    line-height: var(--leading-snug);
  }

  .state {
    color: var(--text-secondary);
    font-size: var(--text-sm);
    max-width: 60ch;
    line-height: var(--leading-snug);
  }

  /* ── Totals ───────────────────────────────────────────────────────────── */

  .stats {
    display: grid;
    /* Six tiles that reflow rather than a fixed row: the widest figure is
       "1h 25m" and the narrowest is "3", and a fixed grid gives both the same
       room. */
    grid-template-columns: repeat(auto-fit, minmax(var(--stat-min, 120px), 1fr));
    gap: var(--space-3);
  }

  .stat {
    background: var(--bg-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .stat.wide {
    grid-column: span 2;
    background: linear-gradient(140deg, var(--accent-muted), var(--bg-raised) 70%);
    border-color: var(--accent-subtle);
  }

  .stat.lit .figure {
    color: var(--accent);
  }

  .figure {
    font-family: var(--font-display);
    font-size: var(--text-lg);
    font-weight: var(--weight-bold);
    line-height: var(--leading-tight);
  }

  .stat.wide .figure {
    font-size: var(--text-2xl);
  }

  .label {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  /* ── Calendar ─────────────────────────────────────────────────────────── */

  .calendar-head,
  .day-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
  }

  h2 {
    font-size: var(--text-md);
    font-weight: var(--weight-emphasis);
    margin: 0;
  }

  .hint,
  .day-total {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }

  .grid-scroll {
    display: flex;
    gap: var(--space-2);
    /* Only scrolls when there is genuinely not enough room — at desktop widths
       the grid fits and a scrollbar under a chart that fits looks broken. */
    overflow-x: auto;
    padding-bottom: var(--space-2);
    margin-inline: calc(-1 * var(--heat-bleed, 0px));
    padding-inline: var(--heat-bleed, 0px);
  }

  .weekdays {
    display: grid;
    grid-template-rows: repeat(7, auto);
    gap: 3px;
    align-items: center;
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
    flex: none;
    /*
      Pinned, because the strip opens scrolled to the most recent week and the
      labels are at the far other end of it. Unpinned they are visible only
      after scrolling back six months, which is the one moment nobody needs
      to be told which row is Wednesday.
    */
    position: sticky;
    left: 0;
    z-index: 1;
    background: var(--bg-base);
    padding-right: var(--space-1);
  }

  .weekdays span {
    height: var(--heat-cell, 12px);
    line-height: var(--heat-cell, 12px);
  }

  /*
    Twenty-six columns that share whatever width there is, rather than
    twenty-six fixed 12px columns that leave the rest of the panel blank. The
    cells stay square via `aspect-ratio`, so the whole chart grows and shrinks
    as one thing instead of needing a size picked per breakpoint.
  */
  .grid {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(var(--heat-cell, 12px), 1fr);
    gap: 3px;
    flex: 1 1 auto;
    min-width: 0;
  }

  .week {
    display: grid;
    /* `auto`, not `1fr`: a fraction stretches each row to fill the column's
       height, which overrides the cells' own aspect ratio and turns the squares
       into tall rectangles. Letting the rows take their content's height is
       what keeps a day square at every width. */
    grid-template-rows: repeat(7, auto);
    gap: 3px;
    min-width: 0;
  }

  /*
    Only the cells *inside the chart* flex. The legend's swatches live in a flex
    row with nothing to stretch them, so the same rule collapses them to nothing
    — they keep the fixed size below.
  */
  .grid .cell {
    /* Width from the column, height from the width — which is what keeps a day
       square at any width without picking a size per breakpoint. Both are
       stated explicitly because the base `.cell` rule below pins a fixed height,
       and an explicit height beats an aspect ratio every time. */
    width: 100%;
    height: auto;
    aspect-ratio: 1;
    /*
      Capped on the *width*, not the height. Capping the height lets the width
      keep growing and the days stop being squares — which is the one thing a
      calendar heatmap has to be. Past this the grid simply stops expanding.
    */
    max-width: 30px;
    border-radius: 3px;
    border: none;
    padding: 0;
    background: var(--bg-elevated);
  }

  .cell {
    width: var(--heat-cell, 12px);
    height: var(--heat-cell, 12px);
    border-radius: 3px;
    border: none;
    padding: 0;
    background: var(--bg-elevated);
  }

  .cell.future {
    background: none;
  }

  button.cell {
    cursor: pointer;
  }

  button.cell.idle {
    cursor: default;
  }

  button.cell:hover:not(.idle) {
    outline: 1px solid var(--text-secondary);
  }

  .cell.picked {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  /* Four steps of the accent, not of a green nobody else in the app uses. */
  .cell.level-0 {
    background: var(--bg-elevated);
  }
  .cell.level-1 {
    background: rgba(232, 176, 75, 0.25);
  }
  .cell.level-2 {
    background: rgba(232, 176, 75, 0.45);
  }
  .cell.level-3 {
    background: rgba(232, 176, 75, 0.7);
  }
  .cell.level-4 {
    background: var(--accent);
  }

  .legend {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin-top: var(--space-2);
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
  }

  .legend span:not(.cell) {
    margin: 0 var(--space-1);
  }

  /* ── Timeline ─────────────────────────────────────────────────────────── */

  .timeline {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .day-head {
    border-bottom: 1px solid var(--border-subtle);
    padding-bottom: var(--space-2);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  li {
    display: flex;
    align-items: stretch;
    gap: var(--space-2);
  }

  .row {
    flex: 1;
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: var(--space-3);
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .row:hover {
    background: var(--bg-hover);
  }

  .row img,
  .thumb-empty {
    width: 38px;
    height: 57px;
    border-radius: var(--radius-xs);
    object-fit: cover;
    background: var(--bg-elevated);
  }

  .row-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .row-title {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .code {
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    margin-left: var(--space-1);
  }

  .done {
    color: var(--success);
    margin-left: var(--space-1);
  }

  .row-meta {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
  }

  .progress {
    width: 64px;
    height: 4px;
    border-radius: var(--radius-full);
    background: var(--bg-elevated);
    overflow: hidden;
  }

  .progress-fill {
    display: block;
    height: 100%;
    background: var(--accent);
  }

  .remove {
    background: none;
    border: none;
    color: var(--text-disabled);
    cursor: pointer;
    padding: 0 var(--space-2);
    font-size: var(--text-sm);
  }

  .remove:hover {
    color: var(--danger);
  }
</style>
