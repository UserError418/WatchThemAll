/**
 * The renderer's view of the user's data.
 *
 * One reactive module, loaded once at startup, mutated through named
 * operations. Views read from it; they never fetch or persist for themselves.
 *
 * Writes are optimistic: the local state changes immediately and is pushed to
 * the main process afterwards. Every operation here is a small mutation of a
 * document already in memory, so waiting for a disk round trip before showing
 * the result only makes the UI feel slow.
 */

import type {
  HistoryEntry,
  MediaDetail,
  MediaSummary,
  MediaType,
  Provider,
  ReleaseTracker,
  ResumePoint,
  StoreShape,
  StorePatch,
  RatingValue,
  TitleRating,
  WatchedEntry,
  WatchlistEntry,
} from '@shared/types'
import { resumeKey, type SourceSortKey } from '@shared/types'
import { isListed } from '@shared/listed'
import { legacyRatingOf, ratingForEntry, ratingForScope } from '@shared/rating'
import { chooseActiveProviders } from './activeproviders'
import { DEFAULT_SETTINGS } from '@shared/store/core'

/** `crypto.randomUUID` needs a secure context; file:// in Electron qualifies. */
const newId = (): string => crypto.randomUUID()

/** Episodes are keyed `"season:episode"` in `watchedEpisodes`. */
export const episodeKey = (season: number, episode: number): string => `${season}:${episode}`

/**
 * A history list in the order a timeline needs, newest first.
 *
 * Applied on every read from the store, because the stored order is not the
 * timeline order and was never going to be. `StoreCore.replaceAll` walks the
 * records it already holds before appending the ones it does not, so a
 * collection rewritten wholesale on every change settles into the order things
 * were *first* written, permuted by every dedupe since. A real five-row history
 * read 6 Sep, 6 Sep, 12 Sep, 12 Sep, 12 Sep in that order — which is no order
 * at all, and is what "history stopped working" looked like from outside.
 *
 * Sorted here rather than in the view so every consumer agrees: `ContinueRow`
 * and the taste weighting both read `library.history` and both treat position
 * as recency.
 */
function newestFirst(entries: HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => b.watchedAt - a.watchedAt)
}

class Library {
  watchlist = $state<WatchlistEntry[]>([])
  trackers = $state<ReleaseTracker[]>([])
  history = $state<HistoryEntry[]>([])
  providers = $state<Provider[]>([])
  customProviders = $state<Provider[]>([])
  activeProviderIds = $state<string[]>([])
  /** Every provider this install has been offered; see `load()`. */
  knownProviderIds = $state<string[]>([])
  /** Providers to try first in Automatic; see `automaticOrder` in main. */
  favouriteProviderIds = $state<string[]>([])
  /**
   * The user's global provider order, best first.
   *
   * Seeded by main at startup, so this is never empty in practice — but a
   * provider added by a catalogue refresh since the last drag will be missing
   * from it, and `orderedProviders` puts those last rather than pretending they
   * were placed.
   */
  providerOrder = $state<string[]>([])
  /** Where each thing was left; written by main as playback ends. */
  resumePoints = $state<ResumePoint[]>([])
  /** Titles the user has already seen. See the Watched tab. */
  watched = $state<WatchedEntry[]>([])
  /** The user's own 1–10 ratings, which steer the tailored Browse row. */
  ratings = $state<TitleRating[]>([])
  // The store's own defaults rather than a copy: a copy here already lacked a
  // field once, and the renderer would have shown the wrong order until load.
  settings = $state<StoreShape['settings']>({ ...DEFAULT_SETTINGS, sourceOrder: [...DEFAULT_SETTINGS.sourceOrder] })

  loaded = $state(false)

  /**
   * Set when a write to disk failed. Surfaced in the UI rather than only
   * logged — an optimistic update that never reached disk looks identical to a
   * successful one until the app is restarted, which is the worst way to find
   * out.
   */
  persistError = $state<string | null>(null)

  /* ── Loading ────────────────────────────────────────────────────────── */

  async load(): Promise<void> {
    const [store, providers] = await Promise.all([
      window.wta.store.read(),
      window.wta.providers.list(),
    ])
    this.watchlist = store.watchlist
    this.trackers = store.trackers
    this.history = newestFirst(store.history)
    this.settings = store.settings
    // `providers.list()` already returns catalog + custom merged; the separate
    // copy is what gets persisted, so the two must not be conflated.
    this.providers = providers
    this.customProviders = store.customProviders
    this.watched = store.watched ?? []
    this.ratings = store.ratings ?? []
    this.favouriteProviderIds = store.favouriteProviderIds ?? []
    this.providerOrder = store.providerOrder ?? []
    this.resumePoints = store.resumePoints ?? []

    /**
     * Which providers are switched on.
     *
     * The decision is in `chooseActiveProviders`, not here: it has been wrong
     * twice and both times silently, so it is a pure function with tests rather
     * than a few lines in a loader. See that module for the three cases it
     * separates.
     */
    const decision = chooseActiveProviders({
      stored: store.activeProviderIds,
      known: store.knownProviderIds,
      catalogue: providers,
    })
    this.activeProviderIds = decision.active
    this.knownProviderIds = decision.known
    if (decision.changed) {
      void this.persist({
        activeProviderIds: this.activeProviderIds,
        knownProviderIds: this.knownProviderIds,
      })
    }

    this.loaded = true

    void this.backfillArtwork()
  }

