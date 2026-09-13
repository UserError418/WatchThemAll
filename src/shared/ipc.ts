/**
 * The IPC contract.
 *
 * Every channel the renderer can reach is named here once, and `WtaApi` is the
 * exact shape the preload exposes. Main implements it, preload forwards it, the
 * renderer consumes it — all three type-check against this file.
 *
 * The original app had two channels wired into the preload with no handler in
 * main (`select-download-quality`, `get-download-qualities`), so a whole piece
 * of UI silently did nothing. A shared contract makes that a compile error.
 */

import type {
  EpisodeStub,
  MediaDetail,
  MediaSummary,
  MediaType,
  Provider,
  Season,
  StoreShape,
  StorePatch,
} from './types'
import type { SyncStatus } from './sync/types'

/** Invoke channels: renderer → main, with a reply. */
export const CH = {
  storeRead: 'store:read',
  storeWrite: 'store:write',

  tmdbRow: 'tmdb:row',
  tmdbSearch: 'tmdb:search',
  tmdbDetail: 'tmdb:detail',
  tmdbSeason: 'tmdb:season',
  tmdbGenres: 'tmdb:genres',
  tmdbTrailer: 'tmdb:trailer',

  /** Federated search across TMDB and IMDB. */
  search: 'search:all',
  /** Fill in the TMDB id for an IMDB-sourced result. */
  searchResolve: 'search:resolve',

  providersList: 'providers:list',
  /**
   * What has actually streamed for one title, per provider.
   *
   * Replaces the reachability probe this used to sit beside. That probe asked
   * whether the provider's front page answered, which every one of them does —
   * so every dot was green and the indicator carried no information. This asks
   * the only question the user has: did this source ever play *this* show.
   */
  providersOutcomes: 'providers:outcomes',
  /** Ask main what to recommend. See TailoredRequest. */
  tmdbTailored: 'tmdb:tailored',
  playOpen: 'play:open',
  /** Move the video to where the renderer has made room for it. */
  playSetBounds: 'play:set-bounds',
  /** Tear the player down. */
  playClose: 'play:close',
  /** Jump to another episode of the same title. */
  playGoTo: 'play:go-to',
  /** Pick a source explicitly, from the app's own chrome. */
  playSwitchProvider: 'play:switch-provider',
  /** "Keep waiting": stop offering to leave the provider currently loading. */
  playDismissSuggestion: 'play:dismiss-suggestion',
  /** Reload the embed in place, for when a source hangs part-way. */
  playReload: 'play:reload',
  releasesCheck: 'releases:check',

  dataExport: 'data:export',
  dataImport: 'data:import',
  /**
   * Read a MyAnimeList export and describe what it holds.
   *
   * Separate from the commit below because the user reviews in between. The
   * preview is built from the XML alone — no TMDB — so opening a 300-title
   * file is instant and costs nothing if they cancel.
   */
  malPreview: 'mal:preview',
  /** Commit a reviewed import. This is the part that reaches TMDB. */
  malImport: 'mal:import',
  dataDir: 'data:dir',
  /**
   * Hand a URL to the platform's browser.
   *
   * Needed because neither platform lets the app's own page navigate away or
   * open a window: the desktop denies `window.open` outright, and the phone
   * blocks popups in `WebSettings` and refuses third-party main-frame
   * navigations in `PlayerNavigationClient`. Those defences are load-bearing —
   * every provider embed monetises with popunders — so the one legitimate case
   * needs a channel of its own rather than a hole in them.
   */
  openExternal: 'shell:open-external',

  /**
   * Cross-device sync.
   *
   * Sign-in and the network live in main on the desktop: it owns the token
   * store — the OS credential store, which the renderer must never see into —
   * and it can talk to Google without the app window's CSP being widened. The
   * renderer's whole part is four verbs and a status.
   */
  syncStatus: 'sync:status',
  /** Show a code and start polling. Resolves when pairing settles either way. */
  syncConnect: 'sync:connect',
  /** Abandon a pairing that is still on screen. */
  syncCancel: 'sync:cancel',
  /** Forget the account and delete the stored tokens from this device. */
  syncDisconnect: 'sync:disconnect',
  /** Sync now, because the user pressed the button. */
  syncNow: 'sync:now',
} as const

