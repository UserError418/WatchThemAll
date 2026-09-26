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
    byHour,
    clockTime,
    completion,
    dayKey,
    dayLabel,
    duration,
    groupByDay,
    heatmap,
    hourLabel,
    peakHour,
    playedMs,
    shortDate,
    summarise,
    tileDetail,
    topTitles,
  } from '../lib/historystats'
  import PageHeader from '../components/PageHeader.svelte'
  import FilterField from '../components/FilterField.svelte'

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
  const detail = $derived(tileDetail(library.history, now))
  /** Whether any play in the whole history carries a measured duration. */
  const timed = $derived(summary.measured > 0)
  const grid = $derived(heatmap(library.history, now, 26))

  /**
   * The other two axes of the same habit.
   *
   * The calendar answers "which days" and structurally cannot answer either of
   * these: a Tuesday square is the same square whether it was an hour at
   * breakfast or four hours after midnight, and it says nothing at all about
   * *what* was on. Both are filters, like the calendar — a shape that cannot
   * be interrogated is decoration, and this page already has one grid earning
   * its place that way.
   */
  const hours = $derived(byHour(library.history))
  const peak = $derived(peakHour(hours))
  const tops = $derived(topTitles(library.history, 8))

  /** The title currently narrowing the timeline, lowercased for comparison. */
  const needle = $derived(query.trim().toLowerCase())

  function pickTitle(title: string): void {
    query = needle === title.toLowerCase() ? '' : title
  }

  /** What a bar says when the pointer rests on it. */
  function hourTitle(hour: number, plays: number, ms: number): string {
    if (plays === 0) return `${hourLabel(hour)} — nothing`
    const what = plays === 1 ? '1 play' : `${plays} plays`
    return ms > 0 ? `${hourLabel(hour)} — ${what}, ${duration(ms)}` : `${hourLabel(hour)} — ${what}`
  }

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

  /** The week tile's bars, against the busiest of the seven days. */
  const weekPeak = $derived(Math.max(1, ...detail.week.map((d) => (timed ? d.ms : d.plays))))

  function barHeight(day: { ms: number; plays: number }): number {
    const value = timed ? day.ms : day.plays
    // A floor, so a day with one short play is visibly not an empty day.
    return value === 0 ? 0 : Math.max(8, Math.round((value / weekPeak) * 100))
  }

  /** "2h 5m more than the week before" — the comparison that makes the figure mean something. */
  const weekVersus = $derived.by(() => {
    const thisWeek = timed ? summary.weekMs : summary.weekPlays
    const lastWeek = timed ? detail.previousWeekMs : detail.previousWeekPlays
    if (lastWeek === 0) return thisWeek === 0 ? 'Nothing this week or the one before' : 'Nothing the week before'
    const gap = Math.abs(thisWeek - lastWeek)
    const amount = timed ? duration(gap) : `${gap} ${gap === 1 ? 'play' : 'plays'}`
    if (gap === 0 || (timed && gap < 60_000)) return 'Level with the week before'
    return `${amount} ${thisWeek > lastWeek ? 'more' : 'less'} than the week before`
  })

  function weekdayInitial(at: number): string {
    return new Date(at).toLocaleDateString(undefined, { weekday: 'narrow' })
  }

  function clearAll(): void {
    library.clearHistory()
    confirmingClear = false
    pickedDay = null
  }

  const WEEKDAYS = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun']
</script>