  /**
   * Fill in artwork for entries that were saved without any.
   *
   * Entries migrated from the original app carry a title and an id but no
   * poster path, because the old data model never stored one — so they render
   * as a bare letter tile in a UI that is otherwise built entirely on cover
   * art. The ids are enough to recover the artwork, so recover it once and
   * write it back rather than falling back forever.
   *
   * Runs after `load()` resolves, so it never delays first paint, and is
   * deliberately sequential: this is repairing a handful of old records, not a
   * reason to open a dozen concurrent connections at startup.
   */
  private async backfillArtwork(): Promise<void> {
    const missing = [
      ...this.watchlist.filter((w) => !w.posterPath),
      ...this.trackers.filter((t) => !t.posterPath),
    ]
    if (missing.length === 0) return

    // One request per distinct title, even when it is both tracked and saved.
    const seen: number[] = []
    let repaired = false

    for (const entry of missing) {
      if (seen.includes(entry.tmdbId)) continue
      seen.push(entry.tmdbId)

      const type = 'type' in entry ? entry.type : 'tv'
      let posterPath: string | null
      try {
        posterPath = (await window.wta.tmdb.detail(entry.tmdbId, type))?.posterPath ?? null
      } catch (err) {
        // A title that has since been removed from TMDB must not stop the
        // rest of the repair, and is not worth telling the user about.
        console.warn(`[library] could not backfill artwork for ${entry.title}:`, err)
        continue
      }
      if (!posterPath) continue

      for (const w of this.watchlist) if (w.tmdbId === entry.tmdbId) w.posterPath = posterPath
      for (const t of this.trackers) if (t.tmdbId === entry.tmdbId) t.posterPath = posterPath
      repaired = true
    }

    if (repaired) void this.persist({ watchlist: this.watchlist, trackers: this.trackers })
  }

  /** Re-read from disk. Used when the main process reports a background change. */
  async reload(): Promise<void> {
    const store = await window.wta.store.read()
    this.watchlist = store.watchlist
    this.trackers = store.trackers
    this.history = newestFirst(store.history)
    this.settings = store.settings
    this.activeProviderIds = store.activeProviderIds
    this.knownProviderIds = store.knownProviderIds ?? []
    this.favouriteProviderIds = store.favouriteProviderIds ?? []
    this.providerOrder = store.providerOrder ?? []
    this.resumePoints = store.resumePoints ?? []
    this.customProviders = store.customProviders
    this.watched = store.watched ?? []
    this.ratings = store.ratings ?? []
  }

  /**
   * Push a change to the main process.
   *
   * `$state.snapshot` is not optional here. Reactive state is a Proxy, and
   * `structuredClone` — which is what the context bridge and IPC use — throws
   * "An object could not be cloned" on one. Without the snapshot every write
   * fails, the catch below logs it, and the UI still shows the optimistic
   * update: the app looks perfectly healthy until it is restarted and the
   * changes are gone.
   */
  private async persist(patch: StorePatch): Promise<void> {
    try {
      await window.wta.store.write($state.snapshot(patch) as StorePatch)
      this.persistError = null
    } catch (err) {
      this.persistError = err instanceof Error ? err.message : 'Could not save your change to disk'
      console.error('[library] could not persist change:', err)
    }
  }

  /* ── Watchlist ──────────────────────────────────────────────────────── */

  /**
   * The user's watchlist: every entry except the unlisted ones kept only for
   * their ticks. What the Watchlist tab, its count and everything built on
   * "what am I watching" read. See `WatchlistEntry.listed`.
   */
  get listedWatchlist(): WatchlistEntry[] {
    return this.watchlist.filter(isListed)
  }

  isInWatchlist(tmdbId: number): boolean {
    return this.watchlist.some((w) => w.tmdbId === tmdbId && isListed(w))
  }

  /** The title's entry, listed or not — where its ticks, position and source live. */
  watchlistEntry(tmdbId: number): WatchlistEntry | undefined {
    return this.watchlist.find((w) => w.tmdbId === tmdbId)
  }

  /**
   * Put a title on the watchlist, or list the unlisted entry it already has.
   *
   * Listing keeps everything the entry recorded — the ticks are the reason it
   * existed — and dates the addition now, because that is when the user added
   * it: the Watchlist tab and the background tests both treat a recent
   * addition as the one to get to first.
   */
  addToWatchlist(media: MediaSummary | MediaDetail): WatchlistEntry {
    const existing = this.watchlistEntry(media.tmdbId)
    if (!existing) return this.createEntry(media, true)
    if (isListed(existing)) return existing

    delete existing.listed
    existing.addedAt = Date.now()
    void this.persist({ watchlist: this.watchlist })
    return existing
  }

  /**
   * The title's entry, creating an unlisted one if it has none.
   *
   * For recording something about a title — an episode ticked, a season
   * marked, a source chosen — without putting it on the watchlist. Before
   * this, every one of those added the title, so rating a series (which marks
   * its season watched first) filled the watchlist with things already seen.
   */
  entryFor(media: MediaSummary | MediaDetail): WatchlistEntry {
    return this.watchlistEntry(media.tmdbId) ?? this.createEntry(media, false)
  }