/** Send channels: main → renderer, fire and forget. */
export const EV = {
  /**
   * The floating player chrome, which lives in its own overlay view.
   *
   * Events rather than `CH` channels, deliberately: `CH` is invoke-only — the
   * startup contract check looks for an `ipcMain.handle` for every entry — and
   * these are one-way messages, exactly like `playerNavigate` below.
   *
   * The sender is a different document from the app's page. The controls are
   * mounted in a WebContentsView stacked above the video, because a window's
   * own page can only ever paint beneath its child views.
   */
  chromeOverlayHeight: 'chrome:overlay-height',
  chromeBack: 'chrome:back',
  /**
   * The skip-intro offer, and the view that draws it.
   *
   * A *second* overlay view, not part of the bar, because the button belongs
   * in the bottom-right corner where every other player puts it — and a view
   * swallows every mouse event inside its bounds, so one view cannot cover
   * both corners without making the picture between them unclickable.
   */
  playerSkipOffer: 'evt:player-skip-offer',
  chromeSkipTo: 'chrome:skip-to',
  chromeSkipSize: 'chrome:skip-size',

  menuAction: 'evt:menu-action',
  navigate: 'evt:navigate',
  releaseFound: 'evt:release-found',
  episodeWatched: 'evt:episode-watched',
  playbackSettled: 'evt:playback-settled',
  storeChanged: 'evt:store-changed',
  /**
   * Whether anything is currently playing.
   *
   * The app has to know, because previews must stop while it does — a trailer
   * left running behind the player cannot be silenced by the user: the surface
   * playing it is no longer on screen, so there is nothing to move off and
   * nothing to click.
   */
  playbackActive: 'evt:playback-active',
  /**
   * Where the player is, so the app's chrome can label it.
   *
   * Sent to the *app* window, unlike `playerContext` which goes to the player's
   * own page. The two carry overlapping facts for two different consumers, which
   * is why they are separate channels rather than one shared one.
   */
  playerState: 'evt:player-state',

  /**
   * A provider is taking too long, and there is another one to try.
   *
   * A *suggestion*, not an action. Switching automatically on a slow provider
   * was wrong twice over: some providers genuinely resolve a stream after ten
   * or fifteen seconds, and the switch fired while the user was watching the
   * page work, which reads as the app breaking something that was fine. Only
   * unambiguous failures — a refused connection, a 5xx on the document — still
   * move on their own, because there is nothing there to wait for.
   */
  playerSuggestion: 'evt:player-suggestion',

  /** main → player window: what this window is showing. */
  playerContext: 'evt:player-context',
  /** player window → main: navigate to another episode of the same title. */
  playerNavigate: 'evt:player-navigate',
  /** player window → main: play this title through a different provider. */
  playerSwitchProvider: 'evt:player-switch-provider',
  /** main → player window: a provider failed and playback moved on. */
  playerProviderChanged: 'evt:player-provider-changed',

  /**
   * player view → main → app: the pointer is (or is no longer) near the top.
   *
   * The app's own chrome cannot work this out for itself. The video is a native
   * `WebContentsView` layered over the page, and it swallows every mouse event
   * inside its rectangle — so once the pointer is over the video the renderer
   * sees nothing at all, including the moment it comes back up to the top edge.
   * The only process that can see it is the one inside the view.
   */
  playerPointerTop: 'evt:player-pointer-top',
  syncStatus: 'evt:sync-status',

  /**
   * How far a MAL import has got.
   *
   * An import of a few hundred titles is a few hundred TMDB searches, which is
   * tens of seconds. Without this the dialog is a frozen spinner and the only
   * honest thing it could say is "wait".
   */
  malProgress: 'evt:mal-progress',
} as const

