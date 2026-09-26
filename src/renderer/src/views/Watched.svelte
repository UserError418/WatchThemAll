<script lang="ts">
  /**
   * Everything the user has already seen, one row per title.
   *
   * Distinct from History, and the distinction matters: History is an
   * append-only log of *play events* written by the player. This is a
   * title-level library — "I have watched this" — which is mostly things never
   * played through this app at all. Imports land here; so does a series
   * finished years ago on something else.
   *
   * It is also where rating happens, because this is the only surface where
   * the user is looking at a list of things they have an opinion about.
   *
   * ## Why rows and not the grid this used to be
   *
   * 1.5.7 made "watched" a per-season statement, which is right — it is what
   * lets the app say you finished season 3 and not season 4 — but it means a
   * nine-season series is nine tiles. At 194 titles and 367 entries the grid
   * became a wall of near-identical posters with no way to see the shape of
   * the library. So the records stay per-season and the *view* folds them:
   * one row per title, expandable to its seasons.
   *
   * ## Wide covers, and what fills the middle
   *
   * This used to be deliberately bare — a 40px poster — on the grounds that an
   * archive this size should fit as many rows on screen as possible. In use it
   * was the wrong trade: a thumbnail that small is not recognisable, so every
   * row had to be read, and a two-thousand-pixel window drew a thousand pixels
   * of nothing in the middle of each one. The owner's call, 2026-09-26: rows
   * carry the title's wide artwork, and the middle carries what the row is
   * about — for a series, the season ribbon with the aired seasons not yet
   * watched drawn hollow; for a film, its synopsis. Those facts are not on the
   * watched records; `titlefacts.svelte.ts` fetches them as rows scroll in.
   *
   * The folding, the band counts, the means and the sort live in
   * `watchedgroups.ts` with their tests. This file is layout.
   */
  import type { MediaSummary, RatingValue, WatchedEntry } from '@shared/types'
  import type { RatingBand } from '@shared/rating'
  import { library } from '../lib/library.svelte'
  import { backdropUrl, posterUrl } from '../lib/images'
  import { titleFacts, whenVisible } from '../lib/titlefacts.svelte'
  import type { TitleFacts } from '../lib/titlefacts'
  import { runtime } from '../lib/format'
  import PageHeader from '../components/PageHeader.svelte'
  import FilterField from '../components/FilterField.svelte'
  import {
    bandOf,
    deepest,
    groupWatched,
    isWatchedSort,
    leaning,
    RIBBON_LIMIT,
    ribbon,
    seasonsToGo,
    summarise,
    summaryLabel,
    WATCHED_SORTS,
    type TitleGroup,
    type WatchedSort,
  } from '../lib/watchedgroups'
  import { expandIn, expandOut, stagger } from '../lib/motion'
  import { fly } from 'svelte/transition'
  import { SvelteSet } from 'svelte/reactivity'
  import RatingStrip from '../components/RatingStrip.svelte'
  import Score from '../components/Score.svelte'

  interface Props {
    onselect: (media: MediaSummary) => void
  }

  const { onselect }: Props = $props()

  /** The bands are filters in their own right: see `ratingBand` for the lines. */
  type Filter = 'all' | 'unrated' | RatingBand

  let filter = $state<Filter>('all')
  let query = $state('')
  /**
   * The sort, remembered on this device.
   *
   * It reset to "Recently added" on every visit, so a user who reads the list
   * by their own rating chose it again each time. Device-local rather than a
   * synced setting: it is how this screen is being read right now, not a
   * preference about the library.
   */
  const SORT_KEY = 'wta.watchedSort'
  let sort = $state<WatchedSort>(readSort())

  function readSort(): WatchedSort {
    try {
      const stored = localStorage.getItem(SORT_KEY)
      if (isWatchedSort(stored)) return stored
    } catch {
      // No storage: the default below.
    }
    return 'recent'
  }

  $effect(() => {
    try {
      localStorage.setItem(SORT_KEY, sort)
    } catch {
      // A preference, not data; losing it costs one click.
    }
  })

  /**
   * Which titles are expanded, by group key.
   *
   * A set rather than a field on the group, because the groups are rebuilt
   * from scratch whenever the filter, sort or query changes — state stored on
   * them would reset every time the user typed a character.
   *
   * `SvelteSet` is reactive in its own right, so it is a `const` and not
   * `$state`: wrapping it would add a second layer of tracking over one that
   * already works.
   */
  const expanded = new SvelteSet<string>()

  /** A WatchedEntry is nearly a MediaSummary; the overlay needs the rest. */
  function asMedia(entry: WatchedEntry): MediaSummary {
    return {
      tmdbId: entry.tmdbId,
      imdbId: entry.imdbId,
      type: entry.type,
      title: entry.title,
      posterPath: entry.posterPath,
      backdropPath: null,
      overview: '',
      releaseDate: null,
      rating: entry.rating,
      genreIds: entry.genreIds,
    }
  }

  const visible = $derived.by(() => {
    const needle = query.trim().toLowerCase()
    return library.watched.filter((entry) => {
      if (needle && !entry.title.toLowerCase().includes(needle)) return false
      // The entry's own scope, not the title's. Asking for the series opinion
      // here is what listed seasons the user had just rated under "Unrated",
      // with a lit thumb on the very same row.
      const rating = library.ratingForEntry(entry)
      if (filter === 'all') return true
      if (filter === 'unrated') return rating === null
      return bandOf(rating) === filter
    })
  })

  const groups = $derived(groupWatched(visible, (e) => library.ratingForEntry(e), sort))
  const totals = $derived(summarise(groups))
  const unratedCount = $derived(library.unratedWatched.length)

  /**
   * The header band is a portrait of the *library*, not of the current filter.
   *
   * Derived from everything rather than from `groups`, and sorted by title
   * rather than by the user's choice, so that neither typing in the filter box
   * nor changing the sort recomputes it — and, more importantly, so the
   * numbers do not rearrange themselves the moment you press "Liked" to go
   * looking for them.
   */
  const shelf = $derived(groupWatched(library.watched, (e) => library.ratingForEntry(e), 'title'))
  const portrait = $derived(summarise(shelf))
  const rated = $derived(portrait.liked + portrait.mixed + portrait.disliked)
  const top = $derived(deepest(shelf))

  /** "8 · liked" or "not rated", for a ribbon segment's tooltip. */
  function ratingWord(rating: RatingValue | null): string {
    return rating === null ? 'not rated' : `${rating} · ${bandOf(rating)}`
  }

  /**
   * Under a filter every visible season is one the user came here to act on,
   * so the seasons are shown without a press. Under "All" the point is the
   * opposite — a compact archive — and rows stay closed.
   */
  const autoExpand = $derived(filter !== 'all' || query.trim().length > 0)

  function isOpen(group: TitleGroup): boolean {
    return group.flat || autoExpand || expanded.has(group.key)
  }

  function toggle(group: TitleGroup): void {
    if (expanded.has(group.key)) expanded.delete(group.key)
    else expanded.add(group.key)
  }

  /** "5 seasons", or the one season's own name when there is only one. */
  function seasonSummary(group: TitleGroup): string {
    if (group.type === 'movie') return 'Film'
    if (group.seasons.length > 1) return `${group.seasons.length} seasons`
    const only = group.seasons[0]?.entry.season
    return only === null || only === undefined ? 'Whole series' : `Season ${only}`
  }

  /** `range` is drawn beside the label, so the bands never have to be guessed. */
  const FILTERS: Array<{ id: Filter; label: string; range?: string }> = [
    { id: 'all', label: 'All' },
    { id: 'unrated', label: 'Unrated' },
    { id: 'liked', label: 'Liked', range: '8–10' },
    { id: 'mixed', label: 'Mixed', range: '6–7' },
    { id: 'disliked', label: 'Disliked', range: '1–5' },
  ]

  /** "2016 · Drama, Mystery · 2h 35m" — the line that places a title. */
  function factsLine(group: TitleGroup, facts: TitleFacts | null): string {
    if (facts === null) return ''
    const parts = [facts.year, facts.genres.join(', ')]
    if (group.type === 'movie' && facts.runtime) parts.push(runtime(facts.runtime))
    return parts.filter(Boolean).join(' · ')
  }

  /** "Ended", "Returning", "Cancelled" — only the states worth a chip. */
  function statusWord(facts: TitleFacts | null): string | null {
    switch (facts?.status) {
      case 'Ended':
        return 'Ended'
      case 'Canceled':
        return 'Cancelled'
      case 'Returning Series':
        return 'Returning'
      default:
        return null
    }
  }

  /** Under the ribbon: where the user is with the series. */
  function ribbonCaption(group: TitleGroup, facts: TitleFacts | null): string {
    const toGo = seasonsToGo(group, facts?.airedSeasons ?? null)
    const watched = group.seasons.length
    if (toGo > 0) return `${watched} of ${watched + toGo} seasons · ${toGo} to go`
    return watched === 1 ? '1 season' : `All ${watched} seasons`
  }

  /** A band tile and a meter segment are the same filter, and toggle back to All. */
  function toggleFilter(band: Filter): void {
    filter = filter === band ? 'all' : band
  }