  private createEntry(media: MediaSummary | MediaDetail, listed: boolean): WatchlistEntry {
    const entry: WatchlistEntry = {
      id: newId(),
      tmdbId: media.tmdbId,
      type: media.type,
      title: media.title,
      rating: media.rating ?? 0,
      posterPath: media.posterPath,
      // `?? null` because the field is optional on a summary: absent means
      // "not known yet", which the entry stores as null.
      imdbId: media.imdbId ?? null,
      lastSeason: media.type === 'tv' ? 1 : null,
      lastEpisode: media.type === 'tv' ? 1 : null,
      watchedEpisodes: [],
      episodeMarks: {},
      genreIds: media.genreIds,
      // Present only when added from a detail view; otherwise filled in the
      // first time the title is opened.
      episodeCount: 'episodeCount' in media ? media.episodeCount : null,
      addedAt: Date.now(),
      providerId: this.settings.defaultProviderId,
      // Only written when false, so a listed entry is exactly what it was
      // before the field existed — and what an older build expects to read.
      ...(listed ? {} : { listed: false }),
    }
    this.watchlist = [entry, ...this.watchlist]
    void this.persist({ watchlist: this.watchlist })

    /**
     * Return the entry **as stored**, not the literal above.
     *
     * Assigning to a `$state` array wraps its contents in proxies. The literal
     * is the raw target, so a caller that mutates it writes the value without
     * ever notifying Svelte: the change persists to disk and appears only
     * after a restart. That is exactly how picking a provider for a title that
     * was not yet in the watchlist silently did nothing until relaunch.
     */
    return this.watchlist[0]!
  }

  removeFromWatchlist(tmdbId: number): void {
    this.watchlist = this.watchlist.filter((w) => w.tmdbId !== tmdbId)
    void this.persist({ watchlist: this.watchlist })
  }

  /** Record the IMDB id once the detail view has resolved it. */
  attachImdbId(tmdbId: number, imdbId: string | null): void {
    if (!imdbId) return
    const entry = this.watchlistEntry(tmdbId)
    if (!entry || entry.imdbId === imdbId) return
    entry.imdbId = imdbId
    void this.persist({ watchlist: this.watchlist })
  }

  /**
   * Move the resume position.
   *
   * Non-positive values are rejected. Seasons and episodes are 1-based
   * everywhere, so a 0 means the caller failed to parse something rather than
   * that the user is at episode zero — and the original shipped exactly that:
   * its player preload guessed the episode from the URL, got `Number(null)`
   * back as 0 on path-style providers, and wrote S00E00 over a real position.
   */
  setPosition(tmdbId: number, season: number, episode: number): void {
    if (!Number.isInteger(season) || !Number.isInteger(episode)) return
    if (season < 1 || episode < 1) return

    const entry = this.watchlistEntry(tmdbId)
    if (!entry) return

    /*
     * Never move the position backwards.
     *
     * Leaving an episode settles it in the main process, and leaving is also
     * what happens when the user picks the *next* one — so "E1 finished" and
     * "E2 started" are two writes to this field with no guaranteed order
     * between them. Without this guard the settling of E1 lands last often
     * enough to rewind the position onto an episode already watched to the
     * end, which is what the user sees as a Resume button that will not move
     * on. `resumeTarget` decides where to actually go; this only stops the
     * stored position losing ground.
     */
    const behind =
      entry.lastSeason !== null &&
      entry.lastEpisode !== null &&
      (season < entry.lastSeason ||
        (season === entry.lastSeason && episode < entry.lastEpisode))
    if (behind) return

    entry.lastSeason = season
    entry.lastEpisode = episode
    void this.persist({ watchlist: this.watchlist })
  }

  isWatched(tmdbId: number, season: number, episode: number): boolean {
    return (
      this.watchlistEntry(tmdbId)?.watchedEpisodes.includes(episodeKey(season, episode)) ?? false
    )
  }

  /**
   * Set the watched state of some episodes, stamping each one.
   *
   * The stamps are what let another device's copy of this entry be merged an
   * episode at a time. Before they existed the merge had to union the two
   * lists, which could only ever grow — so un-marking an episode came straight
   * back on the next sync. See `store/merge.ts`.
   *
   * `watchedEpisodes` is *derived* here rather than edited alongside the
   * stamps. Maintaining both by hand is how the two drift apart, and a list
   * that disagrees with its own stamps puts the merge back where it started.
   *
   * Returns whether anything actually changed, so the caller can skip a write.
   */
  private markEpisodes(entry: WatchlistEntry, keys: string[], watched: boolean): boolean {
    const at = Date.now()
    const marks = { ...entry.episodeMarks }
    let changed = false

    for (const key of keys) {
      const current = marks[key]
      if (current !== undefined && current.watched === watched) continue
      // Un-marking an episode that was never marked is not a change worth
      // recording; it would put a stamp in the document saying nothing happened.
      if (current === undefined && !watched && !entry.watchedEpisodes.includes(key)) continue
      marks[key] = { watched, at }
      changed = true
    }
    if (!changed) return false

    entry.episodeMarks = marks
    const order = [...new Set([...entry.watchedEpisodes, ...Object.keys(marks)])]
    entry.watchedEpisodes = order.filter((key) => marks[key]?.watched === true)
    return true
  }