/**
 * What a player window is told about itself.
 *
 * The window cannot work this out from its own URL without guessing, and
 * guessing is what made the original mis-detect episodes on path-style
 * providers. Main knows which template built the URL, so it says.
 */
export interface PlayerContext {
  tmdbId: number
  /**
   * Carried so the chrome can ask for this title's playback record: the
   * outcome log is keyed by `titleKey`, which prefers the IMDB id and only
   * falls back to the TMDB one. Sending a context without it would key the
   * lookup differently from every outcome the player itself writes.
   */
  imdbId: string | null
  type: MediaType
  title: string
  season: number | null
  episode: number | null
  /** Which provider is currently serving this window. */
  providerId: string | null
  providerName: string | null
  /**
   * Every provider that can serve this title, best first — the in-player
   * source switcher is built from this. Sent to the window rather than fetched
   * by it because the window runs inside the provider's own page and must not
   * be able to ask main for anything it was not given.
   */
  providers: Array<{ id: string; name: string }>
}

/**
 * The named browse rows. Kept as a closed set rather than free-form TMDB paths
 * so the renderer cannot ask the main process to fetch an arbitrary URL.
 */
export type RowId = 'trending' | 'topRated' | 'onTheAir' | 'upcoming' | 'popularMovies'

export interface RowRequest {
  row: RowId
  page: number
}

/** A genre row is parameterised, so it is separate from the fixed set above. */
export interface GenreRowRequest {
  genreId: number
  type: MediaType
  page: number
}

/**
 * The bottom of the browse page: keep going.
 *
 * The curated rows are finite and their tail is weak — by the fourth genre
 * shelf the recommendations are neither personal nor interesting. Rather than
 * ending the page there, this pages into TMDB's whole catalogue so scrolling
 * always has somewhere to go.
 *
 * `seed` makes each session's order different without making it random within
 * a session, which would shuffle items under the user as they scroll.
 */
export interface DiscoverRequest {
  discover: true
  type: MediaType
  page: number
  /** Stable per session; picks which slice of the catalogue this run explores. */
  seed: number
}

/**
 * The tailored row on Browse.
 *
 * Unlike every other row request, the renderer does **not** say what to fetch —
 * it asks main "what should I show this person", and main answers from the
 * taste profile. That inversion is the point: the profile is derived from the
 * store, the store lives in main, and having the renderer assemble genre ids to
 * send back would put the recommendation logic in the surface that renders it,
 * where the next surface that wants it would have to reimplement it.
 */
export interface TailoredRequest {
  tailored: true
  page: number
}

/** What the tailored row came back with, and what it was based on. */
export interface TailoredRow {
  items: MediaSummary[]
  /**
   * The genres that drove it, strongest first, for the row's own label.
   *
   * A "for you" row with no stated reason reads as arbitrary. Naming the genre
   * makes it checkable by the user, which is the difference between a
   * recommendation they trust and one they scroll past.
   */
  genreIds: number[]
  /** False when there is too little history to say anything useful. */
  ready: boolean
}

export interface Paged<T> {
  items: T[]
  page: number
  totalPages: number
}

/**
 * Enough to identify a title, without an episode.
 *
 * Deliberately not a `PlayRequest`: the question "which sources work for this
 * show" is not about one episode, and passing a season and episode would invite
 * an episode-level answer that leaves nearly every indicator blank.
 */
export interface TitleRef {
  type: MediaType
  imdbId: string | null
  tmdbId: number
}

/**
 * What we know about one provider for one title.
 *
 * Two states, and *absent* is the meaningful third: a provider that has never
 * been tried is not a provider that failed, and showing them alike is what made
 * the old reachability dot useless. Every provider answered its front page, so
 * every dot was green, so the dot told the user nothing about the only thing
 * they cared about. Absent renders as an empty slot, never as a grey dot — a
 * dot of any colour is a claim, and "no idea" is not one.
 */
export type TitleOutcome = 'failed' | 'worked'