</script>

<div class="watched">
  <PageHeader title="Watched" count="{totals.titles} titles · {totals.seasons} seasons">
    <FilterField bind:value={query} label="Filter watched titles" />
    <div class="filters">
      {#each FILTERS as f (f.id)}
        <button class:active={filter === f.id} onclick={() => (filter = f.id)}>
          {f.label}
          {#if f.range}<span class="range">{f.range}</span>{/if}
          {#if f.id === 'unrated' && unratedCount > 0}<span class="badge">{unratedCount}</span>{/if}
        </button>
      {/each}
    </div>
    <!--
      Labelled on screen, and shaped as a menu. It was a bare select styled as a
      pill, with "Sort by" for screen readers only, so it read as one more filter
      chip at the end of the row — "Recently added" — and the owner asked for a
      sort that was already there.
    -->
    <label class="sort">
      <svg class="sort-glyph" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 5v14M4 16l3 3 3-3M14 7h6M14 12h4.5M14 17h3" />
      </svg>
      <span class="sort-label">Sort by</span>
      <select bind:value={sort}>
        {#each WATCHED_SORTS as option (option.id)}
          <option value={option.id}>{option.label}</option>
        {/each}
      </select>
      <svg class="sort-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
    </label>
  </PageHeader>

  {#if library.watched.length === 0}
    <p class="empty">
      Nothing here yet. Add titles you have already seen from their detail page, or bring a
      MyAnimeList export in through <strong>Import</strong> in Settings.
    </p>
  {:else}
    <!--
      The band: what is actually in here, before the list of it.

      An archive of two hundred rows has no single headline fact, so this is
      the nearest thing — how much, how it was received, and the one series
      with the most of the user's life in it. The unrated tile and every
      segment of the meter are filters, which is what stops this being
      decoration: a shape you cannot interrogate is a picture.
    -->
    <section class="band" aria-label="Library at a glance">
      <div class="stat wide">
        <span class="figure">{portrait.titles}</span>
        <span class="label">titles</span>
      </div>
      <div class="stat">
        <span class="figure">{portrait.seasons}</span>
        <span class="label">seasons &amp; films</span>
      </div>
      <button class="stat act" class:on={filter === 'liked'} onclick={() => toggleFilter('liked')}>
        <span class="figure liked">{portrait.liked}</span>
        <span class="label">liked · 8–10</span>
      </button>
      <button class="stat act" class:on={filter === 'mixed'} onclick={() => toggleFilter('mixed')}>
        <span class="figure mixed">{portrait.mixed}</span>
        <span class="label">mixed · 6–7</span>
      </button>
      <button
        class="stat act"
        class:on={filter === 'disliked'}
        onclick={() => toggleFilter('disliked')}
      >
        <span class="figure disliked">{portrait.disliked}</span>
        <span class="label">disliked · 1–5</span>
      </button>
      <button
        class="stat act"
        class:on={filter === 'unrated'}
        onclick={() => toggleFilter('unrated')}
      >
        <span class="figure">{portrait.unrated}</span>
        <span class="label">unrated</span>
      </button>
      {#if top}
        {@const topFacts = titleFacts.get(top.type, top.tmdbId)}
        <button
          class="stat act deep"
          onclick={() => onselect(asMedia(top.seasons[0]!.entry))}
          use:whenVisible={() => titleFacts.want(top.type, top.tmdbId)}
        >
          {#if topFacts?.backdropPath}
            <img class="deep-art" src={backdropUrl(topFacts.backdropPath, 'w780')} alt="" decoding="async" />
          {/if}
          <span class="figure small">{top.title}</span>
          <span class="label">{top.seasons.length} seasons — your deepest</span>
        </button>
      {/if}
    </section>

    <!--
      The split, as one bar.

      Three counts in three tiles are three numbers; the same three as widths
      are a proportion, which is the thing a person actually wants to know
      about their own library and cannot get by reading digits.
    -->
    {#if portrait.seasons > 0}
      <!--
        A segment with nothing in it is not drawn at all. `flex: 0` still
        leaves a button with its own padding on the bar, which reads as "a
        few disliked" on a library where nothing is.
      -->
      <div class="meter" role="group" aria-label="How the library was rated">
        {#each ['liked', 'mixed', 'disliked'] as const as band (band)}
          {#if portrait[band] > 0}
            <button
              class="mseg {band}"
              style="flex: {portrait[band]}"
              onclick={() => (filter = band)}
              aria-label="{portrait[band]} {band}"
              title="{portrait[band]} {band}"
            ></button>
          {/if}
        {/each}
        {#if portrait.unrated > 0}
          <button
            class="mseg blank"
            style="flex: {portrait.unrated}"
            onclick={() => (filter = 'unrated')}
            aria-label="{portrait.unrated} unrated"
            title="{portrait.unrated} unrated"
          ></button>
        {/if}
      </div>

      <!--
        The nudge, as a caption rather than the box it used to be. Rating is
        worth encouraging and not worth interrupting for: a panel over a
        two-hundred-title library gets dismissed, and dismissed prompts train
        people to dismiss the next one.
      -->
      <p class="caption">
        {#if unratedCount > 0}
          <button class="link" onclick={() => (filter = 'unrated')}>{unratedCount} unrated</button>
          — rating them is what makes the tailored row on Browse worth reading.
        {:else}
          Every season here has an opinion against it. That is what the tailored row on Browse
          reads.
        {/if}
        {#if rated > 0}
          <span class="caption-dim">
            {Math.round((portrait.liked / rated) * 100)}% of what you rated, you liked.
          </span>
        {/if}
      </p>
    {/if}

    {#if groups.length === 0}
      <p class="empty">Nothing matches that filter.</p>
    {:else}
      <ul class="list">
        {#each groups as group, index (group.key)}
          {@const open = isOpen(group)}
          {@const lean = leaning(group)}
          {@const facts = titleFacts.get(group.type, group.tmdbId)}
          {@const status = statusWord(facts)}
          <li
            class="group"
            class:open
            in:fly={stagger(index, 14, 10)}
            use:whenVisible={() => titleFacts.want(group.type, group.tmdbId)}
          >
            <div
              class="row"
              class:liked={lean === 'liked'}
              class:mixed={lean === 'mixed'}
              class:disliked={lean === 'disliked'}
            >
              {#if group.flat}
                <span class="chev placeholder" aria-hidden="true"></span>
              {:else}
                <button
                  class="chev"
                  onclick={() => toggle(group)}
                  aria-expanded={open}
                  aria-label={open ? `Collapse ${group.title}` : `Expand ${group.title}`}
                >
                  <span class="arrow" class:down={open}>▸</span>
                </button>
              {/if}

              <button class="ident" onclick={() => onselect(asMedia(group.seasons[0]!.entry))}>
                <!--
                  The wide artwork once it is known, and until then — or for a
                  title TMDB has none for — the poster, contained over a blurred
                  copy of itself so the box is the same shape either way and
                  nothing jumps when the backdrop arrives.
                -->
                <span class="cover" aria-hidden="true">
                  {#if posterUrl(group.posterPath, 'w154')}
                    <img
                      class="cover-blur"
                      src={posterUrl(group.posterPath, 'w154')}
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                    <img
                      class="cover-poster"
                      src={posterUrl(group.posterPath, 'w154')}
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                  {:else}
                    <span class="cover-letter">{group.title.slice(0, 1)}</span>
                  {/if}
                  {#if facts?.backdropPath}
                    <img
                      class="cover-wide"
                      src={backdropUrl(facts.backdropPath, 'w300')}
                      srcset="{backdropUrl(facts.backdropPath, 'w300')} 300w, {backdropUrl(
                        facts.backdropPath,
                        'w780',
                      )} 780w"
                      sizes="192px"
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                  {/if}
                </span>

                <span class="names">
                  <span class="name">{group.title}</span>
                  {#if factsLine(group, facts)}
                    <span class="facts">{factsLine(group, facts)}</span>
                  {/if}
                  <span class="meta">
                    {seasonSummary(group)}
                    <!-- The mean, for a series; a flat row's chip already shows its number. -->
                    {#if !group.flat && summaryLabel(group)}<span class="dot">·</span
                      >{summaryLabel(group)}{/if}
                    {#if status}<span class="status" class:live={status === 'Returning'}
                        >{status}</span
                      >{/if}
                    {#if group.imported}<span class="mal" title="Imported from MyAnimeList"
                        >MAL</span
                      >{/if}
                  </span>
                </span>
              </button>

              <!--
                The middle of the row: for a series, the season ribbon — one
                segment per season, tinted by what was thought of it, oldest on
                the left, with aired seasons not yet watched drawn hollow. It
                shows what no other surface can: that a twenty-season series was
                loved for fifteen of them and then was not, or that two new ones
                are waiting. Pressing it opens the seasons.

                For a film there is nothing to draw over time, so the synopsis
                is what says what the row is about.
              -->
              {#if group.type === 'tv' && (!group.flat || seasonsToGo(group, facts?.airedSeasons ?? null) > 0)}
                {@const strip = ribbon(group, RIBBON_LIMIT, facts?.airedSeasons ?? null)}
                <div class="middle">
                  <button
                    class="ribbon"
                    onclick={() => !group.flat && toggle(group)}
                    aria-expanded={group.flat ? undefined : open}
                    aria-label="{ribbonCaption(group, facts)} — {summaryLabel(group)}"
                  >
                    {#if strip.hidden > 0}
                      <span class="rib-more">+{strip.hidden}</span>
                    {/if}
                    {#each strip.segments as segment (segment.key)}
                      {@const band = bandOf(segment.rating)}
                      <span
                        class="rib"
                        class:pending={segment.pending}
                        class:liked={band === 'liked'}
                        class:mixed={band === 'mixed'}
                        class:disliked={band === 'disliked'}
                        title={segment.pending
                          ? segment.label
                          : `${segment.label} · ${ratingWord(segment.rating)}`}
                      ></span>
                    {/each}
                  </button>
                  <span class="caption-line" class:ahead={seasonsToGo(group, facts?.airedSeasons ?? null) > 0}>
                    {ribbonCaption(group, facts)}
                  </span>
                </div>
              {:else if facts?.overview}
                <p class="middle overview">{facts.overview}</p>
              {:else}
                <span class="middle"></span>
              {/if}

              <span class="score"><Score rating={group.score} /></span>

              <!--
                A flat row rates inline; a multi-season one has nothing to rate
                at the title level, because 1.5.7 made the rating a per-season
                thing. Its mean is derived from the seasons, not set, so it is
                printed in the meta line rather than offered as a control.
              -->
              {#if group.flat}
                <RatingStrip
                  media={asMedia(group.seasons[0]!.entry)}
                  form="compact"
                  season={group.seasons[0]!.entry.season}
                />
              {:else}
                <!-- Holds the chip's column, so every row's ✕ lines up. -->
                <span class="chip-slot" aria-hidden="true"></span>
              {/if}

              <button
                class="drop"
                onclick={() => library.removeFromWatched(group.tmdbId || 0, undefined)}
                aria-label="Remove {group.title} from watched"
                title={group.flat ? 'Remove from watched' : 'Remove every season'}>✕</button
              >
            </div>

            {#if open && !group.flat}
              <ul class="seasons" in:expandIn|local out:expandOut|local>
                {#each group.seasons as season (season.entry.id)}
                  <li class="season">
                    <button class="season-name" onclick={() => onselect(asMedia(season.entry))}>
                      {season.entry.season === null
                        ? 'Whole series'
                        : `Season ${season.entry.season}`}
                    </button>
                    <RatingStrip
                      media={asMedia(season.entry)}
                      form="compact"
                      season={season.entry.season}
                    />
                    <button
                      class="drop"
                      onclick={() =>
                        library.removeFromWatched(season.entry.tmdbId, season.entry.season)}
                      aria-label="Remove {group.title} season from watched"
                      title="Remove this season">✕</button
                    >
                  </li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .watched {
    padding: var(--space-5) var(--space-6) var(--space-8);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .filters {
    display: flex;
    gap: var(--space-1);
  }

  .filters button {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    background: var(--bg-raised);
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }

  .filters button.active {
    background: var(--accent);
    color: var(--text-on-accent);
  }

  .badge {
    font-size: 10px;
    padding: 0 5px;
    border-radius: var(--radius-full);
    background: var(--accent);
    color: var(--text-on-accent);
  }

  /* The band's range, beside its name: quieter than the label it qualifies. */
  .range {
    font-variant-numeric: tabular-nums;
    opacity: 0.65;
  }

  .filters button.active .badge {
    background: rgb(0 0 0 / 22%);
    color: inherit;
  }

  /*
    The same height and outline as the filter box, so the header's two text
    controls read as a pair; the chevron is what says "menu" rather than
    "toggle". The native select stays underneath for the keyboard and for
    screen readers, stripped of its own look.
  */
  .sort {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3) 0 var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-full);
    background: var(--bg-elevated);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: border-color var(--dur-fast) var(--ease-out);
  }

  .sort:hover,
  .sort:focus-within {
    border-color: var(--border-strong);
  }

  .sort-glyph,
  .sort-chevron {
    width: 14px;
    height: 14px;
    flex: none;
    fill: none;
    stroke: var(--text-tertiary);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    pointer-events: none;
  }

  .sort-label {
    color: var(--text-tertiary);
    white-space: nowrap;
  }

  .sort select {
    appearance: none;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    font-weight: var(--weight-emphasis);
    /* Room for the chevron, which sits over the select's right end. */
    padding: var(--space-2) 22px var(--space-2) 0;
    margin-right: -20px;
    cursor: pointer;
  }

  /*
    The pill shows focus, so the select inside it must not show its own: two
    rings, one inside the other. The app's ring is a box-shadow, not an
    outline (`:focus-visible` in global.css), so both go. Android's WebView
    counts a tapped select as focus-visible, so on the phone the second ring
    appeared after every pick, not only under the keyboard.
  */
  .sort select:focus {
    outline: none;
    box-shadow: none;
  }

  .sort:has(select:focus-visible) {
    border-color: var(--accent);
  }

  .sort option {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }

  /* ── The band ─────────────────────────────────────────────────────── */

  .band {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: var(--space-2);
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    background: var(--bg-raised);
    border: 1px solid transparent;
    text-align: left;
    min-width: 0;
  }

  .stat.wide {
    background: linear-gradient(140deg, var(--accent-subtle), var(--bg-raised) 70%);
  }

  .stat.act {
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }

  .stat.act:hover {
    background: var(--bg-elevated);
  }

  /* The tile and the filter pill are the same control; both light up. */
  .stat.act.on {
    border-color: var(--accent);
    background: var(--accent-subtle);
  }

  .figure {
    font-size: var(--text-xl);
    font-weight: var(--weight-bold);
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
    line-height: var(--leading-tight);
  }

  .figure.liked {
    color: var(--rating-liked);
  }

  .figure.mixed {
    color: var(--rating-mixed);
  }

  .figure.disliked {
    color: var(--rating-disliked);
  }

  /* A title is not a number and cannot be set like one. */
  .figure.small {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    line-height: var(--leading-snug);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stat .label {
    font-size: var(--text-2xs);
    letter-spacing: var(--tracking-caps);
    text-transform: uppercase;
    color: var(--text-tertiary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .deep {
    grid-column: span 2;
    position: relative;
    overflow: hidden;
    justify-content: center;
  }

  /* The series' own artwork, fading out under the words on the left. */
  .deep-art {
    position: absolute;
    inset: 0 0 0 30%;
    width: 70%;
    height: 100%;
    object-fit: cover;
    mask-image: linear-gradient(90deg, transparent, #000 60%);
    opacity: 0.55;
    pointer-events: none;
    transition: opacity var(--dur-fast) var(--ease-out);
  }

  .deep:hover .deep-art {
    opacity: 0.8;
  }

  .deep .figure,
  .deep .label {
    position: relative;
  }

  .meter {
    display: flex;
    gap: 2px;
    height: 10px;
    border-radius: var(--radius-full);
    overflow: hidden;
    background: var(--bg-raised);
  }

  .mseg {
    min-width: 0;
    padding: 0;
    border-radius: 2px;
    transition:
      filter var(--dur-fast) var(--ease-out),
      opacity var(--dur-fast) var(--ease-out);
  }

  .mseg:hover {
    filter: brightness(1.25);
  }

  .mseg.liked {
    background: var(--rating-liked);
  }

  .mseg.mixed {
    background: var(--rating-mixed);
  }

  .mseg.disliked {
    background: var(--rating-disliked);
  }

  .mseg.blank {
    background: var(--bg-hover);
  }

  .caption {
    margin: calc(var(--space-2) * -1) 0 0;
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }

  .caption-dim {
    color: var(--text-tertiary);
  }

  .link {
    color: var(--accent);
    font-size: inherit;
  }

  .link:hover {
    text-decoration: underline;
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .row {
    display: grid;
    /*
      The third column is the ribbon or the synopsis, and it is why the row no
      longer has a thousand pixels of nothing between the title and the score.
      The identity column is capped rather than a fraction: as `1.2fr` it was
      nine hundred pixels wide for three hundred of title, and the ribbon
      started adrift of the words it belongs to.
    */
    grid-template-columns: 22px minmax(0, 620px) minmax(0, 1fr) auto auto auto;
    align-items: center;
    gap: var(--space-3);
    position: relative;
    padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4);
    border-radius: var(--radius-md);
    transition: background var(--dur-fast) var(--ease-out);
  }

  /*
   * The tinted rail.
   *
   * A pseudo-element rather than `border-left`, which follows the 12px corner
   * radius and renders as a short line floating clear of the row. This is
   * flush, full height, and rounded on its own terms.
   *
   * Deliberately faint. In a real library nearly every row is tinted — 196 of
   * 196 here — so at full strength it is a stripe pattern carrying no
   * information. At this weight it is a texture that resolves when you look
   * for it and disappears when you are reading titles, which is the only way
   * a per-row signal earns its place in a list this long.
   */
  .row::before {
    content: '';
    position: absolute;
    left: 0;
    top: var(--space-1);
    bottom: var(--space-1);
    width: 3px;
    border-radius: var(--radius-full);
    background: transparent;
    transition: background var(--dur-fast) var(--ease-out);
  }

  .row.liked::before {
    background: color-mix(in srgb, var(--rating-liked) 32%, transparent);
  }

  .row.mixed::before {
    background: color-mix(in srgb, var(--rating-mixed) 34%, transparent);
  }

  .row.disliked::before {
    background: color-mix(in srgb, var(--rating-disliked) 38%, transparent);
  }

  /* Full strength on the row under the pointer: the one you are asking about. */
  .row.liked:hover::before {
    background: var(--rating-liked);
  }

  .row.mixed:hover::before {
    background: var(--rating-mixed);
  }

  .row.disliked:hover::before {
    background: var(--rating-disliked);
  }

  .row:hover {
    background: var(--bg-raised);
  }

  .chev {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: var(--radius-sm);
    color: var(--text-tertiary);
  }

  .chev.placeholder {
    pointer-events: none;
  }

  .arrow {
    display: block;
    font-size: 11px;
    transition: transform var(--dur-fast) var(--ease-out);
  }

  .arrow.down {
    transform: rotate(90deg);
  }

  .ident {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    min-width: 0;
    text-align: left;
  }

  /* ── The cover ────────────────────────────────────────────────────── */

  .cover {
    position: relative;
    flex: none;
    width: 192px;
    aspect-ratio: 16 / 9;
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--bg-elevated);
    box-shadow: var(--edge-highlight);
  }

  .cover img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  .cover-blur {
    object-fit: cover;
    filter: blur(14px) brightness(0.55);
    transform: scale(1.2);
  }

  .cover-poster {
    object-fit: contain;
  }

  /* Over the poster, so arriving is a fade rather than a swap. */
  .cover-wide {
    object-fit: cover;
    animation: cover-in var(--dur-mid) var(--ease-out);
  }

  @keyframes cover-in {
    from {
      opacity: 0;
    }
  }

  .cover-letter {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--text-tertiary);
    font-size: var(--text-lg);
  }

  .row:hover .cover {
    box-shadow:
      var(--edge-highlight),
      0 0 0 1px var(--border-strong);
  }

  .names {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .name {
    font-size: var(--text-md);
    font-weight: var(--weight-emphasis);
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1);
    /* Break between the phrases, never inside one: on a phone-width row
       "2 seasons · avg 8.0" otherwise wrapped as "2 / seasons · / avg / 8.0". */
    white-space: nowrap;
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }

  .dot {
    color: var(--text-tertiary);
  }

  .facts {
    font-size: var(--text-xs);
    color: var(--text-tertiary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status {
    font-size: var(--text-2xs);
    padding: 0 6px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border-default);
    color: var(--text-tertiary);
  }

  /* Still airing is the state that can change what the user does next. */
  .status.live {
    border-color: color-mix(in srgb, var(--accent) 45%, transparent);
    color: var(--accent);
  }

  /* ── The middle ───────────────────────────────────────────────────── */

  .middle {
    min-width: 0;
  }

  div.middle {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .overview {
    margin: 0;
    max-width: 96ch;
    font-size: var(--text-xs);
    line-height: var(--leading-normal);
    color: var(--text-tertiary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .row:hover .overview {
    color: var(--text-secondary);
  }

  .caption-line {
    padding: 0 var(--space-2);
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
  }

  /* Seasons waiting to be watched are the news in this row. */
  .caption-line.ahead {
    color: var(--accent);
  }

  .mal {
    font-size: 9px;
    letter-spacing: 0.04em;
    padding: 0 4px;
    border-radius: var(--radius-sm);
    background: var(--bg-raised);
    color: var(--text-tertiary);
  }

  /* ── The season ribbon ────────────────────────────────────────────── */

  .ribbon {
    display: flex;
    align-items: center;
    gap: 3px;
    height: 22px;
    min-width: 0;
    padding: 0 var(--space-2);
  }

  .rib {
    flex: 1;
    min-width: 4px;
    max-width: 34px;
    height: 10px;
    border-radius: var(--radius-full);
    /* Unrated is a real state and reads as one: present, and empty. */
    background: var(--bg-hover);
    transition:
      height var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }

  .rib.liked {
    background: color-mix(in srgb, var(--rating-liked) 62%, transparent);
  }

  .rib.mixed {
    background: color-mix(in srgb, var(--rating-mixed) 62%, transparent);
  }

  .rib.disliked {
    background: color-mix(in srgb, var(--rating-disliked) 62%, transparent);
  }

  /* Aired and not watched: an outline, the shape of a season still to come. */
  .rib.pending {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--border-strong);
  }

  /* Full strength, and taller, on the row being asked about. */
  .row:hover .rib {
    height: 14px;
  }

  .row:hover .rib.liked {
    background: var(--rating-liked);
  }

  .row:hover .rib.mixed {
    background: var(--rating-mixed);
  }

  .row:hover .rib.disliked {
    background: var(--rating-disliked);
  }

  .rib-more {
    flex: none;
    font-size: var(--text-2xs);
    color: var(--text-tertiary);
    font-variant-numeric: tabular-nums;
  }

  /*
    On a phone the ribbon is the first thing to go.

    Not a nicety: `.rib` carries a 4px floor so a twenty-season strip stays
    made of targets rather than hairlines, and twenty of those in a flex row
    overflow a 402px grid track that has already shrunk to zero — twelve
    pixels of horizontal scroll across the whole page, measured at 412px.

    After the `.ribbon` rules it overrides, not next to the `.row` grid it
    also changes: same specificity means source order decides, and declared
    up there it lost to the `display: flex` down here.
  */
  /*
    The phone keeps the identity and the user's own rating, and gives up the
    rest to make room for the title. At 412px the desktop's columns left the
    name 45px — "D." for Dune — so the ribbon goes, TMDB's score goes (it is
    one tap away in the detail sheet; the chip beside it is the user's own
    verdict, which is what this list is for), and the cover and the gaps get
    smaller. The name gets about 100px, and two lines of it.
  */
  @media (max-width: 760px) {
    .row {
      grid-template-columns: 22px minmax(0, 1fr) auto auto;
      gap: var(--space-2);
      padding-left: var(--space-2);
    }

    /* Two lines rather than an ellipsis: ninety pixels is "Everythin…". */
    .name {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      -webkit-box-orient: vertical;
      white-space: normal;
      line-height: var(--leading-tight);
    }

    .middle,
    .score {
      display: none !important;
    }

    .ident {
      gap: var(--space-3);
    }

    .cover {
      width: 96px;
    }

  }

  /* The width of RatingStrip's compact chip, which it stands in for. */
  .chip-slot {
    width: 40px;
  }

  .drop {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border-radius: var(--radius-full);
    color: var(--text-tertiary);
    transition:
      color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }

  .drop:hover {
    color: #fff;
    background: var(--danger);
  }

  .seasons {
    list-style: none;
    margin: 0;
    /* Indented to line up under the title, so the hierarchy is readable
       without a second border or a background. */
    padding: var(--space-1) 0 var(--space-2) calc(22px + var(--space-3) + 192px + var(--space-4));
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  /* The phone's narrower row, above; declared here so it follows the rule it overrides. */
  @media (max-width: 760px) {
    .seasons {
      padding-left: calc(22px + var(--space-2) + 96px + var(--space-3));
    }
  }

  .season {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-sm);
    transition: background var(--dur-fast) var(--ease-out);
  }

  .season:hover {
    background: var(--bg-raised);
  }

  .season-name {
    text-align: left;
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }

  .empty {
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }
</style>