  setWatched(tmdbId: number, season: number, episode: number, watched: boolean): void {
    // Same 1-based guarantee as setPosition: a "0:0" key would be permanent
    // junk in the watched set, counted forever in the progress figure.
    if (!Number.isInteger(season) || !Number.isInteger(episode)) return
    if (season < 1 || episode < 1) return

    const entry = this.watchlistEntry(tmdbId)
    if (!entry) return
    if (!this.markEpisodes(entry, [episodeKey(season, episode)], watched)) return
    void this.persist({ watchlist: this.watchlist })
  }

  /** Mark or clear a whole season at once. */
  setSeasonWatched(tmdbId: number, season: number, episodes: number[], watched: boolean): void {
    const entry = this.watchlistEntry(tmdbId)
    if (!entry) return

    const keys = episodes.map((episode) => episodeKey(season, episode))
    if (!this.markEpisodes(entry, keys, watched)) return
    void this.persist({ watchlist: this.watchlist })
  }

  watchedCount(tmdbId: number): number {
    return this.watchlistEntry(tmdbId)?.watchedEpisodes.length ?? 0
  }

  /* ── Release trackers ───────────────────────────────────────────────── */

  isTracked(tmdbId: number): boolean {
    return this.trackers.some((t) => t.tmdbId === tmdbId)
  }

  addTracker(media: MediaSummary | MediaDetail): void {
    if (this.isTracked(media.tmdbId)) return
    const tracker: ReleaseTracker = {
      id: newId(),
      tmdbId: media.tmdbId,
      title: media.title,
      posterPath: media.posterPath,
      status: 'status' in media ? media.status : 'Unknown',
      nextEpisode: 'nextEpisode' in media ? media.nextEpisode : null,
      // Seed the baseline from what has already aired, so adding a tracker
      // does not immediately announce last week's episode.
      lastNotified: 'lastEpisode' in media ? media.lastEpisode : null,
      addedAt: Date.now(),
      lastChecked: 'lastEpisode' in media ? Date.now() : 0,
    }
    this.trackers = [tracker, ...this.trackers]
    void this.persist({ trackers: this.trackers })
  }

  removeTracker(tmdbId: number): void {
    this.trackers = this.trackers.filter((t) => t.tmdbId !== tmdbId)
    void this.persist({ trackers: this.trackers })
  }

  /* ── History ────────────────────────────────────────────────────────── */

  /** Cap kept from the original: history is a timeline, not an archive. */
  private static readonly HISTORY_LIMIT = 2000

  recordWatch(
    media: { tmdbId: number; title: string; posterPath: string | null; type: MediaType },
    season: number | null,
    episode: number | null,
  ): void {
    // Replaying the same episode moves it to the top rather than duplicating.
    const withoutDuplicate = this.history.filter(
      (h) => !(h.tmdbId === media.tmdbId && h.season === season && h.episode === episode),
    )

    const entry: HistoryEntry = {
      id: newId(),
      tmdbId: media.tmdbId,
      type: media.type,
      title: media.title,
      posterPath: media.posterPath,
      season,
      episode,
      watchedAt: Date.now(),
    }

    this.history = newestFirst([entry, ...withoutDuplicate]).slice(0, Library.HISTORY_LIMIT)

    /**
     * Records the *position*, not that it was watched.
     *
     * Starting something is what makes it the place to resume from, so the
     * position moves immediately. Whether it counts as watched is decided on
     * the way out, from how long it actually played — see `settleProgress` in
     * the main process. Ticking the episode off here as well is what made
     * opening a title and backing out mark it watched.
     */
    if (media.type === 'tv' && season != null && episode != null) {
      const watchlistEntry = this.watchlistEntry(media.tmdbId)
      if (watchlistEntry) {
        watchlistEntry.lastSeason = season
        watchlistEntry.lastEpisode = episode
      }
    }

    void this.persist({ history: this.history, watchlist: this.watchlist })
  }

  /**
   * Amend the entry this play created with what the play amounted to.
   *
   * `recordWatch` runs when the player opens and can only record *that* it
   * opened; how long it ran is known exactly once, on the way out. So the two
   * halves are written at different times against the same row, matched on the
   * title and episode rather than on an id — the id never left the renderer,
   * and main, which is what settles the play, has no way to learn it.
   *
   * The newest matching row wins, which is what `findIndex` over a
   * newest-first list gives.
   *
   * `playedMs` accumulates rather than replacing: stepping away from an episode
   * and back inside one session settles twice against the same row, and
   * "eleven minutes, then nine more" is twenty minutes of watching by any
   * reading a user would recognise.
   */
  notePlayback(settled: {
    tmdbId: number
    season: number | null
    episode: number | null
    playedMs: number
    seconds: number | null
    duration: number | null
    watched: boolean
  }): void {
    const at = this.history.findIndex(
      (h) =>
        h.tmdbId === settled.tmdbId && h.season === settled.season && h.episode === settled.episode,
    )
    const existing = at === -1 ? this.openRow(settled) : this.history[at]
    if (!existing) return

    const amended: HistoryEntry = {
      ...existing,
      playedMs: (existing.playedMs ?? 0) + Math.max(0, Math.round(settled.playedMs)),
      // A reading is only worth keeping when the provider gave one; null must
      // not overwrite a position an earlier settle managed to read.
      seconds: settled.seconds ?? existing.seconds ?? null,
      duration: settled.duration ?? existing.duration ?? null,
      completed: existing.completed === true || settled.watched,
    }

    this.history = newestFirst(
      at === -1 ? [amended, ...this.history] : this.history.map((h, i) => (i === at ? amended : h)),
    ).slice(0, Library.HISTORY_LIMIT)
    void this.persist({ history: this.history })
  }