/**
 * Everything the source pickers need to draw one title's provider list.
 *
 * `lastUsed` travels with the outcomes rather than in its own round trip
 * because it is derived from the same log, at the same moment: fetched
 * separately, the dots and the "resume" marker could describe two different
 * instants and disagree about which source is the current one.
 */
export interface TitleProviderState {
  /** Keyed by provider id. Absent means never tried for this title. */
  outcomes: Record<string, TitleOutcome>
  /** The provider that most recently *streamed* this title, if any. */
  lastUsed: string | null
}

/* ── MyAnimeList import ─────────────────────────────────────────────────── */

export type MalStatusId = 'watching' | 'completed' | 'onHold' | 'dropped' | 'planToWatch'

/** Where a status group lands. `skip` drops it. */
export type MalTarget = 'watchlist' | 'watched' | 'releases' | 'skip'

export interface MalPreviewEntry {
  malId: number
  title: string
  status: MalStatusId
  /** 0 when unrated. */
  score: number
  watchedEpisodes: number
  totalEpisodes: number
  seriesType: string
}

export interface MalPreview {
  userName: string | null
  entries: MalPreviewEntry[]
  /** Entries in the file that could not be read. */
  skipped: number
  /** The default routing, so the dialog does not carry its own copy. */
  defaultTargets: Record<MalStatusId, MalTarget>
  defaultSelected: Record<MalStatusId, boolean>
  labels: Record<MalStatusId, string>
}

export interface MalDecisions {
  targets: Record<MalStatusId, MalTarget>
  excludedMalIds: number[]
  applyScores: boolean
}

export interface MalImportSummary {
  watchlist: number
  watched: number
  releases: number
  ratings: number
  unmatched: string[]
  skipped: number
}

/** What the app's player chrome needs to know about what is playing. */
export interface PlayerState {
  title: string
  type: MediaType
  /**
   * Which title is playing, so the chrome can ask for its per-provider
   * outcomes — the same dots the detail view's source picker shows.
   */
  tmdbId: number
  imdbId: string | null
  season: number | null
  episode: number | null
  providerId: string | null
  providerName: string | null
  /** Every provider that could serve this, for the source menu. */
  providers: Array<{ id: string; name: string }>
}

/** An offer to move to another source, raised when the current one stalls. */
export interface PlayerSuggestion {
  /** What went wrong, in the user's words. */
  reason: string
  /** The provider that is stalling. */
  providerName: string
  /** The one we would move to. */
  nextProviderId: string
  nextProviderName: string
}

export interface PlayRequest {
  tmdbId: number
  imdbId: string | null
  type: MediaType
  title: string
  season: number | null
  episode: number | null
  providerId: string | null
  /**
   * How long this runs, in minutes. Null when TMDB does not say.
   *
   * Carried so the main process can decide whether enough of it was watched to
   * count. For a series this is the episode's own runtime when TMDB has it, and
   * the show's typical episode length otherwise — the steppers move between
   * episodes without the renderer's involvement, so a per-episode figure would
   * go stale the moment the user pressed next.
   */
  runtimeMinutes: number | null
}

/**
 * An intro the player is offering to skip past.
 *
 * Only what the button needs. The reasoning about *whether* to offer — which
 * database said so, and whether the answer survived being checked against the
 * stream — stays in the main process, because it is the part that can be
 * wrong and the part worth testing.
 */
export interface SkipOffer {
  /** Where pressing the button lands, in seconds. */
  targetSeconds: number
}

