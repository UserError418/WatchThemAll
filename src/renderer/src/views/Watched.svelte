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
   * Deliberately no large artwork here, unlike the Watchlist. That tab is a
   * dashboard of things in flight and holds nineteen entries; this one is an
   * archive an order of magnitude bigger, where every pixel of poster is a row
   * that does not fit on screen.
   *
   * The folding, the band counts, the means and the sort live in
   * `watchedgroups.ts` with their tests. This file is layout.
   */
  import type { MediaSummary, RatingValue, WatchedEntry } from '@shared/types'
  import type { RatingBand } from '@shared/rating'
  import { library } from '../lib/library.svelte'
  import { posterUrl } from '../lib/images'
  import {
    bandOf,
    deepest,
    groupWatched,
    leaning,
    ribbon,
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
  let sort = $state<WatchedSort>('recent')

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

  /** A band tile and a meter segment are the same filter, and toggle back to All. */
  function toggleFilter(band: Filter): void {
    filter = filter === band ? 'all' : band
  }
</script>

<div class="watched">
  <header>
    <div class="title">
      <h1>Watched</h1>
      <span class="count">{totals.titles} titles · {totals.seasons} seasons</span>
    </div>

    <div class="tools">
      <input
        bind:value={query}
        type="search"
        placeholder="Filter by title…"
        aria-label="Filter watched titles"
      />
      <div class="filters">
        {#each FILTERS as f (f.id)}
          <button class:active={filter === f.id} onclick={() => (filter = f.id)}>
            {f.label}
            {#if f.range}<span class="range">{f.range}</span>{/if}
            {#if f.id === 'unrated' && unratedCount > 0}<span class="badge">{unratedCount}</span
              >{/if}
          </button>
        {/each}
      </div>
      <label class="sort">
        <span class="sr">Sort by</span>
        <select bind:value={sort}>
          {#each WATCHED_SORTS as option (option.id)}
            <option value={option.id}>{option.label}</option>
          {/each}
        </select>
      </label>
    </div>
  </header>

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
        <button class="stat act deep" onclick={() => onselect(asMedia(top.seasons[0]!.entry))}>
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
          <li class="group" class:open in:fly={stagger(index, 14, 10)}>
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
                {#if posterUrl(group.posterPath, 'w154')}
                  <img
                    class="thumb"
                    src={posterUrl(group.posterPath, 'w154')}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    width="40"
                    height="60"
                  />
                {:else}
                  <span class="thumb blank" aria-hidden="true">{group.title.slice(0, 1)}</span>
                {/if}

                <span class="names">
                  <span class="name">{group.title}</span>
                  <span class="meta">
                    {seasonSummary(group)}
                    <!-- The mean, for a series; a flat row's chip already shows its number. -->
                    {#if !group.flat && summaryLabel(group)}<span class="dot">·</span
                      >{summaryLabel(group)}{/if}
                    {#if group.imported}<span class="mal" title="Imported from MyAnimeList"
                        >MAL</span
                      >{/if}
                  </span>
                </span>
              </button>

              <!--
                The season ribbon: one segment per season, tinted by what was
                thought of it, oldest on the left.

                This is what the middle of the row is for, and it is the only
                thing on the page that shows the *shape* of an opinion — that
                a twenty-season series was loved for fifteen of them and then
                was not. Pressing it opens the seasons, which is the question
                it provokes.
              -->
              {#if !group.flat}
                {@const strip = ribbon(group)}
                <button
                  class="ribbon"
                  onclick={() => toggle(group)}
                  aria-expanded={open}
                  aria-label="{group.seasons.length} seasons — {summaryLabel(group)}"
                >
                  {#if strip.hidden > 0}
                    <span class="rib-more">+{strip.hidden}</span>
                  {/if}
                  {#each strip.segments as segment (segment.key)}
                    {@const band = bandOf(segment.rating)}
                    <span
                      class="rib"
                      class:liked={band === 'liked'}
                      class:mixed={band === 'mixed'}
                      class:disliked={band === 'disliked'}
                      title="{segment.label} · {ratingWord(segment.rating)}"
                    ></span>
                  {/each}
                </button>
              {:else}
                <span class="ribbon"></span>
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

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }

  .title {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
  }

  h1 {
    margin: 0;
    font-size: var(--text-xl);
  }

  .count {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .tools {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  input[type='search'] {
    width: 200px;
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    background: var(--bg-raised);
    color: var(--text-primary);
    font-size: var(--text-xs);
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

  .sort select {
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-full);
    background: var(--bg-raised);
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
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
      The third column is the ribbon, and it is why the row no longer has a
      few hundred pixels of nothing between the title and the score. The
      identity column is a fixed measure rather than a fraction: as `1.2fr` it
      was nine hundred pixels wide for three hundred of title, and the ribbon
      started adrift of the words it belongs to.
    */
    grid-template-columns: 22px minmax(0, 460px) minmax(0, 1fr) auto auto auto;
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
    gap: var(--space-3);
    min-width: 0;
    text-align: left;
  }

  .thumb {
    width: 40px;
    height: 60px;
    flex: none;
    border-radius: var(--radius-sm);
    object-fit: cover;
    background: var(--bg-raised);
  }

  .thumb.blank {
    display: grid;
    place-items: center;
    color: var(--text-tertiary);
    font-size: var(--text-sm);
  }

  .names {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .name {
    font-size: var(--text-sm);
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }

  .dot {
    color: var(--text-tertiary);
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
    max-width: 26px;
    height: 8px;
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
  @media (max-width: 760px) {
    .row {
      grid-template-columns: 22px minmax(0, 1fr) auto auto auto;
    }

    .ribbon {
      display: none;
    }
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
    padding: var(--space-1) 0 var(--space-2) calc(22px + var(--space-3) + 40px + var(--space-3));
    display: flex;
    flex-direction: column;
    gap: 1px;
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