  /**
   * A row for an episode that was never explicitly opened.
   *
   * `recordWatch` runs from the detail overlay's play button, so it sees only
   * the episode the user *chose*. Stepping forward with the player's own next
   * control, or letting it auto-advance at the credits, changes what is playing
   * without going anywhere near that code — which meant an evening spent
   * watching four episodes recorded exactly one. That is the shape of "history
   * stopped tracking what I watched", and it is why this exists.
   *
   * The title and the artwork come from whatever the library already knows
   * about the show: the row for the episode the user did open, failing that the
   * watchlist. If neither knows it, there is nothing worth putting on a
   * timeline and the settle is dropped.
   */
  private openRow(settled: { tmdbId: number; season: number | null; episode: number | null }):
    | HistoryEntry
    | undefined {
    const sibling = this.history.find((h) => h.tmdbId === settled.tmdbId)
    const tracked = this.watchlistEntry(settled.tmdbId)
    const source = sibling ?? tracked
    if (source === undefined) return undefined

    return {
      id: newId(),
      tmdbId: settled.tmdbId,
      type: source.type,
      title: source.title,
      posterPath: source.posterPath,
      season: settled.season,
      episode: settled.episode,
      // The play is being settled now, so now is when it ended. Close enough to
      // when it started for a timeline, and the only honest number available:
      // nothing recorded the moment the player stepped over.
      watchedAt: Date.now(),
    }
  }

  removeHistoryEntry(id: string): void {
    this.history = this.history.filter((h) => h.id !== id)
    void this.persist({ history: this.history })
  }

  clearHistory(): void {
    this.history = []
    void this.persist({ history: [] })
  }

  /* ── Providers ──────────────────────────────────────────────────────── */

  get activeProviders(): Provider[] {
    return this.activeProviderIds
      .map((id) => this.providers.find((p) => p.id === id))
      .filter((p): p is Provider => !!p)
  }

  /**
   * Add a user-defined provider and enable it.
   *
   * Kept separate from the bundled catalog: `customProviders` is persisted and
   * exported, the catalog ships with the app. A rebuild must never drop the
   * user's own entries, and the catalog must never accumulate them.
   */
  addCustomProvider(provider: Provider): void {
    if (this.providers.some((p) => p.id === provider.id)) return
    this.customProviders = [...this.customProviders, provider]
    this.providers = [...this.providers, provider]
    this.activeProviderIds = [...this.activeProviderIds, provider.id]
    void this.persist({
      customProviders: this.customProviders,
      activeProviderIds: this.activeProviderIds,
    })
  }

  removeCustomProvider(id: string): void {
    this.customProviders = this.customProviders.filter((p) => p.id !== id)
    this.providers = this.providers.filter((p) => p.id !== id)
    this.activeProviderIds = this.activeProviderIds.filter((p) => p !== id)
    void this.persist({
      customProviders: this.customProviders,
      activeProviderIds: this.activeProviderIds,
    })
  }

  isCustom(id: string): boolean {
    return this.customProviders.some((p) => p.id === id)
  }

  /**
   * How far into a film the user got, or null if they have not started it.
   *
   * Keyed through the shared `resumeKey` rather than matched on `tmdbId`: TMDB
   * numbers films and series in separate spaces, so the same id can be both,
   * and a loose match would show a series' position on an unrelated film.
   *
   * A film watched to the end has no resume point at all — main drops one past
   * the last twentieth — so this reports nothing rather than a bar stuck at
   * 99% on something already finished.
   */
  filmProgress(tmdbId: number): { percent: number; minutesIn: number } | null {
    return this.progressAt(tmdbId, null, null)
  }

  /**
   * How far into one episode the user got, for the bar under its still.
   *
   * Same source as a film's bar — one stored position per key — because the
   * question is the same one and answering it twice would let the two drift.
   * Null when nothing is stored, so the caller draws no bar at all rather than
   * an empty one: a permanent 0% under every unwatched episode is noise.
   */
  episodeProgress(
    tmdbId: number,
    season: number,
    episode: number,
  ): { percent: number; minutesIn: number } | null {
    return this.progressAt(tmdbId, season, episode)
  }

  private progressAt(
    tmdbId: number,
    season: number | null,
    episode: number | null,
  ): { percent: number; minutesIn: number } | null {
    if (tmdbId === 0) return null
    const key = resumeKey({ tmdbId, season, episode })
    const point = this.resumePoints.find((p) => p.key === key)
    if (!point || point.duration <= 0) return null

    return {
      percent: Math.min(100, Math.round((point.seconds / point.duration) * 100)),
      minutesIn: Math.max(1, Math.round(point.seconds / 60)),
    }
  }

