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

import type { Castability } from './castability'
import type {
  DeviceKind,
  EpisodeStub,
  MediaDetail,
  MediaSummary,
  MediaType,
  PreferenceKey,
  ProbeVerdict,
  Provider,
  ProviderScan,
  QualityKind,
  ScanReason,
  Season,
  StreamDelivery,
  StoreShape,
  StorePatch,
} from './types'

/**
 * Re-exported so the contract reads as one document.
 *
 * Both are *stored* types, so they are defined in `types.ts` beside the store
 * shape that holds them — but every consumer meets them here, on
 * `TitleProviderState` and `ProviderScanProgress`, and importing the same
 * concept from two files is how a reader concludes there are two concepts.
 */
export type { ProbeVerdict, ProviderScan, QualityKind, ScanReason }
import type { SyncStatus } from './sync/types'
import type { PlayerAction, TransportAction } from './playerkeys'
import type { LoadedSubtitles, SubtitleLanguage } from './subtitles'
import type { DownloadRequest, DownloadsStatus, QualityCap } from './downloads/types'
export type { DownloadRequest, DownloadsStatus, DownloadView, QualityCap } from './downloads/types'

/** Invoke channels: renderer → main, with a reply. */
export const CH = {
  storeRead: 'store:read',
  storeWrite: 'store:write',
  storeSeed: 'store:seed',
  storeRecovered: 'store:recovered',

  tmdbRow: 'tmdb:row',
  tmdbDetail: 'tmdb:detail',
  tmdbSeason: 'tmdb:season',
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
  /**
   * Try every enabled provider for one title and report which ones stream.
   *
   * The outcome log answers "what has played", which is blank for a title
   * nobody has watched yet — precisely when the user most needs to know which
   * source to pick. This measures it instead of waiting for them to find out by
   * hand. Long-running: progress arrives on `providerScan`, not in the reply.
   */
  providersScan: 'providers:scan',
  /** Stop a scan in flight. Whatever it settled before stopping is kept. */
  providersScanCancel: 'providers:scan-cancel',
  /** The background watchlist tester's state, for Settings. See `WatchlistTestStatus`. */
  providersBackgroundStatus: 'providers:background-status',
  /** Which personalised rows Browse shows. See ForYouRow. */
  tmdbForYouPlan: 'tmdb:for-you-plan',
  /** One page of a personalised row. */
  tmdbForYouRow: 'tmdb:for-you-row',
  playOpen: 'play:open',
  /** Move the video to where the renderer has made room for it. */
  playSetBounds: 'play:set-bounds',
  /** Tear the player down. */
  playClose: 'play:close',
  /** "Keep waiting": stop offering to leave the provider currently loading. */
  playDismissSuggestion: 'play:dismiss-suggestion',
  playAcceptSuggestion: 'play:accept-suggestion',
  /** Reload the embed in place, for when a source hangs part-way. */
  playReload: 'play:reload',
  /** Shrink the player into the corner so the app can be browsed, or bring it back. */
  playSetMini: 'play:set-mini',
  /** Pause or resume the video itself, for the mini player's button. */
  playSetPaused: 'play:set-paused',
  /** A player key pressed while the app window has the focus; see `playerkeys.ts`. */
  playAction: 'play:action',
  /**
   * The shell's subtitles from OpenSubtitles (`main/subtitlesearch.ts`):
   * the languages there are, one file read, and the language to start the
   * next title with. Answered only for the shell of the player that is on,
   * and always about what it plays.
   */
  subtitleLanguages: 'subtitles:languages',
  subtitleLoad: 'subtitles:load',
  subtitleRemember: 'subtitles:remember',
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

  /** The detail view's stream preview: whether and from where, and keeping its place. */
  previewPlan: 'preview:plan',
  previewKeep: 'preview:keep',
  previewRecord: 'preview:record',
  /** Resume carried over from the preview: where it is, and that it is over. See `shared/carryover.ts`. */
  previewCarry: 'preview:carry',
  previewCarryEnd: 'preview:carry-end',
  previewCacheStatus: 'preview:cache-status',

  /** Downloads (the owner, 2026-10-04): see `shared/downloads/types.ts`. */
  downloadsStatus: 'downloads:status',
  downloadsStart: 'downloads:start',
  downloadsPause: 'downloads:pause',
  downloadsResume: 'downloads:resume',
  downloadsRemove: 'downloads:remove',
  downloadsSetQuality: 'downloads:set-quality',
  downloadsSetPreferredSource: 'downloads:set-preferred-source',

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

  /**
   * Casting the current stream to a television.
   *
   * Present in the shared contract even though only the Android app can do it,
   * because the renderer is one codebase and a platform check is a value it can
   * read rather than a build it has to be compiled into. `castAvailable`
   * answers false on the desktop and the UI never offers the button; see
   * `mobile/src/bridge/cast.ts` for the implementation and why this cannot work
   * without a proxy on the device.
   */
  castAvailable: 'cast:available',
  castStartDiscovery: 'cast:start-discovery',
  castStopDiscovery: 'cast:stop-discovery',
  castDevices: 'cast:devices',
  castConnect: 'cast:connect',
  castDisconnect: 'cast:disconnect',
  /** Move what is playing in the app onto the connected television. */
  castBeam: 'cast:beam',
  castStatus: 'cast:status',
  castControl: 'cast:control',
  castSetVolume: 'cast:set-volume',
  castSetMuted: 'cast:set-muted',
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
  chromeOverlayArea: 'chrome:overlay-area',
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
  chromeSkip: 'chrome:skip',
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
  /** The downloads changed: progress, a state, one added or deleted. Carries the whole `DownloadsStatus`. */
  downloads: 'evt:downloads',
  /** The held player is showing: the preview that stood in for it can go. */
  carryReleased: 'evt:carry-released',
  /** A key for the player while the preview stands in for it; the preview obeys. */
  carryAction: 'evt:carry-action',
  /**
   * Where the player is, so the app's chrome can label it.
   *
   * Sent to the *app* window, unlike `playerContext` which goes to the player's
   * own page. The two carry overlapping facts for two different consumers, which
   * is why they are separate channels rather than one shared one.
   */
  playerState: 'evt:player-state',
  /**
   * The player went into the corner, or came back out of it.
   *
   * Main's to announce, to the app window and to the player's own chrome,
   * because the chrome's Back reaches main first: the app window learns
   * about a minimise it did not start. See `player.setMini`.
   */
  playerMini: 'evt:player-mini',
  /** main → app window: the video stopped or started moving. */
  playerPaused: 'evt:player-paused',

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

  /**
   * v2's own controls, drawn in the `/__player` shell (`PlayerOverlay.svelte`).
   *
   * - `playerKey`: shell or chrome → main, a key pressed there, already
   *   mapped to an action.
   * - `playerTransport`: main → shell, the actions the overlay carries out on
   *   the film itself, wherever the key was pressed.
   * - `playerActivity` and `chromeActivity`: the pointer moved over the
   *   picture, so the bar comes up. Shell → main → chrome, because only the
   *   shell sees the pointer there.
   * - `playerBarState`: main → shell, whether the bar is showing or was sent
   *   away. The bottom controls follow it, so both come and go together.
   * - `chromeOpenPanel`: main → chrome, Enter or C opening the episodes or
   *   cast panel, or the shell's own Sources and Episodes buttons.
   * - `playerOverlayConfig`: main → shell, whether our controls are on.
   * - `playerOwned` and `chromeOwned`: shell → main → chrome, whether our
   *   controls have the film. While they do, the chrome's top bar keeps only
   *   Back, Cast and Reload, and its panels open at the bottom.
   */
  playerKey: 'player:key',
  playerTransport: 'evt:player-transport',
  playerActivity: 'player:activity',
  chromeActivity: 'evt:chrome-activity',
  playerBarState: 'evt:player-bar-state',
  chromeOpenPanel: 'evt:chrome-open-panel',
  playerOverlayConfig: 'evt:player-overlay-config',
  playerOwned: 'player:owned',
  chromeOwned: 'evt:chrome-owned',
  /** shell → main: the source has no film yet; press its own play control in its frames. */
  playerPressPlay: 'player:press-play',
  /** shell → main: the top of the source's own list of qualities; see `WtaPlayerApi.offered`. */
  playerOffered: 'player:offered',
  /** main → chrome: the arrows and Enter, while the episode strip is open. */
  chromeEpisodeNav: 'evt:chrome-episode-nav',
  syncStatus: 'evt:sync-status',

  /**
   * How far a MAL import has got.
   *
   * An import of a few hundred titles is a few hundred TMDB searches, which is
   * tens of seconds. Without this the dialog is a frozen spinner and the only
   * honest thing it could say is "wait".
   */
  malProgress: 'evt:mal-progress',

  /**
   * How far a provider scan has got, and what it has decided so far.
   *
   * Same reasoning as `malProgress`, with a sharper edge: a scan loads a dozen
   * third-party players in turn and takes the better part of a minute, and the
   * whole point of the feature is to replace the user doing that by hand. A
   * spinner that reports nothing until the end replaces visible waiting with
   * invisible waiting, which is not the improvement being sold.
   */
  providerScan: 'evt:provider-scan',
  /** The watchlist tester's state, whenever it changes. See `WatchlistTestStatus`. */
  watchlistTest: 'evt:watchlist-test',
  /**
   * Test results changed for these titles. See `ResultsChanged`.
   *
   * Sent to the app window and to the player's chrome, because every source
   * list re-read its results only when it opened or when a test run from it
   * ended. Results also come from tests nobody watches (the background
   * tester, the automatic tests), from plays and previews, and from sync, and
   * until this event none of those reached a list, or the detail view's
   * preview, that was already open.
   */
  resultsChanged: 'evt:results-changed',
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
 * The three lanes Browse keeps apart: live-action and western-animated series,
 * the same for films, and anime (Japanese animation, films included). A lane
 * row only ever shows its lane, so one kind of title cannot crowd out the
 * others however much of the library it is. See `foryou/lanes.ts`.
 */
export type ForYouLane = 'series' | 'films' | 'anime'

/** A title the plan names by id, for a row to recommend from. */
export interface ForYouSeed {
  tmdbId: number
  type: MediaType
}

/**
 * One personalised row on Browse, as main planned it.
 *
 * The renderer does **not** decide what these rows are — it asks main for a
 * plan, renders the rows it gets back, and hands each one back to ask for its
 * contents. That inversion is the point: the taste profile is derived from the
 * store, the store lives in main, and a renderer that assembled genre ids or
 * picked seed titles would be the recommendation logic, living in the surface
 * that draws it, where the phone would have to reimplement it.
 *
 * A row carries its own heading because the heading is part of the
 * recommendation. "Because you loved Frieren" is a claim the user can check
 * against their own library; a row with no stated reason is unfalsifiable, and
 * gets scrolled past.
 *
 * Handed back to main verbatim to fetch a page, so main re-validates it rather
 * than trusting it — see `isForYouRow`.
 */
export type ForYouRow =
  | {
      kind: 'topPicks'
      key: string
      title: string
      lane: ForYouLane
      /**
       * The favourites it pools, chosen at plan time — never ones that head a
       * "Because you" row, or Top picks would claim that row's titles first.
       * Empty for a lane the user has not rated yet: the row then comes from
       * their taste in genres alone.
       */
      seeds: ForYouSeed[]
    }
  | {
      kind: 'because'
      key: string
      title: string
      lane: ForYouLane
      /** The title the row is "because" of. */
      seed: ForYouSeed
    }
  | {
      kind: 'genre'
      key: string
      title: string
      lane: ForYouLane
      /** One genre concept, or two for a "both of these" shelf. See `taste.ts`. */
      concepts: number[]
    }
  | {
      /** A micro-genre: one TMDB keyword several of the user's favourites share. */
      kind: 'theme'
      key: string
      title: string
      lane: ForYouLane
      keyword: number
    }
  | {
      /**
       * A discovery row across all three lanes, taking them in turn: new
       * releases, little-known titles rated highly, or the acclaimed ones, in
       * the genres the user likes in each lane.
       */
      kind: 'mixed'
      key: string
      title: string
      flavour: 'new' | 'gems' | 'acclaimed'
    }
  | {
      /** More like what the user plans to watch: intent, not history. */
      kind: 'watchlist'
      key: string
      title: string
      seeds: ForYouSeed[]
    }

export interface ForYouPlanRequest {
  /**
   * Stable for an app session; picks which of the user's favourites the
   * "Because you watched" rows are about this time. Rotating them is what
   * keeps Browse from being the same page on every launch.
   */
  seed: number
}

export interface ForYouPlan {
  /** In display order. Empty for a library with nothing to go on yet. */
  rows: ForYouRow[]
}

export interface ForYouRowRequest {
  row: ForYouRow
  page: number
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

/** One provider a running scan is measuring. */
export interface ScanInFlight {
  providerId: string
  providerName: string
  /**
   * A second, longer test of a provider whose first came back red.
   *
   * A crowded test occasionally starves a working provider into looking
   * broken, so a red is tried again before it is believed. The UI says so,
   * rather than appearing to test a source it already has a verdict for.
   */
  recheck: boolean
}

/**
 * A scan in flight, pushed to the renderer as each provider resolves.
 *
 * Carries the verdicts so far rather than only a count, so the dots fill in one
 * by one instead of appearing all at once at the end. A scan of a dozen
 * providers takes the better part of a minute, and a progress bar that conveys
 * nothing for fifty seconds reads as a hang.
 */
export interface ProviderScanProgress {
  titleKey: string
  /**
   * The title under test, in the parts the renderer holds (it cannot build a
   * `titleKey`). Lets the app window's scan state follow the run it is
   * showing: an automatic test of another title used to paint its verdicts
   * onto the list of the title last tested by hand (`scan.svelte.ts`).
   */
  title?: TitleRef
  /**
   * The episode under test, or null for a film. Both platforms' runs name
   * it; absent would read as "this title, episode unknown". Results are per
   * episode, so a source list shows a run only for the episode it shows
   * (`progressIsAbout`, and the renderer's `liverun.ts`).
   */
  episode?: { season: number; episode: number } | null
  /**
   * Every provider being measured right now, in the order they started.
   *
   * A list because a scan is parallel — three at a time on the desktop, two on
   * the phone — and a single "current provider" made it look like one source
   * after another: the list marked one row "testing" while several were.
   */
  testing: ScanInFlight[]
  /** Providers with a verdict so far, out of `total`. A re-check does not count twice. */
  done: number
  total: number
  /** Verdicts settled so far. */
  verdicts: Record<string, ProbeVerdict>
  /** Milliseconds to the first media request, for each provider that streamed. See `ProviderScan.timings`. */
  timings: Record<string, number>
  /** Best quality class offered, for each streaming provider whose stream says. See `ProviderScan.qualities`. */
  qualities: Record<string, number>
  /** What each of `qualities` is worth: the best on offer, or a floor under it. See `QualityKind`. */
  qualityKinds: Record<string, QualityKind>
  /** Why each settled provider that did not stream failed. See `ProviderScan.reasons`. */
  reasons: Record<string, ScanReason>
  /** How each streaming provider's video arrived, so the cast list fills in live. See `ProviderScan.delivery`. */
  delivery: Record<string, StreamDelivery>
  /** True once every provider has resolved or the user cancelled. */
  finished: boolean
  /** Set when the user stopped it, so the UI can say so rather than claim a result. */
  cancelled: boolean
}

/**
 * What the desktop's background tester of the watchlist is doing, for the one
 * line Settings shows about it. See `watchlisttester.ts`.
 */
export interface WatchlistTestStatus {
  /** Testing now, waiting for its next turn, paused, or with nothing due. */
  state: 'testing' | 'waiting' | 'paused' | 'idle'
  /** Why it is paused, when it is. */
  pausedFor: 'playback' | 'scan' | null
  /** The title and source under test right now, when testing. */
  title: string | null
  providerName: string | null
  /** Watchlist (title, source) pairs with a result not yet due for a re-test, of all pairs. */
  done: number
  total: number
}

/**
 * Which titles' test results just changed (`EV.resultsChanged`), by
 * `titleKey`, the key every result is filed under (`@shared/titlekey`).
 *
 * A list rather than one title per message: changes are gathered over a
 * moment and sent once (`batchResultChanges`), and one sync can touch dozens
 * of titles. A screen re-reads only when the title it shows is named.
 */
export interface ResultsChanged {
  titleKeys: string[]
}

/**
 * The source Automatic resumes a title on — see `resumeFirst`.
 *
 * The one this title last streamed on, and only while it is still green.
 */
export interface ResumeSource {
  providerId: string
  /**
   * Its 0-based place in the ordinary order before it was moved to the front,
   * for the "was 3rd" beside it. Null when it was first anyway.
   */
  movedFrom: number | null
}

/**
 * Everything the source pickers need to draw one title's provider list.
 *
 * `resume` travels with the outcomes rather than in its own round trip
 * because it is derived from the same log, at the same moment: fetched
 * separately, the dots and the "resume" marker could describe two different
 * instants and disagree about which source is the current one.
 */
export interface TitleProviderState {
  /** Keyed by provider id. Absent means never tried for this title. */
  outcomes: Record<string, TitleOutcome>
  /** Where Automatic starts for this title, when it resumes; null otherwise. */
  resume: ResumeSource | null
  /**
   * The most recent scan of this title, if one is recent enough to believe.
   *
   * Travels with the outcomes for the same reason `resume` does: the dots are
   * drawn from both, and fetching them separately would let the two describe
   * different instants. Null when the title has never been tested. Results
   * older than `RESULT_TTL_MS`, and red or amber ones overtaken by a real play,
   * are left out rather than shown faded — see `freshScan`.
   *
   * Includes the user's other devices' good news, read by the rule in
   * `scanshare.ts`; `sharedFrom` says which entries those are.
   */
  scan: ProviderScan | null
  /**
   * The providers whose result in `scan` was measured on another device, and
   * which kind — so a picker can say "tested on your computer" rather than
   * pass another device's measurement off as this one's.
   */
  sharedFrom: Record<string, DeviceKind>
  /**
   * Whether each enabled provider can put this title on a television — see
   * `shared/castability.ts`. What the cast list is built from.
   */
  castability: Record<string, Castability>
  /**
   * The enabled providers' ids in the order Automatic would try them for this
   * title: measured and proven sources first, dead ones last, favourites and
   * then the user's own order within each.
   *
   * Computed where Automatic's order is computed, by the same function, rather
   * than re-derived by each picker. The pickers list their rows in this order,
   * so the list the user reads top to bottom *is* the fallback chain — two
   * implementations of the ordering would agree until the day one changed.
   */
  order: string[]
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
  /** Converted thumbs replaced by the exact MAL score. See `malapply.ts`. */
  refined: number
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

/** A television the phone can see on the network. */
export interface CastDevice {
  id: string
  name: string
  selected: boolean
}

/** Where a cast is, as far as the phone can tell. */
export interface CastStatus {
  /** Google Cast exists on this device at all. False on desktop. */
  available: boolean
  connected: boolean
  deviceName: string
  playing: boolean
  seconds: number
  duration: number
  /**
   * The television played the media to its end (Cast's IDLE with reason
   * FINISHED), as opposed to being paused, stopped or never started. What
   * starts auto-next on the television; see `main/upnext.ts`.
   */
  finished: boolean
  /**
   * Whether the phone is still serving segments.
   *
   * Worth surfacing separately from `connected`: the receiver can be attached
   * and idle because the proxy stopped, and those two need different words.
   */
  proxyRunning: boolean
  /**
   * The **receiver's** volume, 0–1, and whether it is muted.
   *
   * Not the app's and not the stream's. On many televisions this is the set's
   * own volume over HDMI-CEC, so moving it changes what the next thing played
   * on that television sounds like too. The remote says so, once.
   *
   * Zero and `false` are the honest defaults for a receiver that has not said:
   * a slider has to sit somewhere, and the alternative of hiding it until the
   * first status arrives makes the control flicker into existence a second
   * after the remote does.
   */
  volume: number
  muted: boolean
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
  /**
   * Whether the offer switches by itself when its countdown runs out. False
   * for a stall and for a source "Test all sources" found working: those only
   * offer. See `mayAutoSwitch` in `switchoffer.ts`.
   */
  autoSwitch: boolean
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
 * A skip button the player is offering: past the intro or the recap, or on to
 * the next episode over the credits. See `main/skipwatch.ts`.
 *
 * Only what the button needs to say. The reasoning about *whether* to offer — which
 * database said so, and whether the answer survived being checked against the
 * stream — stays in the main process, because it is the part that can be
 * wrong and the part worth testing.
 */
export interface SkipOffer {
  kind: 'intro' | 'recap' | 'next'
}

/** The surface `window.wta` exposes in the renderer. */
/**
 * How a detail view previews a title's stream.
 *
 * `surface` is the one platform difference the page has to know about. On the
 * desktop a source's page cannot live in the app's document, so it is a
 * `<webview>` of the player shell in its preview mode: its own webContents
 * and session, which the page still draws over. On the phone the source is an
 * ordinary iframe in the app's page, driven from the page itself (the relay
 * is installed in every frame of the WebView).
 */
/** What the preview cache holds, and what its last save did: a line in Settings, so a phone can say why nothing showed. */
export interface PreviewCacheStatus {
  titles: number
  bytes: number
  /** What the last save did; null before any. */
  last: PreviewCacheSave | null
}

/**
 * One save of the preview cache, for the Settings line. Names rather than
 * keys: the line is read by a person ("kept 30 s of Fight Club on VidSrc"),
 * where it used to read `movie:tt0137523 vidsrc-me`.
 */
export interface PreviewCacheSave {
  title: string
  season: number | null
  episode: number | null
  source: string
  /** What was kept, or null when nothing was. */
  kept: { seconds: number; fromSeconds: number; bytes: number } | null
  /** Why nothing was kept, in the cache's own terms (`no-playlist`, `segments-unreachable` …); null when kept. */
  reason: string | null
}

export interface PreviewPlan {
  surface: 'webview' | 'iframe'
  /** The shell's preview URL (webview), or the provider's own URL (iframe). */
  src: string
  providerId: string
  providerName: string
  /** Where the film should be: the saved position, or 0. */
  startSeconds: number
  /**
   * A window of this source's stream kept on this device, covering
   * `startSeconds`: played at once by the page's own `<video>` while the
   * source loads behind it (the preview cache, `shared/segmentwindow.ts`).
   */
  cached: CachedPreview | null
}

export interface CachedPreview {
  /** The kept window's playlist, on the app's own origin. */
  src: string
  /** Film time of the kept video's first frame (its `currentTime` 0), and of its last. */
  startSeconds: number
  endSeconds: number
  /** The whole film's length. */
  filmSeconds: number
}

/**
 * Between the desktop's preview shell and the page holding its `<webview>`:
 * `ipcRenderer.sendToHost` one way and `webview.send` the other, so main is
 * not in between.
 */
export const PREVIEW_STATE = 'wta:preview-state'
export const PREVIEW_MUTED = 'wta:preview-muted'
/** The page pauses or resumes the preview's film: Resume carried over, and Space pressed. */
export const PREVIEW_PAUSED = 'wta:preview-paused'
/** The page moves the preview's film: handing over from the preview cache at the same second. */
export const PREVIEW_SEEK = 'wta:preview-seek'

/** Where a preview standing in for the player is; see `shared/carryover.ts`. */
export interface CarryReport {
  seconds: number
  paused: boolean
  muted: boolean
  /** Not moving without the viewer's say: buffering. Its second is not projected on. */
  stalled: boolean
}

/** The keys a preview standing in for the player obeys. Any other key shows the player. */
export type CarryAction = 'togglePlay' | 'mute'

export interface WtaApi {
  store: {
    read(): Promise<StoreShape>
    write(patch: StorePatch): Promise<void>
    /**
     * Preferences the app worked out by itself (first-run defaults, the
     * provider lists reconciled with the catalogue), written without a stamp
     * of their own so they never outrank a choice made on another device.
     */
    seed(patch: Partial<Pick<StoreShape, PreferenceKey>>): Promise<void>
    /**
     * What to tell the user when the library would not open and this session
     * started from an empty one, with where the unreadable file was kept; null
     * in every normal case. See `StoreCore.recovered`.
     */
    recovered(): Promise<string | null>
  }
  tmdb: {
    row(req: RowRequest | GenreRowRequest | DiscoverRequest): Promise<Paged<MediaSummary>>
    /** The personalised rows Browse should show. Main decides; see ForYouRow. */
    forYouPlan(req: ForYouPlanRequest): Promise<ForYouPlan>
    /** One page of a planned row. */
    forYouRow(req: ForYouRowRequest): Promise<Paged<MediaSummary>>
    detail(tmdbId: number, type: MediaType): Promise<MediaDetail | null>
    season(tmdbId: number, season: number): Promise<Season | null>
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
  /**
   * The detail view's stream preview (the owner, 2026-09-27): the title itself
   * in the trailer's place, when a tested source starts fast enough. See
   * `main/previewplan.ts` for when, and `PreviewPlan` for what comes back.
   */
  preview: {
    /** How this episode or film would preview, or null when it does not. */
    plan(req: PlayRequest): Promise<PreviewPlan | null>
    /**
     * Settle the preview like a play: where it last played is the place to
     * resume from, and `playedMs` (muted or not) goes into the history,
     * which also marks it watched if it reached the credits. See `PreviewWatch`.
     */
    keep(
      req: PlayRequest,
      seconds: number,
      duration: number,
      options?: { cacheSource?: string; playedMs?: number },
    ): Promise<void>
    /**
     * File what the preview measured as a test result for its source: it
     * played, this many milliseconds after the preview opened. Once per
     * preview.
     */
    record(req: PlayRequest, providerId: string, streamedMs: number, filmSeconds?: number): Promise<void>
    /** While standing in for the player: where the preview is now. */
    carry(report: CarryReport): Promise<void>
    /** The preview stopped standing in (gone, or tapped): show the player now. */
    carryEnd(): Promise<void>
    /** What the preview cache holds, for a line in Settings; null where there is none. */
    cacheStatus(): Promise<PreviewCacheStatus | null>
  }
  /**
   * Downloads (the owner, 2026-10-04; `shared/downloads/`): a film or an
   * episode kept on this device, played by the player in a source's place.
   * `status` is null on a platform without downloads (yet), and the UI then
   * offers none.
   */
  downloads: {
    status(): Promise<DownloadsStatus | null>
    /** Queue a download. One per episode: asking again resumes a stopped one. */
    start(request: DownloadRequest): Promise<{ ok: true; id: string } | { ok: false; error: string }>
    pause(id: string): Promise<void>
    resume(id: string): Promise<void>
    /** Delete it and its files, finished or not. */
    remove(id: string): Promise<void>
    setQuality(quality: QualityCap): Promise<void>
    /** The source every download tries first; null for Automatic. See `DownloadsStatus.preferredSourceId`. */
    setPreferredSource(providerId: string | null): Promise<void>
  }
  providers: {
    list(): Promise<Provider[]>
    /**
     * Per-provider outcomes for one title, plus which provider last streamed
     * it. See `TitleProviderState`. The test results are the episode's own
     * where it has any; without an episode, the whole title's.
     */
    outcomes(media: TitleRef, episode?: { season: number; episode: number } | null): Promise<TitleProviderState>
    /**
     * Measure every enabled provider against this title.
     *
     * Resolves with the finished scan, or with what had settled when the user
     * cancelled. Progress arrives on the `providerScan` event meanwhile — this
     * takes tens of seconds, and a UI with nothing to show until the end reads
     * as a hang.
     *
     * Only one scan runs at a time. Calling this while one is in flight cancels
     * the first: two scans would compete for the bandwidth each is measuring
     * and condemn providers that were merely starved.
     */
    scan(media: TitleRef, episode?: { season: number; episode: number } | null): Promise<ProviderScan>
    /** Stop the scan in flight. Verdicts already settled are kept. */
    cancelScan(): Promise<void>
    /**
     * What the background tester of the watchlist is doing. Null on a platform
     * that has none — the phone, where a probe needs a visible surface and a
     * battery.
     */
    backgroundStatus(): Promise<WatchlistTestStatus | null>
  }
  releases: {
    /** Run a release sweep now. Resolves once every tracker has been checked. */
    checkNow(): Promise<{ checked: number; found: number }>
  }
  /**
   * Start playing. `carry`: the detail view's preview is on screen and stands
   * in while the player loads held (hidden and silent), then hands over at
   * its second; see `shared/carryover.ts`.
   */
  play(
    req: PlayRequest,
    options?: { carry?: boolean },
  ): Promise<{
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
    /** "Keep waiting" — stop offering to leave the provider that is loading. */
    dismissSuggestion(): Promise<void>
    /** Reload the embed in place, without losing the episode position. */
    reload(): Promise<void>
    /**
     * Shrink the player into a corner of the app, or restore it.
     *
     * Playback carries on untouched: same page, same source, progress still
     * recorded. What changes is where the video sits (the renderer reports
     * the new rectangle through `setBounds`, as it always does) and what is
     * drawn over it: the player's own chrome stands aside, and with it any
     * countdown to switch source, which must never run where the offer
     * cannot be seen.
     */
    setMini(mini: boolean): Promise<void>
    /**
     * Pause or resume the provider's video.
     *
     * Reaches into the provider's frames: on desktop through `WebFrameMain`,
     * on Android through a document-start relay (`bridge/mediarelay.ts`).
     * The answer comes back as `on.playerPaused`, from the video itself,
     * rather than being assumed.
     */
    setPaused(paused: boolean): Promise<void>
    /** A player key pressed in the app window; main routes it. */
    action(action: PlayerAction): Promise<void>
  }
  mal: {
    /** Opens a file picker. Null when the user cancelled. */
    preview(): Promise<MalPreview | null>
    commit(decisions: MalDecisions): Promise<MalImportSummary>
  }
  data: {
    export(): Promise<unknown>
    import(payload: unknown): Promise<{ ok: boolean; error?: string }>
  }
  /**
   * Putting the stream on a television.
   *
   * Android only in practice — `available()` is false everywhere else and the
   * UI asks before it offers anything. The shape is deliberately close to
   * `sync`: a handful of verbs, a status to poll, and no assumption that any of
   * it succeeds.
   *
   * `beam()` is the whole feature in one call. It finds the stream the player
   * actually fetched, works out whether it can be played by something that is
   * not this WebView, rewrites its playlist to route through the phone, starts
   * the proxy and hands the receiver a URL. Every one of those can fail for a
   * reason the user can act on, which is why it resolves with an error string
   * rather than throwing.
   */
  cast: {
    available(): Promise<boolean>
    /** Discovery is active and costs battery; the picker starts and stops it. */
    startDiscovery(): Promise<void>
    stopDiscovery(): Promise<void>
    devices(): Promise<CastDevice[]>
    connect(deviceId: string): Promise<{ ok: boolean; error?: string }>
    disconnect(): Promise<void>
    beam(): Promise<{ ok: boolean; error?: string; providerName?: string }>
    status(): Promise<CastStatus>
    control(action: 'play' | 'pause' | 'stop' | 'seek', seconds?: number): Promise<void>
    /**
     * Set the receiver's volume, 0–1, and its mute.
     *
     * Separate from `control` because they address different things: transport
     * is a command to the *media session*, volume is a command to the
     * *receiver*, and on the wire they go to different transport ids. Folding
     * them into one verb would hide a distinction the sender has to get right.
     */
    setVolume(level: number): Promise<void>
    setMuted(muted: boolean): Promise<void>
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
    /**
     * The library changed outside the renderer's own hands, or its own write
     * landed. Batched over a few milliseconds: `keys` names what changed, or
     * is null for everything (a sync merge, an import, a new provider
     * catalogue). Keys the renderer does not mirror can be ignored.
     */
    storeChanged(cb: (keys: Array<keyof StoreShape> | null) => void): () => void
    playbackActive(cb: (active: boolean) => void): () => void
    /** The downloads changed. Never fires where `downloads.status` is null. */
    downloads(cb: (status: DownloadsStatus) => void): () => void
    /** The held player is showing; see `play`'s `carry`. */
    carryReleased(cb: () => void): () => void
    /** A player key pressed while the preview stands in for it. */
    carryAction(cb: (action: CarryAction) => void): () => void
    playerState(cb: (state: PlayerState | null) => void): () => void
    /** True while the player is shrunk into the corner. */
    playerMini(cb: (mini: boolean) => void): () => void
    /** Whether the video is paused, as the video itself reports it. */
    playerPaused(cb: (paused: boolean) => void): () => void
    playerSuggestion(cb: (suggestion: PlayerSuggestion | null) => void): () => void
    /** True while the pointer is near the top edge of the video. */
    playerPointerTop(cb: (nearTop: boolean) => void): () => void
    /**
     * A provider scan, as each source resolves.
     *
     * Fires once per settled provider and once more when the run finishes, so
     * the dots fill in progressively. Subscribed by both the detail view and
     * the player chrome — either can start a scan and both draw the result, and
     * an event is what keeps them agreeing without either owning the state.
     */
    providerScan(cb: (progress: ProviderScanProgress) => void): () => void
    /** The watchlist tester's state, whenever it changes. Never fires on the phone. */
    watchlistTest(cb: (status: WatchlistTestStatus) => void): () => void
    /** Test results changed for these titles, from anywhere: see `EV.resultsChanged`. */
    resultsChanged(cb: (change: ResultsChanged) => void): () => void
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
 * The part of the picture the chrome overlay covers, in CSS pixels.
 *
 * Always pinned to the top edge. `width: null` spans the whole picture, which
 * is what the bar needs; a number is that wide and centred, which is what the
 * countdown needs while the bar has been sent away — a full-width strip would
 * block the very controls of the embed the user hid the bar to reach.
 */
export interface OverlayArea {
  height: number
  width: number | null
  /**
   * Whether the bar itself is showing, and whether it was sent away (Hide).
   * The height cannot say it: the hot strip and a failure banner have height
   * too. The shell's controls follow these.
   */
  barVisible?: boolean
  away?: boolean
  /** The episode strip is open: ←/→ and Enter belong to it, not to the film. */
  episodesOpen?: boolean
  /** The source list is open: Back and Escape close it, not the player. */
  sourcesOpen?: boolean
}

/** A key for the episode strip: move the highlight, play it, or close the strip. */
export type EpisodeNav = 'prev' | 'next' | 'play' | 'close'

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
   * Resize the overlay view to exactly the area it draws.
   *
   * Load-bearing rather than cosmetic: the view swallows every mouse event
   * inside its bounds, so an overlay larger than what it draws makes that much
   * of the video unclickable.
   */
  setOverlayArea(area: OverlayArea): void
  back(): void
  goTo(season: number, episode: number): void
  switchProvider(providerId: string): void
  reload(): Promise<void>
  season(tmdbId: number, season: number): Promise<Season | null>
  /**
   * This title's recorded playback, per provider — the same call the detail
   * view's source picker makes, so the two lists cannot disagree about which
   * sources have worked. `episode` is the one playing.
   */
  outcomes(media: TitleRef, episode?: { season: number; episode: number } | null): Promise<TitleProviderState>
  /**
   * Test every enabled source against what is playing.
   *
   * Offered here as well as in the detail view, and this is the surface that
   * needs it most: the user opens this list precisely when a source has just
   * disappointed them, and without a scan they pick the next one by guessing.
   */
  scan(media: TitleRef, episode?: { season: number; episode: number } | null): Promise<ProviderScan>
  cancelScan(): Promise<void>
  /** Progress of a scan, wherever it was started from. */
  onProviderScan(cb: (progress: ProviderScanProgress) => void): () => void
  /** Test results changed for these titles, from anywhere: see `EV.resultsChanged`. */
  onResultsChanged(cb: (change: ResultsChanged) => void): () => void
  dismissSuggestion(): Promise<void>
  /**
   * Take the offer on screen — "Switch now", or its countdown running out.
   * Unlike `switchProvider`, marks the source being left as tried, so the
   * next offer cannot point back at it.
   */
  acceptSuggestion(): Promise<boolean>
  /** The skip button was pressed; the player does what the offer on screen says. */
  skip(): void
  /** Size the skip view to exactly the button, so it covers nothing else. */
  setSkipSize(width: number, height: number): void
  /** The skip button on offer, or null. */
  onSkipOffer(cb: (offer: SkipOffer | null) => void): () => void
  onContext(cb: (context: PlayerContext) => void): () => void
  /** The standing offer to change source, or null when there is none. */
  onSuggestion(cb: (suggestion: PlayerSuggestion | null) => void): () => void
  /** True while the player is shrunk into the app's corner and this chrome is out of sight. */
  onMini(cb: (mini: boolean) => void): () => void
  /** Pointer near the top of the picture, reported by the view that can see it. */
  onPointerTop(cb: (nearTop: boolean) => void): () => void
  /** The pointer moved over the picture; `hold` keeps the bar up (paused, or using the controls). */
  onActivity(cb: (hold: boolean) => void): () => void
  /** Enter or C from wherever the key was pressed, or the shell's Sources and Episodes buttons. */
  onOpenPanel(cb: (panel: 'episodes' | 'cast' | 'sources') => void): () => void
  /** Whether our own controls have the film (v2); see `EV.chromeOwned`. */
  onOwned(cb: (owned: boolean) => void): () => void
  /** Hide the bar now: a tap on the picture while it shows (the phone's `WtaPlayerApi.dismiss`). */
  onDismiss(cb: () => void): () => void
  /** The arrows and Enter while the episode strip is open. */
  onEpisodeNav(cb: (nav: EpisodeNav) => void): () => void
  /** A player key pressed in the chrome; main routes it. */
  action(action: PlayerAction): void

  /**
   * Casting, from the one place it makes sense to offer it.
   *
   * The button belongs in the player chrome rather than on the detail page
   * because casting needs a stream, and a stream only exists once the provider's
   * player has fetched one — see `mobile/src/bridge/cast.ts`. Offering it before
   * playback starts would be offering something that cannot work yet.
   *
   * `available()` is false on the desktop and the chrome renders nothing, so
   * this costs the desktop a handful of no-op methods and no UI.
   */
  cast: {
    available(): Promise<boolean>
    startDiscovery(): Promise<void>
    stopDiscovery(): Promise<void>
    devices(): Promise<CastDevice[]>
    connect(deviceId: string): Promise<{ ok: boolean; error?: string }>
    disconnect(): Promise<void>
    /**
     * Send what the player is playing to the connected television.
     *
     * `final` marks a failure that asking again will not change: a stream was
     * found and the television could not take it. Without it a caller that
     * retries while the source is still loading would keep reloading the TV
     * with a playlist it has already refused.
     */
    beam(): Promise<{ ok: boolean; error?: string; final?: boolean }>
    status(): Promise<CastStatus>
    /**
     * Transport for the television.
     *
     * The chrome is the *only* document with a cast UI, so leaving this off
     * its bridge did not merely omit a convenience — it made the television
     * uncontrollable, with no way to pause or seek once a stream was running.
     */
    control(action: 'play' | 'pause' | 'stop' | 'seek', seconds?: number): Promise<void>
    /** The receiver's own volume, 0–1, and its mute. See `WtaApi.cast`. */
    setVolume(level: number): Promise<void>
    setMuted(muted: boolean): Promise<void>
  }
}

declare global {
  interface Window {
    wta: WtaApi
    wtaChrome: WtaChromeApi
    /** Only in the `/__player` shell; see `WtaPlayerApi`. */
    wtaPlayer?: WtaPlayerApi
  }
}

/** What main tells the shell's controls about the bar above them. */
export interface BarState {
  visible: boolean
  away: boolean
}

/** Whether v2's controls are on (`Settings.ownControls`), and the window's state around them. */
export interface PlayerOverlayConfig {
  ownControls: boolean
  fullscreen: boolean
  /** Shrunk into the app's corner: no controls over a picture that small. */
  mini: boolean
  /** `Settings.subtitleLanguage`: the language to start with, or null for none. */
  subtitleLanguage: string | null
  /**
   * Held while the detail view's preview stands in for this player (Resume
   * carried over, `shared/carryover.ts`): the film plays silent until this is
   * null again, then takes `muted` from the preview. Null otherwise.
   */
  held: { muted: boolean } | null
}

/**
 * What the `/__player` shell's own controls can do (`PlayerOverlay.svelte`).
 *
 * The shell is our own page, the player view's main frame. The provider plays
 * in a cross-origin iframe below it, and the overlay reaches the film through
 * the film relay (`filmrelay.ts`), not through this API. What comes through
 * here is everything that involves main: keys, the bar, the setting.
 */
export interface WtaPlayerApi {
  onConfig(cb: (config: PlayerOverlayConfig) => void): () => void
  onContext(cb: (context: PlayerContext) => void): () => void
  onTransport(cb: (action: TransportAction) => void): () => void
  onBarState(cb: (state: BarState) => void): () => void
  /** Playback moved to another source by itself; the reason, for the toast. */
  onProviderChanged(cb: (change: { providerName: string; reason: string }) => void): () => void
  /** A key pressed in the shell, mapped; main routes it. */
  action(action: PlayerAction): void
  /** The pointer moved over the picture. `hold`: keep the bar up. */
  activity(hold: boolean): void
  /** Press the source's own play control, in its frames (behind our cover). */
  pressPlay(): void
  /** Whether our controls have the film now; the chrome lays itself out by it. */
  owned(owned: boolean): void
  /**
   * The top of the source's own list of qualities, as a class: its engine's
   * levels or its list of whole streams (`offeredQuality`), told once per
   * load after the film plays. The host files it with this load's play as
   * what the source offers, where a play otherwise has at most a floor (the
   * desktop's best picture of the first minute) or, on the phone, nothing.
   */
  offered(quality: number): void
  /**
   * Hide the controls and the bar now: a tap on the picture while they show.
   * The phone only; on the desktop the pointer leaving does it.
   */
  dismiss?(): void
  subtitles: {
    languages(): Promise<SubtitleLanguage[]>
    /** The best file in `code` for a film this long; remembered as the language to start with. */
    load(code: string, filmSeconds: number | null): Promise<LoadedSubtitles | null>
    /**
     * The language to start the next title with (an OpenSubtitles code), or
     * null for none. For a choice that loads no file: a source's own track,
     * or subtitles off.
     */
    remember(code: string | null): Promise<void>
  }
  /** The preview shell's end of `PREVIEW_STATE` / `PREVIEW_MUTED`; desktop only. */
  preview?: {
    report(state: PreviewReport): void
    onMuted(cb: (muted: boolean) => void): () => void
    onPaused(cb: (paused: boolean) => void): () => void
    onSeek(cb: (seconds: number) => void): () => void
  }
}

/** What a preview says about its film, as often as it changes. */
export interface PreviewReport {
  /** The film's time has moved while it played: it may be shown. */
  started: boolean
  seconds: number
  duration: number
  playing: boolean
  /** Buffering: playing, but its time is not moving. */
  waiting: boolean
  muted: boolean
  /**
   * How long the stream took to arrive, in milliseconds from the preview
   * opening; null until the film has also played, which is the proof a
   * result needs. Filed as a test result for the source (`preview.record`)
   * the moment it is known. See `PreviewFilm.streamedMs`.
   */
  streamedMs: number | null
}