/** The surface `window.wta` exposes in the renderer. */
export interface WtaApi {
  store: {
    read(): Promise<StoreShape>
    write(patch: StorePatch): Promise<void>
  }
  tmdb: {
    row(req: RowRequest | GenreRowRequest | DiscoverRequest): Promise<Paged<MediaSummary>>
    /** The tailored Browse row. Main decides the contents; see TailoredRequest. */
    tailored(req: TailoredRequest): Promise<TailoredRow>
    search(query: string, page: number): Promise<Paged<MediaSummary>>
    detail(tmdbId: number, type: MediaType): Promise<MediaDetail | null>
    season(tmdbId: number, season: number): Promise<Season | null>
    genres(type: MediaType): Promise<Array<{ id: number; name: string }>>
    /** YouTube key for a card preview, or null when there is no usable trailer. */
    trailer(tmdbId: number, type: MediaType): Promise<string | null>
  }
  /**
   * Federated search. Prefer this over `tmdb.search` everywhere the user typed
   * the query — it is the only path that reaches IMDB's catalogue and returns
   * the IMDB ids providers key on.
   */
  search(query: string, page: number): Promise<Paged<MediaSummary>>
  /**
   * Resolve an IMDB-sourced summary to one carrying a TMDB id. Returns null
   * when TMDB does not know the title, which is a real outcome, not an error.
   */
  resolve(item: MediaSummary): Promise<MediaSummary | null>
  /**
   * Open `url` in whatever browses the web on this platform.
   *
   * Resolves false when the URL is not something the app will hand to the
   * operating system — see `isOpenableExternally`. The renderer is expected to
   * keep whatever the user could otherwise read and retype on screen, because
   * this can also fail for reasons no one here can see: no browser installed,
   * an intent with no handler, a user who dismissed the chooser.
   */
  openExternal(url: string): Promise<boolean>
  providers: {
    list(): Promise<Provider[]>
    /**
     * Per-provider outcomes for one title, plus which provider last streamed
     * it. See `TitleProviderState`.
     */
    outcomes(media: TitleRef): Promise<TitleProviderState>
  }
  releases: {
    /** Run a release sweep now. Resolves once every tracker has been checked. */
    checkNow(): Promise<{ checked: number; found: number }>
  }
  play(req: PlayRequest): Promise<{
    ok: boolean
    url?: string
    /** Which provider actually served it — may differ from the one requested. */
    providerId?: string
    providerName?: string
    error?: string
  }>
  /**
   * Driving the inline player.
   *
   * Separate from `play()` because that one *starts* playback; these control a
   * player that is already running, and the renderer owns its position on
   * screen — the video is a native layer that knows nothing about the layout.
   */
  player: {
    /** The rectangle, in the app window's content coordinates. */
    setBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>
    close(): Promise<void>
    goTo(season: number, episode: number): Promise<void>
    switchProvider(providerId: string): Promise<boolean>
    /** "Keep waiting" — stop offering to leave the provider that is loading. */
    dismissSuggestion(): Promise<void>
    /** Reload the embed in place, without losing the episode position. */
    reload(): Promise<void>
  }
  mal: {
    /** Opens a file picker. Null when the user cancelled. */
    preview(): Promise<MalPreview | null>
    commit(decisions: MalDecisions): Promise<MalImportSummary>
  }
  data: {
    export(): Promise<unknown>
    import(payload: unknown): Promise<{ ok: boolean; error?: string }>
    dir(): Promise<string>
  }
  /**
   * Cross-device sync.
   *
   * `connect` resolves when pairing finishes, which can be minutes — the user
   * has to walk to another device and type a code. The code itself arrives
   * before then, through the `syncStatus` event, so the screen can show it
   * while this promise is still outstanding.
   */
  sync: {
    status(): Promise<SyncStatus>
    connect(): Promise<{ ok: boolean; error?: string }>
    cancel(): Promise<void>
    disconnect(): Promise<void>
    now(): Promise<{ ok: boolean; error?: string }>
  }
  /**
   * Event subscriptions. Each returns its own unsubscribe function — the old
   * app registered `ipcRenderer.on` listeners it never removed.
   */
  on: {
    menuAction(cb: (action: string) => void): () => void
    navigate(cb: (tab: string) => void): () => void
    /**
     * One sweep's worth of new episodes, as a batch.
     *
     * An array because a weekly sweep routinely turns up several at once and
     * main has always sent them together — the single-object signature this
     * replaces described neither what main sent nor what the renderer, which
     * wraps a non-array defensively, was written to handle. `EpisodeStub` for
     * the same reason: the sweep never fetches the overview or the still.
     */
    releaseFound(cb: (payload: Array<{ title: string; episode: EpisodeStub }>) => void): () => void
    /**
     * Enough of something was watched for it to count. Fires on leaving it,
     * never on starting it — see `settleProgress` in the main process.
     */
    episodeWatched(
      /** `season`/`episode` are null for films, which have neither. */
      cb: (payload: {
        tmdbId: number
        type: MediaType
        season: number | null
        episode: number | null
      }) => void,
    ): () => void
    /**
     * A play has ended, whatever it amounted to.
     *
     * The sibling of `episodeWatched`, and deliberately not merged with it:
     * that one is a *verdict* and fires only when the threshold was met, while
     * this one is a *measurement* and fires every time. The History tab needs
     * the measurement — "you gave this eleven minutes and stopped" is exactly
     * the fact a timeline is for, and it is the one thing an event that only
     * reports successes can never carry.
     *
     * `seconds` and `duration` are null for a provider that reports no
     * position, which is the normal case on Android. `playedMs` is always
     * known, because it is measured here rather than asked of the page.
     */
    playbackSettled(
      cb: (payload: {
        tmdbId: number
        type: MediaType
        season: number | null
        episode: number | null
        playedMs: number
        seconds: number | null
        duration: number | null
        watched: boolean
      }) => void,
    ): () => void
    storeChanged(cb: () => void): () => void
    playbackActive(cb: (active: boolean) => void): () => void
    playerState(cb: (state: PlayerState | null) => void): () => void
    playerSuggestion(cb: (suggestion: PlayerSuggestion | null) => void): () => void
    /** True while the pointer is near the top edge of the video. */
    playerPointerTop(cb: (nearTop: boolean) => void): () => void
    /**
     * Sync state, whenever it changes.
     *
     * Pushed rather than polled because the interesting moments — a code
     * appearing, the user finishing at Google, a sync completing — all
     * originate in main and none of them are on a schedule the renderer knows.
     */
    syncStatus(cb: (status: SyncStatus) => void): () => void
    /** Progress while a MAL import resolves titles against TMDB. */
    malProgress(cb: (p: { done: number; total: number }) => void): () => void
  }
}