  /**
   * Every known provider in the user's order — the order Automatic walks.
   *
   * The same sort main applies in `automaticOrder`, so the Providers panel and
   * the source pickers list sources in the order they will actually be tried.
   * Anything missing from the saved order keeps its catalogue position at the
   * end; appending is the only safe guess, since inserting a new provider
   * anywhere else would silently move one the user had deliberately placed.
   */
  get orderedProviders(): Provider[] {
    const place = new Map(this.providerOrder.map((id, index) => [id, index]))
    return this.providers
      .map((provider, index) => ({ provider, index }))
      .sort(
        (a, b) =>
          (place.get(a.provider.id) ?? this.providerOrder.length) -
            (place.get(b.provider.id) ?? this.providerOrder.length) || a.index - b.index,
      )
      .map((entry) => entry.provider)
  }

  /**
   * Replace the whole order with one the user dragged out.
   *
   * Takes the complete list rather than a move instruction, because the panel
   * reorders *rows* — and a mirror group is one row holding several providers.
   * Translating "row 4 moved to row 2" back into ids is the panel's job; it is
   * the only thing that knows what a row contains.
   */
  setProviderOrder(ids: string[]): void {
    this.providerOrder = ids
    void this.persist({ providerOrder: ids })
  }

  isFavourite(id: string): boolean {
    return this.favouriteProviderIds.includes(id)
  }

  /**
   * Mark a provider to be tried first in Automatic.
   *
   * Independent of whether it is enabled: favouriting something switched off
   * would be meaningless, but un-favouriting is not a reason to switch anything
   * off, so the two lists never touch each other.
   */
  toggleFavourite(id: string): void {
    this.favouriteProviderIds = this.isFavourite(id)
      ? this.favouriteProviderIds.filter((p) => p !== id)
      : [...this.favouriteProviderIds, id]
    void this.persist({ favouriteProviderIds: this.favouriteProviderIds })
  }

  toggleProvider(id: string): void {
    this.activeProviderIds = this.activeProviderIds.includes(id)
      ? this.activeProviderIds.filter((p) => p !== id)
      : [...this.activeProviderIds, id]
    void this.persist({ activeProviderIds: this.activeProviderIds })
  }

  /**
   * Remember which provider plays a given title.
   *
   * Per-title rather than global because providers carry different catalogues:
   * the one that streams a 2003 series reliably is often not the one that
   * handles this week's episode. A single global choice makes the user re-pick
   * every time they change show, which is why the original's per-bookmark
   * `schemaId` is worth keeping.
   *
   * Stored on the title's entry, which is created unlisted if there is none:
   * choosing a source is not asking for the title on the watchlist — only
   * pressing play is (the owner, 2026-09-26).
   */
  setEntryProvider(media: MediaSummary | MediaDetail, providerId: string | null): void {
    const entry = this.entryFor(media)
    entry.providerId = providerId
    void this.persist({ watchlist: this.watchlist })
  }

  /* ── Watched ─────────────────────────────────────────────────────────── */

  /**
   * Has the user seen this title at all?
   *
   * Named `hasSeen`, not `isWatched`, because `isWatched(tmdbId, season,
   * episode)` above already means something different and narrower — one
   * episode, ticked off inside a watchlist entry. Two methods called the same
   * thing at two levels of granularity is how a caller ends up asking about a
   * series and getting an answer about episode one.
   */
  hasSeen(tmdbId: number): boolean {
    return tmdbId !== 0 && this.watched.some((w) => w.tmdbId === tmdbId)
  }

  /**
   * Whether *this season* has been watched.
   *
   * The distinction `hasSeen` cannot make, and the reason the old behaviour was
   * too blunt: the episode browser ticked off every episode of every season the
   * user opened, because the only question it could ask was about the title. A
   * legacy entry with no season still answers yes for every season, which is
   * what it has always meant.
   */
  hasSeenSeason(tmdbId: number, season: number): boolean {
    if (tmdbId === 0) return false
    return this.watched.some(
      (w) => w.tmdbId === tmdbId && (w.season === null || w.season === season),
    )
  }

  /** Every season of this title that is in the watched list, ascending. */
  seasonsSeen(tmdbId: number): number[] {
    return this.watched
      .filter((w) => w.tmdbId === tmdbId && w.season !== null)
      .map((w) => w.season as number)
      .sort((a, b) => a - b)
  }

  /**
   * Mark a title as seen.
   *
   * Idempotent by TMDB id, and it deliberately does *not* remove the title from
   * the watchlist. Finishing a series and still wanting it in reach is normal —
   * rewatches, or a show with another season coming — and quietly deleting
   * someone's watchlist entry as a side effect of a different action is the kind
   * of helpfulness that loses data.
   */
  addToWatched(
    media: MediaSummary | MediaDetail,
    source: 'user' | 'mal' = 'user',
    season: number | null = null,
  ): WatchedEntry {
    const existing = this.watched.find(
      (w) => w.tmdbId === media.tmdbId && media.tmdbId !== 0 && (w.season ?? null) === season,
    )
    if (existing) return existing

    const entry: WatchedEntry = {
      id: newId(),
      tmdbId: media.tmdbId,
      type: media.type,
      season,
      title: media.title,
      rating: media.rating ?? 0,
      posterPath: media.posterPath,
      imdbId: media.imdbId ?? null,
      genreIds: media.genreIds,
      addedAt: Date.now(),
      source,
      malId: null,
    }
    this.watched = [entry, ...this.watched]
    void this.persist({ watched: this.watched })
    return entry
  }