<div class="view">
  <PageHeader title="History">
    {#if library.history.length > 0}
      <FilterField bind:value={query} label="Filter history by title" />
      {#if confirmingClear}
          <button class="danger" onclick={clearAll}>Delete everything</button>
          <button class="ghost" onclick={() => (confirmingClear = false)}>Keep it</button>
        {:else}
          <button class="ghost" onclick={() => (confirmingClear = true)}>Clear all</button>
      {/if}
    {/if}
  </PageHeader>

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
    <div class="stats-frame">
      <section class="stats" aria-label="Totals">
        <!--
          Counts rather than times when nothing has been measured yet.

          A library that predates 1.5.3 has a full history and no durations in
          it, so the headline figure would be an em dash — which reads as broken
          where "5 plays recorded" reads as true. The note below says why, once,
          and disappears the moment the first play is timed.
        -->
        <div class="stat headline">
          <span class="label">{timed ? 'Watched, all time' : 'Plays recorded'}</span>
          <span class="figure">{timed ? duration(summary.totalMs) : summary.plays}</span>
          <span class="sub">
            {#if detail.since}Since {shortDate(detail.since)} ·{/if}
            {summary.plays} {summary.plays === 1 ? 'play' : 'plays'}
          </span>
        </div>

        <!-- The week as seven bars beside its total: the shape says what the sum cannot. -->
        <div class="stat weekly">
          <div class="weekly-text">
            <span class="label">Last 7 days</span>
            <span class="figure">{timed ? duration(summary.weekMs) : summary.weekPlays}</span>
            <span class="sub">{weekVersus}</span>
          </div>
          <div class="weekly-bars" aria-hidden="true">
            {#each detail.week as day (day.key)}
              <span
                class="weekly-day"
                class:today={day.isToday}
                title={cellTitle(day.at, day.ms, day.plays)}
              >
                <span class="weekly-track"><span class="weekly-bar" style:height="{barHeight(day)}%"></span></span>
                <span class="weekly-initial">{weekdayInitial(day.at)}</span>
              </span>
            {/each}
          </div>
        </div>

        <div class="stat">
          <span class="label">{summary.episodes === 1 ? 'Episode' : 'Episodes'}</span>
          <span class="figure">{summary.episodes}</span>
          <span class="sub">
            {detail.episodeMeanMs ? `About ${duration(detail.episodeMeanMs)} each` : 'Series, all seasons'}
          </span>
        </div>
        <div class="stat">
          <span class="label">{summary.films === 1 ? 'Film' : 'Films'}</span>
          <span class="figure">{summary.films}</span>
          <span class="sub" title={detail.latestFilm ?? undefined}>
            {detail.latestFilm ? `Latest: ${detail.latestFilm}` : 'None yet'}
          </span>
        </div>
        <div class="stat">
          <span class="label">{summary.titles === 1 ? 'Title' : 'Titles'}</span>
          <span class="figure">{summary.titles}</span>
          <span class="sub" title={tops[0]?.title}>{tops[0] ? `Most: ${tops[0].title}` : ''}</span>
        </div>
        <div class="stat" class:lit={summary.streakDays > 1}>
          <span class="label">Day streak</span>
          <span class="figure">{summary.streakDays}</span>
          <span class="sub">
            {detail.longestStreak > summary.streakDays
              ? `Best: ${detail.longestStreak} days`
              : summary.streakDays > 1
                ? 'Your best yet'
                : 'Watch something today'}
          </span>
        </div>
      </section>
    </div>

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
    <div class="left">
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

    <!--
      The clock.

      Twenty-four bars, one per hour of the day, by when a play *started* —
      not by the hours it ran through, which would need an end time the entry
      does not carry. "When do you sit down to watch" is the question anyway,
      and it is the one the calendar above cannot answer at all.
    -->
    <section class="panel" aria-label="Time of day">
      <div class="panel-head">
        <h2>Rhythm</h2>
        {#if peak}
          <span class="hint">Most of it starts around {hourLabel(peak.hour)}.</span>
        {:else}
          <span class="hint">When in the day you watch.</span>
        {/if}
      </div>

      <div class="hours" role="group" aria-label="Plays by hour of day">
        {#each hours as bucket (bucket.hour)}
          <span
            class="hour"
            class:idle={bucket.plays === 0}
            class:peak={peak !== null && bucket.hour === peak.hour}
            title={hourTitle(bucket.hour, bucket.plays, bucket.ms)}
            aria-label={hourTitle(bucket.hour, bucket.plays, bucket.ms)}
          >
            <!-- A floor of 6%, so an hour with something in it is never drawn
                 as an hour with nothing in it. -->
            <span
              class="hour-fill"
              style="height: {bucket.plays === 0 ? 0 : Math.max(6, Math.round(bucket.share * 100))}%"
            ></span>
          </span>
        {/each}
      </div>

      <div class="hour-axis" aria-hidden="true">
        <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
      </div>
    </section>

    <!--
      What, rather than when.

      Folded by title, so eleven episodes of one series are one bar — which is
      the entire difference between this and the timeline beside it. Pressing
      one narrows that timeline, exactly as pressing a calendar square does.
    -->
    {#if tops.length > 0}
      <section class="panel" aria-label="Most watched titles">
        <div class="panel-head">
          <h2>Most watched</h2>
          <span class="hint">Pick one to narrow the timeline.</span>
        </div>

        <ul class="tops">
          {#each tops as row (row.tmdbId || row.title)}
            {@const on = needle === row.title.toLowerCase()}
            <li>
              <button class="top" class:on onclick={() => pickTitle(row.title)}>
                {#if posterUrl(row.posterPath, 'w154')}
                  <img
                    class="top-art"
                    src={posterUrl(row.posterPath, 'w154')}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    width="26"
                    height="39"
                  />
                {:else}
                  <span class="top-art blank" aria-hidden="true">{row.title.slice(0, 1)}</span>
                {/if}

                <span class="top-lines">
                  <span class="top-title">{row.title}</span>
                  <span class="top-track">
                    <span class="top-fill" style="width: {Math.max(2, row.share * 100)}%"></span>
                  </span>
                </span>

                <span class="top-value">
                  {#if timed && row.ms > 0}{duration(row.ms)}{:else}{row.plays}
                    {row.plays === 1 ? 'play' : 'plays'}{/if}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
    </div>

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

  /*
    The frame is a size container so the tiles can pick their columns from the
    room they actually have. With a plain \`auto-fit\` the two double-width
    tiles left a single tile orphaned on a second row at most desktop widths.
    Eight columns fit one row, four fit two tidy rows, and below that the
    phone's own track size decides.
  */
  .stats-frame {
    container-type: inline-size;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(var(--stat-min, 150px), 1fr));
    grid-auto-flow: dense;
    gap: var(--space-3);
  }

  @container (min-width: 620px) {
    .stats {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
  }

  @container (min-width: 1320px) {
    .stats {
      grid-template-columns: repeat(8, minmax(0, 1fr));
    }
  }

  .stat {
    background: var(--bg-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: var(--space-4) var(--space-4) var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
    min-height: 128px;
  }

  /*
    Not `.hero`: the phone sheet sizes the Browse billboard through that class
    globally, and a tile named after it came out 460px tall on the phone.
  */
  .stat.headline {
    grid-column: span 2;
  }

  /*
    The whole row until the frame has four columns. On a phone two of three
    columns is about 230px, and the bars' minimum left the total and its label
    so little room that they ran into the bars.
  */
  .stat.weekly {
    grid-column: 1 / -1;
  }

  /* After the rule above, which it overrides at the same specificity. */
  @container (min-width: 620px) {
    .stat.weekly {
      grid-column: span 2;
    }
  }

  .stat.headline {
    background: linear-gradient(140deg, var(--accent-muted), var(--bg-raised) 70%);
    border-color: var(--accent-subtle);
  }

  .stat.lit .figure {
    color: var(--accent);
  }

  .label {
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: var(--tracking-caps);
  }

  .figure {
    font-family: var(--font-display);
    font-size: var(--text-2xl);
    font-weight: var(--weight-bold);
    line-height: var(--leading-tight);
    font-variant-numeric: tabular-nums;
  }

  .stat.headline .figure {
    font-size: var(--text-3xl);
  }

  /* Pinned to the bottom, so a row of tiles reads as one line of context. */
  .sub {
    margin-top: auto;
    font-size: var(--text-xs);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stat.weekly {
    flex-direction: row;
    align-items: stretch;
    gap: var(--space-4);
  }

  .weekly-text {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
    flex: 1;
  }

  /* A fixed height: the bars are percentages, and a percentage of an
     auto-height box resolves to nothing. */
  .weekly-bars {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 4px;
    height: 92px;
    align-self: flex-end;
    flex: 0 1 180px;
    min-width: 112px;
  }

  .weekly-day {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }

  .weekly-track {
    flex: 1;
    width: 100%;
    display: flex;
    align-items: flex-end;
    border-radius: var(--radius-xs);
    background: var(--bg-elevated);
    overflow: hidden;
  }

  .weekly-bar {
    width: 100%;
    background: color-mix(in srgb, var(--accent) 70%, transparent);
    border-radius: var(--radius-xs) var(--radius-xs) 0 0;
  }

  .weekly-day.today .weekly-bar {
    background: var(--accent);
  }

  .weekly-initial {
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
  }

  .weekly-day.today .weekly-initial {
    color: var(--accent);
  }

  /* ── Calendar ─────────────────────────────────────────────────────────── */

  /*
    The left column: the calendar and the two panels under it.

    The calendar is about 370px tall and the timeline beside it is as tall as
    the history is long, so on a desktop window the bottom two thirds of this
    column was empty. These are the two questions the calendar cannot answer —
    which part of the day, and what — so they earn the space rather than
    filling it.
  */
  .left {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    min-width: 0;
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .panel-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }

  /* ── Rhythm ───────────────────────────────────────────────────────── */

  .hours {
    display: grid;
    grid-template-columns: repeat(24, 1fr);
    gap: 3px;
    height: 104px;
    align-items: end;
  }

  .hour {
    display: flex;
    align-items: flex-end;
    height: 100%;
    border-radius: var(--radius-xs);
    background: var(--bg-raised);
    overflow: hidden;
    transition: background var(--dur-fast) var(--ease-out);
  }

  .hour:hover {
    background: var(--bg-elevated);
  }

  .hour-fill {
    width: 100%;
    border-radius: var(--radius-xs);
    background: linear-gradient(to top, var(--accent-press), var(--accent));
    opacity: 0.85;
    transition: height var(--dur-mid) var(--ease-out);
  }

  /* The one hour the habit actually lives in. */
  .hour.peak .hour-fill {
    opacity: 1;
    background: linear-gradient(to top, var(--accent), var(--accent-hover));
  }

  .hour.idle .hour-fill {
    background: transparent;
  }

  .hour-axis {
    display: flex;
    justify-content: space-between;
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
  }

  /* ── Most watched ─────────────────────────────────────────────────── */

  .tops {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .top {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    text-align: left;
    transition: background var(--dur-fast) var(--ease-out);
  }

  .top:hover {
    background: var(--bg-raised);
  }

  /* Selected: the same treatment a picked calendar day gets. */
  .top.on {
    background: var(--accent-subtle);
  }

  .top-art {
    width: 26px;
    height: 39px;
    flex: none;
    border-radius: var(--radius-xs);
    object-fit: cover;
    background: var(--bg-raised);
  }

  .top-art.blank {
    display: grid;
    place-items: center;
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
  }

  .top-lines {
    display: flex;
    flex-direction: column;
    gap: 5px;
    flex: 1;
    min-width: 0;
  }

  .top-title {
    font-size: var(--text-xs);
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .top-track {
    height: 6px;
    border-radius: var(--radius-full);
    background: var(--bg-raised);
    overflow: hidden;
  }

  .top-fill {
    display: block;
    height: 100%;
    border-radius: var(--radius-full);
    background: var(--accent);
    opacity: 0.75;
    transition: width var(--dur-mid) var(--ease-out);
  }

  .top:hover .top-fill,
  .top.on .top-fill {
    opacity: 1;
  }

  .top-value {
    flex: none;
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
  }

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