/**
 * What the player's floating chrome can do.
 *
 * A separate, much smaller surface than `WtaApi` because it is a separate
 * document: the controls are mounted in their own overlay view above the
 * video. Every entry is something the app's own chrome could already do — the
 * overlay replaced that chrome, it did not gain privileges.
 */
export interface WtaChromeApi {
  /**
   * Resize the overlay view to exactly this many CSS pixels tall.
   *
   * Load-bearing rather than cosmetic: the view swallows every mouse event
   * inside its bounds, so an overlay larger than what it draws makes that much
   * of the video unclickable.
   */
  setOverlayHeight(height: number): void
  back(): void
  goTo(season: number, episode: number): void
  switchProvider(providerId: string): void
  reload(): Promise<void>
  season(tmdbId: number, season: number): Promise<Season | null>
  /**
   * This title's recorded playback, per provider — the same call the detail
   * view's source picker makes, so the two lists cannot disagree about which
   * sources have worked.
   */
  outcomes(media: TitleRef): Promise<TitleProviderState>
  dismissSuggestion(): Promise<void>
  /** Jump to this position, in seconds. Used only by the skip-intro button. */
  skipTo(seconds: number): void
  /** Size the skip view to exactly the button, so it covers nothing else. */
  setSkipSize(width: number, height: number): void
  /** The standing offer to skip an intro, or null. */
  onSkipOffer(cb: (offer: SkipOffer | null) => void): () => void
  onContext(cb: (context: PlayerContext) => void): () => void
  /** The standing offer to change source, or null when there is none. */
  onSuggestion(cb: (suggestion: PlayerSuggestion | null) => void): () => void
  /** Pointer near the top of the picture, reported by the view that can see it. */
  onPointerTop(cb: (nearTop: boolean) => void): () => void
}

declare global {
  interface Window {
    wta: WtaApi
    wtaChrome: WtaChromeApi
  }
}