  /**
   * Mark a *film* seen when all that is known is its id.
   *
   * The playback threshold reports a tmdb id and nothing else, because the main
   * process never held the artwork. Playing something adds it to the watchlist
   * first, so that entry is where the title and poster come from; without one
   * there is nothing to build a row out of and nothing to do.
   *
   * Series are deliberately excluded rather than filed with `season: null`.
   * The caller only lands here for a series when the provider reported no
   * position at all, and a whole-series entry is a much larger claim than the
   * evidence supports — it would put every season in the Watched tab off one
   * unidentified episode. It is also exactly the shape `seasonsplit.ts` exists
   * to remove, so filing it here would make that pass run forever against a
   * library the app keeps re-corrupting.
   */
  markTitleSeen(tmdbId: number): void {
    if (tmdbId === 0 || this.hasSeen(tmdbId)) return
    const entry = this.watchlistEntry(tmdbId)
    if (!entry || entry.type !== 'movie') return

    this.watched = [
      {
        id: newId(),
        tmdbId: entry.tmdbId,
        type: entry.type,
        // Always a film; the guard above turns series away.
        season: null,
        title: entry.title,
        rating: entry.rating,
        posterPath: entry.posterPath,
        imdbId: entry.imdbId,
        genreIds: entry.genreIds,
        addedAt: Date.now(),
        source: 'user',
        malId: null,
      },
      ...this.watched,
    ]
    void this.persist({ watched: this.watched })
  }

  /**
   * Remove a title from Watched, or just one of its seasons.
   *
   * Passing no season removes every entry for the title, which is what the
   * Watched tab's remove button means for a film and what "I have not seen this
   * after all" means for a series. Passing one removes that season only.
   */
  removeFromWatched(tmdbId: number, season: number | null | undefined = undefined): void {
    this.watched = this.watched.filter((w) => {
      if (w.tmdbId !== tmdbId) return true
      return season === undefined ? false : (w.season ?? null) !== season
    })
    void this.persist({ watched: this.watched })
  }

  /* ── Ratings ─────────────────────────────────────────────────────────── */

  /**
   * The user's rating of a title, or of one of its seasons, from 1 to 10.
   *
   * `season` null asks about the series as a whole, which is a different
   * question from "what did you think of season 3" and is stored separately —
   * a show can be worth watching while one season of it is not.
   */
  ratingFor(tmdbId: number, season: number | null = null): RatingValue | null {
    return ratingForScope(this.ratings, tmdbId, season)
  }

  /**
   * Whether the rating at this scope was converted from a like or a dislike
   * rather than chosen on the 1–10 scale — so the control can invite the user
   * to refine it. False when there is no rating at all.
   */
  isCoarse(tmdbId: number, season: number | null = null): boolean {
    return this.ratingRecord(tmdbId, season)?.coarse ?? false
  }

  /**
   * The rating on a watched entry, at whatever scope that entry is about.
   *
   * Preferred over `ratingFor` for anything holding an entry, because the entry
   * already knows its own season and passing one separately is how the Watched
   * tab came to list seasons the user had just rated under "Unrated".
   */
  ratingForEntry(entry: Pick<WatchedEntry, 'tmdbId' | 'season'>): RatingValue | null {
    return ratingForEntry(this.ratings, entry)
  }

  /**
   * Set or change a rating, or clear it by choosing the value it already has.
   *
   * Pressing the rating a title already has clears it, so the same control both
   * states and retracts an opinion. Without that there is no way back from a
   * mis-tap except a separate 'clear' affordance nobody would look for.
   *
   * The one exception is a `coarse` rating — an 8 or a 4 converted from a
   * thumb. Its lit value is not one the user ever picked, so tapping it is
   * read as "yes, that one" and confirms it rather than deleting it. Clearing
   * there would turn the most natural response to the "tap to refine" hint
   * into the loss of an opinion the user has held since before the scale
   * existed. A second tap, on what is now a chosen value, clears as usual.
   *
   * Anything set here is chosen on the scale, so it is never `coarse`.
   */
  rate(media: MediaSummary | MediaDetail, value: RatingValue, season: number | null = null): void {
    const current = this.ratingRecord(media.tmdbId, season)
    if (current?.value === value && !current.coarse) {
      this.clearRating(media, season)
      return
    }

    const base = `${media.type}:${media.imdbId || media.tmdbId}`
    this.ratings = [
      {
        // The season suffix keeps a whole-title rating on exactly the key
        // it has always had, so nothing already stored is re-identified.
        key: season === null ? base : `${base}:s${season}`,
        tmdbId: media.tmdbId,
        type: media.type,
        season,
        value,
        coarse: false,
        // For builds from before the 1–10 scale; see `TitleRating.rating`.
        rating: legacyRatingOf(value),
        // Copied in rather than looked up later: the taste profile reads
        // every rating, and re-fetching genres per title is what made the
        // original's equivalent one HTTP request per saved show.
        genreIds: media.genreIds,
        at: Date.now(),
      },
      ...this.ratingsExcept(media.tmdbId, season),
    ]
    void this.persist({ ratings: this.ratings })
  }

  /** Remove the rating at exactly this scope, if there is one. */
  clearRating(media: Pick<MediaSummary, 'tmdbId'>, season: number | null = null): void {
    const rest = this.ratingsExcept(media.tmdbId, season)
    if (rest.length === this.ratings.length) return
    this.ratings = rest
    void this.persist({ ratings: this.ratings })
  }

  /** The stored record at exactly this scope — the same rule as `ratingForScope`. */
  private ratingRecord(tmdbId: number, season: number | null): TitleRating | undefined {
    return this.ratings.find((r) => r.tmdbId === tmdbId && (r.season ?? null) === season)
  }

  /** Every rating except the one at exactly this scope. */
  private ratingsExcept(tmdbId: number, season: number | null): TitleRating[] {
    return this.ratings.filter((r) => !(r.tmdbId === tmdbId && (r.season ?? null) === season))
  }

  /** How many rated titles still have no opinion, for the Watched tab's prompt. */
  get unratedWatched(): WatchedEntry[] {
    // Asked at the entry's own scope: a season nobody has rated is still
    // unrated even when the series as a whole has an opinion on it.
    return this.watched.filter((w) => this.ratingForEntry(w) === null)
  }

  /**
   * Record how many episodes a series has, so the watchlist can show progress.
   *
   * Silently does nothing for a title that is not saved — the detail overlay
   * calls this whenever it loads a series, and most of those are not in the
   * watchlist.
   */
  setEpisodeCount(tmdbId: number, count: number): void {
    const entry = this.watchlistEntry(tmdbId)
    if (!entry || count <= 0 || entry.episodeCount === count) return
    entry.episodeCount = count
    void this.persist({ watchlist: this.watchlist })
  }

  /**
   * Refresh the stored score for a saved title.
   *
   * Same bargain as `setEpisodeCount`: the views that list saved titles want to
   * draw a score, and fetching one per title per render was explicitly rejected
   * as a design. So the score is copied in when the detail overlay loads the
   * title, which is the one moment it is known for free, and both the watchlist
   * and the watched list are updated — a title is often in both, and a score
   * that is right in one place and stale in the other is worse than either.
   *
   * Named for the score, as `scoreFor` is. It was `setRating`, which sat one
   * line from `rate` and `clearRating` while writing TMDB's number instead of
   * the user's — the naming trap `scoreFor` below describes.
   */
  setScore(tmdbId: number, score: number): void {
    if (tmdbId === 0 || !(score > 0)) return

    const entry = this.watchlistEntry(tmdbId)
    const seen = this.watched.find((w) => w.tmdbId === tmdbId)
    const stale = (entry && entry.rating !== score) || (seen && seen.rating !== score)
    if (!stale) return

    if (entry) entry.rating = score
    if (seen) seen.rating = score
    void this.persist({ watchlist: this.watchlist, watched: this.watched })
  }

  /**
   * The stored score for a title, from wherever it is saved.
   *
   * Release trackers carry no score of their own and adding one would be a
   * third place for the same number to go stale. A tracked series is
   * essentially always in the watchlist, so reading it from there costs a
   * lookup and keeps one source of truth.
   *
   * Called `scoreFor` and not `ratingFor` because this app has two things
   * called a rating and they are not the same: TMDB's *score* out of ten, and
   * the user's own 1–10 verdict, which `ratingFor` returns. Naming both the
   * same thing is how one gets drawn where the other was meant.
   */
  scoreFor(tmdbId: number): number {
    if (tmdbId === 0) return 0
    return (
      this.watchlistEntry(tmdbId)?.rating ||
      this.watched.find((w) => w.tmdbId === tmdbId)?.rating ||
      0
    )
  }

  setDefaultProvider(id: string | null): void {
    this.settings = { ...this.settings, defaultProviderId: id }
    void this.persist({ settings: this.settings })
  }

  setNotificationsEnabled(enabled: boolean): void {
    this.settings = { ...this.settings, notificationsEnabled: enabled }
    void this.persist({ settings: this.settings })
  }

  /**
   * Sound on previews, everywhere at once.
   *
   * Every preview surface reads `settings.previewAudio` directly rather than
   * keeping its own copy, so muting from a hovered card and muting from the
   * detail billboard are the same act — which is what "global" has to mean for
   * the switch to be worth having.
   */
  setPreviewAudio(on: boolean): void {
    this.settings = { ...this.settings, previewAudio: on }
    void this.persist({ settings: this.settings })
  }

  /**
   * Whether to look up intro timestamps for what is playing.
   *
   * The one setting here that is about privacy rather than taste: with it on,
   * two crowdsourced databases learn which episode is open, by IMDB id.
   */
  setSkipIntro(on: boolean): void {
    this.settings = { ...this.settings, skipIntro: on }
    void this.persist({ settings: this.settings })
  }

  /**
   * How sources are ordered inside each group — works, may work, does not
   * work — for the source lists and Automatic alike. See `scanAwareOrder`.
   */
  setSourceOrder(order: SourceSortKey[]): void {
    this.settings = { ...this.settings, sourceOrder: [...order] }
    void this.persist({ settings: this.settings })
  }
}

export const library = new Library()
