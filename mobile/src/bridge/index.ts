/**
 * `window.wta`, implemented for Android.
 *
 * This is the whole port. The desktop app answers this interface from a
 * separate Node process over IPC; here the same calls run in the WebView, which
 * is possible because the business layer under `src/main` never touches Node or
 * Electron — TMDB and IMDB are plain `fetch`, and provider selection, MAL
 * parsing, the sync format and the taste model are pure functions over the
 * store document.
 *
 * The renderer is not aware any of this is different. That is the point: 18
 * renderer files call `window.wta` and none of them change.
 *
 * ## What differs, and why
 *
 * `player.*` is the exception. On desktop the video is a native
 * `WebContentsView` and main runs script in the provider's own frames.
 * Android's WebView grants no such privilege over a cross-origin iframe (see
 * `playersurface.ts`), so the phone installs a relay into every frame of its
 * WebView at document start instead (`mediarelay.ts`). It reports the film's
 * time and plays, pauses and seeks it, which is what resume, watched
 * detection, the skip buttons and auto-next run on here. What has no phone
 * equivalent yet is the stall watch and the auto-switch countdown
 * (`player.dismissSuggestion` is a no-op).
 */

import type {
  EpisodeStub,
  MediaDetail,
  MediaSummary,
  MediaType,
  Provider,
  Season,
  StoreShape,
} from '@shared/types'
import type {
  CarryAction,
  CarryReport,
  DiscoverRequest,
  GenreRowRequest,
  MalDecisions,
  MalImportSummary,
  MalPreview,
  Paged,
  PlayRequest,
  PreviewPlan,
  PlayerState,
  PlayerSuggestion,
  SkipOffer,
  RowRequest,
  ForYouPlanRequest,
  ForYouRowRequest,
  ProviderScan,
  ProviderScanProgress,
  TitleProviderState,
  TitleRef,
  WtaApi,
  DownloadsStatus,
  PlayerOverlayConfig,
  WtaPlayerApi,
} from '@shared/ipc'

import * as tmdb from '@main/tmdb'
import { airedEpisode, notOutYet } from '@shared/aired'
import * as search from '@main/search'
import BUNDLED_CATALOG from '@main/providers.json'
import {
  readCache,
  refreshCatalog,
  resolveProviders,
  REFRESH_INTERVAL_MS,
  type CachedCatalog,
} from '@main/catalog'
import { buildPlayUrl, renderTemplate } from '@main/providers'
import type { PlayCandidate } from '@main/providers'
import {
  defaultProviderOrder,
  mediaKey,
  outcomesForTitle,
  record,
  titleKey,
} from '@main/outcomes'
import type { Outcome } from '@main/outcomes'
import { progressIsAbout } from '@shared/scanprogress'
import {
  castResult,
  everyRow,
  PLAY_MIN_FILM_SECONDS,
  PLAY_TIMING_MAX_MS,
  kindTested,
  lastPlayedHere,
  WarmStarts,
  playResult,
  previewResult,
  resumeFirst,
  scanAwareOrder,
  scanEpisode,
  titleResults,
  type AutomaticOrder,
  type ResultsAccess,
} from '@main/providerscan'
import { ResultStore } from '@shared/store/results'
import { CarryOver, type HeldFilm } from '@shared/carryover'
import { FilmLink } from '@/player/filmlink'
import { episodeOf, resultsFromScan } from '@shared/sourceresults'
import { castabilities } from '@shared/castability'
import { choosePreview, planPreview } from '@main/previewplan'
import { checkAll, sweepDueIn } from '@main/releases'
import { UpNextController, type UpNextPlace } from '@main/upnext'
import { nextAiredEpisode, type NextEpisode } from '@shared/episodesteps'
import { findSegments } from '@main/skiplookup'
import { SkipWatch } from '@main/skipwatch'
import { isOpenableExternally } from '@main/externalurl'
import { readingEpisode, type PlayerReading } from '@main/playermessage'
import {
  isWatchedEnough,
  lengthToStore,
  resumeAction,
  resumeKey,
  resumeOfferFor,
  ResumeSeek,
  WrittenPositions,
} from '@main/resume'
import { capture, createCastBridge, type Candidate } from './cast'
import { createSegmentStore, type SaveNames, type SegmentStore, type WindowWhere } from '@main/segmentstore'
import { phoneCacheFiles } from './segmentfiles'
import { createPhoneDownloads, downloadedProvider, readDownloadPlaylist } from './downloads'
import type { DownloadManager } from '@shared/downloads/manager'
import { DOWNLOADED_SOURCE_ID, DOWNLOADED_SOURCE_NAME, isDownloadedSource } from '@shared/downloads/types'
import { App as CapacitorApp } from '@capacitor/app'
import { ScreenOrientation } from '@capacitor/screen-orientation'
import { Browser } from '@capacitor/browser'
import { LocalNotifications } from '@capacitor/local-notifications'
import { createPlayerSurface } from './playersurface'
import { bridgeIsolated, installFilmRelay, setPageMuted, type RelayTime } from './mediarelay'
import { OUTDATED_WEBVIEW } from './bridgeisolation'
import { TV_HANDOVER, TvHandover } from './tvhandover'
import { createVisibleGate } from './visiblegate'
import { routePlayerAction, type PlayerActionHandlers } from './playeraction'
import type { TransportAction } from '@shared/playerkeys'
import { createOverlayHub } from './overlayhub'
import { createOverlayHost } from './overlayhost'
import { createPhoneFullscreen } from './phonefullscreen'
import { loadSubtitles, subtitleLanguages, type SubtitleQuery } from '@main/subtitlesearch'
import { createScanRunner, type RunOptions as ScanRunOptions } from './scan'
import { AUTO_TEST_TICK_MS, AutoTester } from '@main/autotest'
import { resumeAnchor } from '@shared/watchlistrank'
import { preferencesCatalogStore } from './catalogstore'
import { createChromeApi } from './chrome'
import { createChromeOverlay } from './chromeoverlay'
import { notifyFound, syncScheduledReleases } from './notifications'
import { exportStore, importIntoStore } from '@main/sync'
import { forYouPlan, forYouRow } from '@main/foryou'
import { tmdbNetwork } from '@main/foryou/network'
import { backfillScores } from '@main/scorebackfill'
import { runSeasonSplit, tmdbIdentify } from '@main/seasonsplit'
import {
  DEFAULT_SELECTED,
  DEFAULT_TARGETS,
  STATUS_LABELS,
  findBestMatch,
  parseMalExport,
} from '@main/malimport'
import type { MalEntry } from '@main/malimport'
import { applyMalImport } from '@main/malapply'
import type { ResolvedTitle } from '@main/malapply'

import { Signal } from './events'
import { CapacitorPersistence, MobileStore } from './store'
import { pickTextFile, shareTextFile } from './files'
import { createMobileSync } from './sync'
import { throttle } from '@shared/sync/throttle'
import type { SyncStatus } from '@shared/sync/types'
import { recoveredLibrary, unreadableLibrary } from '@shared/store/core'
import { batchChanges } from '@shared/store/changebatch'

/** How long a local change settles before it is pushed. Matches the desktop. */
const SYNC_AFTER_WRITE_MS = 8_000

/** The positions file's pace while positions keep changing. Matches the desktop. */
const POSITIONS_PUSH_MS = 10_000
/** The test history's push, at most this often; the desktop's `RESULTS_PUSH_MS`. */
const RESULTS_PUSH_MS = 2 * 60_000

/**
 * How often the position is written while something plays, from whatever
 * readings arrive. Matches the desktop's `PERSIST_EVERY_MS`.
 */
const POSITION_WRITE_MS = 5_000

export async function createBridge(): Promise<WtaApi> {
  const store = new MobileStore()
  await store.load()

  /**
   * Every test result this install has, its own and the other devices': the
   * history (`@shared/sourceresults`), in its own file beside the library.
   */
  const resultStore = new ResultStore(new CapacitorPersistence('source-results.json'))
  await resultStore.load()
  const testResults: ResultsAccess = {
    sources: () => ({ history: resultStore.all(), doc: store.read() }),
    device: () => ({ deviceId: store.read().deviceId, deviceKind: 'phone' }),
    record: (results) => resultStore.record(results),
  }

  const storeChanged = new Signal<Array<keyof StoreShape> | null>()
  /**
   * Every change to the library reaches the renderer, batched and naming what
   * changed, as the desktop's main process does it.
   *
   * The bridge used to emit by hand after the writes it remembered, and the
   * ones it forgot left the renderer's copy stale. The worst was the score
   * backfill: the renderer later saved its old unscored copies over the
   * backfilled ones, the revert synced to the desktop, and the next launch
   * fetched the same TMDB details again. The renderer's own writes echo back
   * too, which is what the desktop has always done.
   */
  store.subscribe(batchChanges((keys) => storeChanged.emit(keys)))
  const releaseFound = new Signal<Array<{ title: string; episode: EpisodeStub }>>()
  const malProgress = new Signal<{ done: number; total: number }>()
  const menuAction = new Signal<string>()
  const navigate = new Signal<string>()
  const episodeWatched = new Signal<{
    tmdbId: number
    type: MediaType
    season: number | null
    episode: number | null
  }>()
  const playbackSettled = new Signal<{
    tmdbId: number
    type: MediaType
    season: number | null
    episode: number | null
    playedMs: number
    seconds: number | null
    duration: number | null
    watched: boolean
  }>()
  const playbackActive = new Signal<boolean>()
  /** Resume carried over: the held player is showing; see `carry` below. */
  const carryReleased = new Signal<null>()
  /** Keys for the preview standing in. The phone has none; the API is shared. */
  const carryAction = new Signal<CarryAction>()
  const playerState = new Signal<PlayerState | null>()
  const playerSuggestion = new Signal<PlayerSuggestion | null>()
  const playerSkip = new Signal<SkipOffer | null>()
  /** The phone's side of main's `playerMini` / `playerPaused`; see `setMini`. */
  const playerMini = new Signal<boolean>()
  const playerPaused = new Signal<boolean>()
  const playerPointerTop = new Signal<boolean>()
  const providerScan = new Signal<ProviderScanProgress>()
  const syncStatus = new Signal<SyncStatus>()
  const downloadsStatus = new Signal<DownloadsStatus>()

  /**
   * Sync, over the same shared engine the desktop uses.
   *
   * `store.raw()` rather than `store.read()`: readers get the document with
   * tombstones filtered out, and a merge that cannot see a deletion resurrects
   * it on every sync from the other device.
   *
   * `applyingRemote` distinguishes sync's own write from the user's, so
   * applying a merge does not schedule another sync to look at its own result.
   */
  let applyingRemote = false
  const sync = createMobileSync({
    positionsHost: {
      read: () => store.raw().resumePoints,
      adopt: (points) => {
        // Flagged like the library's write below, so taking the other device's
        // position does not schedule a push of it straight back.
        applyingRemote = true
        try {
          store.adoptRecords('resumePoints', points)
        } finally {
          applyingRemote = false
        }
      },
    },
    resultsHost: {
      read: () => resultStore.all(),
      adopt: (results) => resultStore.adopt(results),
    },
    host: {
      read: () => store.raw(),
      write: async (document) => {
        applyingRemote = true
        try {
          await store.replaceDocument(document)
        } finally {
          applyingRemote = false
        }
        // The merge reaches the renderer through the store subscription above.
      },
    },
    onStatus: (status) => syncStatus.emit(status),
  })
  await sync.load()
  sync.soon()

  /**
   * Sync when the app comes back to the foreground.
   *
   * The phone's equivalent of the desktop's window focus, and the more
   * important of the two here: a phone spends most of its life backgrounded, so
   * "what happened on the desktop while this was in my pocket" is the normal
   * question rather than the edge case.
   */
  void CapacitorApp.addListener('appStateChange', ({ isActive }: { isActive: boolean }) => {
    if (isActive) sync.soon()
  })

  /**
   * A local change, debounced.
   *
   * Same reasoning and same delay as the desktop: a burst of marks becomes one
   * sync, and nothing is lost by pushing it a few seconds late.
   */
  /**
   * The positions push: every change asks, at most one push per ten seconds
   * goes out, and a stop (pause, close, next episode, the app leaving the
   * foreground) sends one at once. Ten seconds is the owner's number
   * (2026-09-27); the file is a few kilobytes. See `sync/positions.ts`.
   */
  const pushPositions = throttle(() => void sync.positions(), POSITIONS_PUSH_MS)

  /**
   * The test history's push: at most every two minutes while this device
   * measures, as on the desktop. Nothing waits on it, and it is the largest
   * of the three files.
   */
  const pushResults = throttle(() => void sync.results(), RESULTS_PUSH_MS)
  resultStore.subscribe((change) => {
    if (change === 'local') pushResults.request()
  })

  let writeSyncTimer: ReturnType<typeof setTimeout> | null = null
  store.subscribe((key) => {
    if (applyingRemote) return
    // Positions change every five seconds while something plays. They go by
    // the positions file on its own pace; debounced here, they would hold the
    // library sync off until playback stopped. The library still gets them
    // with its next sync.
    if (key === 'resumePoints') {
      pushPositions.request()
      return
    }
    if (writeSyncTimer !== null) clearTimeout(writeSyncTimer)
    writeSyncTimer = setTimeout(() => {
      writeSyncTimer = null
      sync.soon()
    }, SYNC_AFTER_WRITE_MS)
  })

  /**
   * The entries from the last preview, waiting to be committed.
   *
   * Held here rather than round-tripped through the dialog for the same reason
   * main holds them: a three-hundred-title export would otherwise be serialised
   * into the decisions object and handed straight back.
   */
  let pendingMal: MalEntry[] = []

  /**
   * The managed provider list, refreshed in the background.
   *
   * Embed providers die and change domain constantly, and a list compiled into
   * an APK is stale the week it ships — with no remedy at all on a phone, where
   * the user cannot rebuild the app. So the phone now runs the desktop's
   * catalogue: same URL, same validation, same three layers, differing only in
   * where the cache is kept. See `catalogstore.ts`.
   *
   * Held in memory because it is read on every play and every render of the
   * providers panel, and null until the first read finishes — which is why
   * `resolveProviders` accepts null and answers with the bundled list.
   */
  let cachedCatalog: CachedCatalog | null = null

  const allProviders = (): Provider[] => {
    const bundled = BUNDLED_CATALOG.providers as unknown as Provider[]
    return resolveProviders(bundled, cachedCatalog, store.read().customProviders)
  }

  /**
   * Load the cached catalogue, then look for a newer one.
   *
   * Deliberately not awaited by anything: the bundled list is a working
   * catalogue, so nothing has to wait for this, and a phone on a bad connection
   * must not have a ten-second fetch between it and its own library.
   *
   * A failure is not surfaced either, for the same reason the desktop does not
   * surface it — an error about a background refresh the user never asked for
   * describes a problem they cannot act on.
   */
  const catalogStore = preferencesCatalogStore()
  /**
   * When this process last asked, so an unchanged answer (a 304, which leaves
   * `fetchedAt` alone) is not asked for again on every resume.
   */
  let catalogAskedAt = 0

  const refreshCatalogIfStale = async (): Promise<void> => {
    const now = Date.now()
    if (now - Math.max(catalogAskedAt, cachedCatalog?.fetchedAt ?? 0) < REFRESH_INTERVAL_MS) return
    catalogAskedAt = now

    const result = await refreshCatalog(catalogStore)
    if (result.status !== 'updated') return
    cachedCatalog = await readCache(catalogStore)
    // The providers panel and the source picker both render off this list, and
    // a new catalogue is not a store write: "everything" re-reads it.
    storeChanged.emit(null)
  }

  void (async () => {
    cachedCatalog = await readCache(catalogStore)
    if (cachedCatalog !== null) storeChanged.emit(null)
    await refreshCatalogIfStale()
  })()
  // The desktop refreshes on a timer; a phone app can stay warm for days and
  // used to look only at a cold start. The same interval, checked on return.
  void CapacitorApp.addListener('resume', () => void refreshCatalogIfStale().catch(() => {}))

  const enabledProviders = (): Provider[] => {
    const { activeProviderIds } = store.read()
    const all = allProviders()
    const enabled = activeProviderIds
      .map((id) => all.find((p) => p.id === id))
      .filter((p): p is Provider => !!p)
    // Same fallback as the desktop: an empty list is indistinguishable from
    // "the user turned everything off" and would fail every play.
    return enabled.length > 0 ? enabled : all.filter((p) => p.tier === 'core')
  }

  /** Seeded once, exactly as main does, so both apps mean the same by "no order yet". */
  const providerOrder = (): string[] => {
    const stored = store.read().providerOrder
    if (stored.length > 0) return stored
    const seeded = defaultProviderOrder(allProviders())
    // Unstamped: a default, not a choice. See `StoreCore.seedPreference`.
    store.seedPreference('providerOrder', seeded)
    return seeded
  }

  /**
   * What is playing, if anything.
   *
   * The desktop keeps this in `InlinePlayer` in the main process; here it is
   * bridge-local state, because the surface is a DOM node in this very
   * document. `candidates` is every provider that could serve the request —
   * `buildPlayUrl` computes them all up front so switching source is a
   * navigation rather than a round trip.
   */
  interface Session {
    req: PlayRequest
    candidates: PlayCandidate[]
    index: number
  }

  /**
   * What the current episode has told us about itself, and for how long.
   *
   * Two clocks rather than one, because two different questions are being
   * asked and they have different scopes:
   *
   * - `episodeOpenedAt` spans provider switches, because switching source is
   *   still watching the same episode. This is the desktop's rule and it was
   *   arrived at the hard way there: draining the counter on every switch split
   *   one viewing into three stretches, none long enough to count as watched,
   *   on exactly the providers where elapsed time is the only evidence there is.
   * - `candidateShownAt` is per provider, because the outcome being recorded is
   *   about *that provider* serving *this* episode.
   *
   * `reading` spans switches for the same reason `episodeOpenedAt` does: a
   * position learned from one source is a fact about the episode, not about the
   * source that happened to report it.
   */
  interface Progress {
    reading: PlayerReading | null
    episodeOpenedAt: number
    candidateShownAt: number
    candidateReported: boolean
    /** This source's play has been filed as a test result (`PlayMeasurement`). */
    candidateMeasured: boolean
    /**
     * The film element's first report at a film's length, for this source:
     * when, and at what second. A play is filed once a later report shows its
     * time moving on (`noteFilmPlaying`).
     */
    filmFirst: { at: number; seconds: number } | null
    /** When a reading was last written as the position; see `POSITION_WRITE_MS`. */
    writtenAt: number
    /**
     * The episode the provider's own messages last named. Kept apart from
     * `reading`, because the relay's readings name none and would otherwise
     * hide a provider moving on by itself.
     */
    namedEpisode: { season: number; episode: number } | null
  }

  let progress: Progress | null = null

  /** Whether the provider's video is moving, as the relay last reported. */
  let videoPlaying = false

  /** Putting the video back where it was left, for the source now loading; see `resumeUrl`. */
  let resumeSeek: ResumeSeek | null = null
  /** The film is playing and its time is not moving; see `onReading`. The gentle automatic test waits it out. */
  let filmBuffering = false

  /*
    v2's own controls on the phone (2026-09-27): `PlayerOverlay` over the
    picture, talking to the top bar through `overlayHub` as the desktop's do
    through main. Declared before the surface, which mounts the overlay on
    every load; the closures below read the rest of the bridge when they run.
  */
  /**
   * Resume carried over from the detail view's preview (the owner,
   * 2026-09-28; `shared/carryover.ts`): the player loads held, out of sight
   * and silent, while the preview plays on in its place, and shows once its
   * film is at the preview's second. Declared up here because the overlay's
   * config reads it; the rest is beside `setMini`.
   */
  let carry: CarryOver | null = null
  /** The held player's film, as the relay last reported it. */
  let heldFilm: HeldFilm | null = null
  let carryTimer: ReturnType<typeof setInterval> | null = null
  /** The surface's frame, for the carry to read and move its film. */
  let surfaceFrame: HTMLIFrameElement | null = null
  /**
   * The held film, read through the film relay's full reports, as our
   * overlay reads it. Not the relay's two-second `time` reports, which it
   * sends only for the element it has settled on as the film. On the
   * emulator (2026-09-29) a held VidRock played muted at the preview's very
   * second while none of those reached the carry, which gave up at 15 s.
   */
  let heldLink: FilmLink | null = null
  let stopHeldListening: (() => void) | null = null

  const overlayHub = createOverlayHub()
  const overlayConfig = new Signal<PlayerOverlayConfig>()
  const currentOverlayConfig = (): PlayerOverlayConfig => ({
    ownControls: store.read().settings.ownControls,
    fullscreen: phoneFullscreen.current(),
    mini,
    subtitleLanguage: store.read().settings.subtitleLanguage,
    held: carry !== null && !carry.done ? { muted: carry.last()?.muted ?? false } : null,
  })
  const announceOverlayConfig = (): void => overlayConfig.emit(currentOverlayConfig())
  const phoneFullscreen = createPhoneFullscreen(() => announceOverlayConfig())

  /** What is playing, for OpenSubtitles; null with nothing playing. */
  const subtitleQuery = (): SubtitleQuery | null =>
    session === null
      ? null
      : { imdbId: session.req.imdbId, season: session.req.season ?? null, episode: session.req.episode ?? null }
  const setSubtitleLanguage = (code: string | null): void => {
    const settings = store.read().settings
    if (settings.subtitleLanguage !== code) store.applyPatch({ settings: { ...settings, subtitleLanguage: code } })
  }

  /** The transport actions, for our overlay to carry out; see `routePlayerAction`. */
  const transport = new Signal<TransportAction>()
  const playerActions: PlayerActionHandlers = {
    transport: (action) => transport.emit(action),
    fullscreen: () => phoneFullscreen.toggle(),
    openPanel: (panel) => overlayHub.openPanel(panel),
    shrink: () => setMini(true),
    reload: () => void playerReload(),
  }

  const playerApi: WtaPlayerApi = {
    onConfig: (cb) => {
      cb(currentOverlayConfig())
      return overlayConfig.subscribe(cb)
    },
    onContext: (cb) => {
      if (currentPlayerState !== null) cb(currentPlayerState)
      return playerState.subscribe((state) => {
        if (state !== null) cb(state)
      })
    },
    onBarState: (cb) => overlayHub.onBarState(cb),
    // From a keyboard, a remote or DeX, through `routePlayerAction`.
    onTransport: (cb) => transport.subscribe(cb),
    onProviderChanged: () => () => {},
    action: (action) => routePlayerAction(action, 'overlay', playerActions),
    activity: (hold) => overlayHub.activity(hold),
    pressPlay: () => surface.press(),
    owned: (owned) => overlayHub.owned(owned),
    dismiss: () => overlayHub.dismiss(),
    subtitles: {
      languages: async () => {
        const query = subtitleQuery()
        return query === null ? [] : subtitleLanguages(query)
      },
      load: async (code, filmSeconds) => {
        const query = subtitleQuery()
        if (query === null || !/^[a-z]{3}$/.test(code)) return null
        setSubtitleLanguage(code)
        return loadSubtitles(query, code, Number.isFinite(filmSeconds) ? filmSeconds : null)
      },
      remember: async (code) => {
        if (code === null || /^[a-z]{3}$/.test(code)) setSubtitleLanguage(code)
      },
    },
  }
  /**
   * The skip buttons, as on the desktop (`main/skipwatch.ts`), fed the relay's
   * readings. No AniSkip here: its id mapping is a 5.8 MB file the phone does
   * not keep. Not while the television has the film.
   */
  const skipWatch = new SkipWatch({
    enabled: () => store.read().settings.skipIntro && !onTv,
    expectedMinutes: () => session?.req.runtimeMinutes ?? null,
    lookup: async (streamSeconds) => {
      if (!session) return []
      const req = session.req
      return findSegments(
        { tmdbId: req.tmdbId, imdbId: req.imdbId, season: req.season ?? null, episode: req.episode ?? null, streamSeconds },
        { animeId: async () => null },
      )
    },
    hasNext: async () => {
      const place = session ? placeOf(session.req) : null
      return place !== null && (await nextEpisodeAfter(place)) !== null
    },
    announce: (offer) => playerSkip.emit(offer),
    log: (line) => console.log(line),
  })

  const pressSkip = (): void => {
    const action = skipWatch.press()
    // The relay moves only the element of this length (`relaySeek`).
    const duration = progress?.reading?.duration
    if (action?.kind === 'seek' && duration) surface.seek(action.seconds, duration)
    if (action?.kind !== 'next' || !session) return
    const place = placeOf(session.req)
    if (place === null) return
    void nextEpisodeAfter(place).then((next) => {
      // Only if the viewer is still where the button was pressed.
      const now = session ? placeOf(session.req) : null
      if (next === null || now?.season !== place.season || now.episode !== place.episode) return
      console.log(`[skip] next episode: S${next.season}E${next.episode}`)
      void playerGoTo(next.season, next.episode)
    })
  }

  const overlayHost = createOverlayHost(playerApi)

  const surface = createPlayerSurface({
    onFrameLoad: (frame) => {
      surfaceFrame = frame
      overlayHost.load(frame)
      // Another episode or another source's cut: nothing known carries over.
      skipWatch.reset()
    },
    onMediaState: (playing) => {
      videoPlaying = playing
      if (playing) autoTester.tick()
      playerPaused.emit(!playing)
      // A pause is a stop the other device may pick up from: write the exact
      // place and send it now, rather than at the next five-second sample.
      if (!playing && session) {
        rememberPosition(session.req)
        pushPositions.now()
      }
    },

    /**
     * What is on screen, for the parser's benefit.
     *
     * Read at message time rather than captured: the surface is built once and
     * outlives every episode shown in it.
     */
    /**
     * Resume through the relay, for sources whose URL could not do it. The
     * television has the picture while casting, and resumes on its own.
     */
    onFilmTime: (time) => {
      if (!session || onTv) return
      noteFilmPlaying(time)
      if (resumeSeek === null) return
      const to = resumeSeek.next(time, Date.now())
      if (to !== null) surface.seek(to, time.duration)
    },

    expects: () =>
      session === null
        ? null
        : {
            tmdbId: session.req.tmdbId,
            season: session.req.season ?? null,
            episode: session.req.episode ?? null,
          },

    onReading: (reading) => {
      if (!progress || !session) return

      /**
       * Is this reading even about what we asked for?
       *
       * It often is not, for one message. VidFast posts its entire progress
       * library the moment the frame loads, and the freshest entry in it is
       * the *previous* session's title until the current one has advanced far
       * enough to be written. Everything downstream files something under
       * `session.req`, so an unchecked reading would write last night's
       * position onto tonight's episode and credit this provider with
       * streaming it.
       *
       * A provider's own links are the other way this happens — the frame is
       * the provider's site and its site has somewhere else to go — and the
       * same comparison covers it.
       */
      if (reading.tmdbId !== null && reading.tmdbId !== session.req.tmdbId) return

      /**
       * The provider moved on by itself.
       *
       * Its own "next episode" button, or its own autoplay, is outside the app
       * entirely, so the only notice we get is the episode a reading names
       * changing. The episode being left is settled *here*, while
       * `session.req` still names it, and then the session follows the
       * provider: from 1.9.8 the relay's readings name no episode, so filing
       * them under anything but the session would put the new episode's
       * position on the old one, and auto-next must count from where the
       * viewer actually is.
       */
      const named = progress.namedEpisode
      const names = readingEpisode(session.req.type, reading)
      const advanced =
        names !== null && named !== null && (named.season !== names.season || named.episode !== names.episode)

      // A downloaded episode always plays from the download (the owner,
      // 2026-10-04), however the player got to it: the source's own autoplay
      // moving on included. Stepping settles the episode being left.
      const fromDownload = isDownloadedSource(session.candidates[session.index]?.provider.id)
      if (advanced && names !== null && !fromDownload && downloadedCandidate({ ...session.req, ...names }) !== null) {
        progress.namedEpisode = names
        void playerGoTo(names.season, names.episode)
        return
      }

      if (advanced) {
        settleProgress(session.req)
        session = { ...session, req: { ...session.req, ...names } }
        progress.episodeOpenedAt = Date.now()
        emitPlayerState()
      }
      if (names !== null) progress.namedEpisode = names

      // Playing, and the time did not move since the last report: buffering.
      filmBuffering = reading.playing === true && progress.reading !== null && reading.seconds <= progress.reading.seconds
      progress.reading = reading

      // Written as it goes, not only when the player is left: Android can kill
      // the app at any moment, and until 1.9.8 everything since the last
      // close, switch or reload went with it.
      if (Date.now() - progress.writtenAt >= POSITION_WRITE_MS) {
        progress.writtenAt = Date.now()
        rememberPosition(session.req)
      }

      skipWatch.reading(onTv ? null : reading)

      // The end of the episode here, as opposed to on the television, which
      // `castBridge.onProgress` watches.
      const place = placeOf(session.req)
      if (!onTv && place !== null) upNext.observe(place, reading, session.req.runtimeMinutes, false)
    },
  })
  const chrome = createChromeOverlay()
  let session: Session | null = null

  /**
   * The mini player (2026-09-27): the video shrunk into a strip above the tab
   * bar, the app usable around it. Back and the chrome's ← both land here;
   * only the strip's ✕ stops playback. The desktop keeps the same state in
   * main (`setPlayerMini`), and the two announce it the same way.
   */
  let mini = false

  /** The chrome and the overlay stand down in the corner, and while the player is held. */
  const applyHidden = (): void => {
    const held = carry !== null && !carry.done
    chrome.setHidden(mini || held)
    overlayHost.setHidden(mini || held)
  }

  const endCarryTimer = (): void => {
    if (carryTimer) clearInterval(carryTimer)
    carryTimer = null
    stopHeldListening?.()
    stopHeldListening = null
    heldLink = null
  }

  const listenToHeldFilm = (): void => {
    const link = new FilmLink((message) => surfaceFrame?.contentWindow?.postMessage(message, '*'))
    const onMessage = (event: MessageEvent): void => {
      if (surfaceFrame === null || event.source !== surfaceFrame.contentWindow || !link.receive(event.data)) return
      const film = link.view().film
      heldFilm = film && { seconds: film.seconds, duration: film.duration, playing: !film.paused, waiting: film.waiting }
      stepCarry()
    }
    window.addEventListener('message', onMessage)
    heldLink = link
    stopHeldListening = () => window.removeEventListener('message', onMessage)
  }

  /** Open held: the surface out of sight, our controls down, the film silent (`held` in its config). */
  const holdForCarry = (): void => {
    carry = new CarryOver(Date.now())
    heldFilm = null
    surface.setConcealed(true)
    applyHidden()
    announceOverlayConfig()
    endCarryTimer()
    listenToHeldFilm()
    // On a clock as well as on the film's reports: asking for them, and so
    // that a film that never reports still runs out the give-up time.
    carryTimer = setInterval(() => {
      heldLink?.watch()
      stepCarry()
    }, 500)
  }

  const stepCarry = (): void => {
    if (carry === null || carry.done) return
    const move = carry.step(heldFilm, Date.now())
    if (move.kind === 'seek') heldLink?.seekTo(move.to)
    if (move.kind === 'release') releaseCarry()
  }

  /** Show the held player, with the preview's sound and pause; the page then lets the preview go. */
  const releaseCarry = (): void => {
    if (carry === null || carryTimer === null) {
      // Nothing held: the page is told all the same, or it would stand in forever.
      carryReleased.emit(null)
      return
    }
    endCarryTimer()
    // Shown before its film was ever read (a tap on the preview, the
    // give-up): nothing has put the film at the preview's place, so the
    // ordinary resume seek does, there, as it would have without the carry.
    const target = carry.target(Date.now())
    if (heldFilm === null && target !== null && session) resumeSeek = new ResumeSeek(target, session.req.runtimeMinutes)
    carry.release()
    surface.setConcealed(false)
    applyHidden()
    announceOverlayConfig()
    if (carry.last()?.paused) surface.setPaused(true)
    console.log(`[carry] player shown at ${heldFilm ? Math.round(heldFilm.seconds) : '?'} s (${carry.reason})`)
    carryReleased.emit(null)
  }

  const setMini = (next: boolean): void => {
    if (mini === next || (next && session === null)) return
    mini = next
    // Hidden, not closed: the chrome's state is what the full player comes
    // back to. Its countdown to switch source stands down meanwhile.
    applyHidden()
    phoneFullscreen.setActive(!next && session !== null && !onTv)
    announceOverlayConfig()
    playerMini.emit(next)
    playerPaused.emit(!videoPlaying)
  }

  // Subscribed here, below everything the config reads: a store write during
  // start-up must not reach it before those exist.
  store.subscribe((key) => {
    if (key === 'settings') announceOverlayConfig()
  })

  /*
    Before any player opens: the relay can only reach documents created after
    it is installed. Without it the mini player's button does nothing, which
    is the whole of the failure; see `mediarelay.ts`.
  */
  void installFilmRelay(location.origin)

  /**
   * Whether this WebView keeps provider pages away from the native bridge.
   * Where it cannot, no provider is loaded into it: see `bridgeisolation.ts`.
   */
  const providersAllowed = bridgeIsolated()

  /**
   * The last state emitted, kept so a late subscriber can be caught up.
   *
   * The player's chrome mounts *after* playback starts and subscribes a tick
   * after that, so a signal with no replay tells it nothing until the next
   * episode or source change. See `chrome.ts`'s `onContext`.
   */
  let currentPlayerState: PlayerState | null = null

  /**
   * Casting to a television.
   *
   * Constructed once and kept, because it owns the proxy's lifetime: a bridge
   * rebuilt per call would lose track of a server it had already started.
   */
  const castBridge = createCastBridge()

  /*
   * The preview cache (the owner, 2026-09-29; `src/shared/segmentwindow.ts`):
   * a window of the stream kept when the player or the preview is left, for
   * the detail view to play at once next time. Null until the files are open,
   * and for good if they cannot be: the preview then starts from its source.
   */
  let segmentStore: SegmentStore | null = null
  void phoneCacheFiles()
    .then((files) => createSegmentStore(files))
    .then((store) => (segmentStore = store))
    .catch((error: unknown) => console.log(`[cache] unavailable: ${String(error)}`))

  /**
   * Downloads (`./downloads.ts` on the shared core). Null until loaded, and
   * for good if they cannot be: every download control is then left out.
   */
  let downloads: { manager: DownloadManager; playUrl: (id: string) => string } | null = null
  const downloadsReady = createPhoneDownloads({
    // As Resume would choose: the one picked by hand, then the Automatic order.
    sources: (subject, preferredProviderId) =>
      buildPlayUrl(automaticOrderFor(subject).providers, { ...subject, providerId: preferredProviderId })?.candidates.map((c) => ({
        id: c.provider.id,
        name: c.provider.name,
      })) ?? [],
    sourceUrl: (providerId, subject) => {
      const provider = allProviders().find((p) => p.id === providerId)
      return provider ? renderTemplate(provider, subject) : null
    },
    publish: (status) => downloadsStatus.emit(status),
  })
    .then((ready) => (downloads = ready))
    .catch((error: unknown) => {
      console.log(`[downloads] unavailable: ${String(error)}`)
      return null
    })

  /** The episode's finished download as the player's first candidate; null when there is none. */
  const downloadedCandidate = (req: PlayRequest): PlayCandidate | null => {
    const found = downloads?.manager.playable({ tmdbId: req.tmdbId, type: req.type, season: req.season ?? null, episode: req.episode ?? null })
    if (!downloads || !found) return null
    return { provider: downloadedProvider(DOWNLOADED_SOURCE_ID, DOWNLOADED_SOURCE_NAME), url: downloads.playUrl(found.id) }
  }

  /** How long a preview's plan waits for the window the player is saving; the source would take longer to start. */
  const PLAN_WAITS_FOR_SAVE_MS = 5_000

  /** Which episode a kept window is of. */
  const episodeWhere = (req: PlayRequest): Omit<WindowWhere, 'providerId'> => {
    const episode = episodeOf(req)
    return { titleKey: titleKey(req), season: episode?.season ?? null, episode: episode?.episode ?? null }
  }
  const windowWhere = (req: PlayRequest, providerId: string): WindowWhere => ({ ...episodeWhere(req), providerId })
  /** What a kept window is of, in words, for the Settings line (`SaveNames`). A test's request has no title. */
  const saveNames = (req: PlayRequest, providerId: string): SaveNames => ({
    title: req.title || 'a tested title',
    source: allProviders().find((p) => p.id === providerId)?.name ?? providerId,
  })

  /** In the background, one at a time; nothing waits for it. The frames' requests are one buffer, newest first. */
  const keepStreamWindow = (req: PlayRequest, providerId: string | null, from: { seconds: number; duration: number }): void => {
    const store = segmentStore
    // A download is on the device already; a window of it would be a copy of a copy.
    if (store === null || providerId === null || isDownloadedSource(providerId)) return
    void store.save(windowWhere(req, providerId), capture.list().catch(() => []), from, req.runtimeMinutes ?? null, saveNames(req, providerId))
  }
  /**
   * Whether the picture is on the television, so the phone's is blanked.
   *
   * A scan blanks and restores the same surface, and its restore used to put
   * the phone's own video back mid-cast — the film twice, audio in two rooms.
   */
  let onTv = false
  /**
   * True from an episode step until the next beam lands. Until then the
   * television is still reporting the episode it had — finished, as often as
   * not — and those readings must be filed under neither episode, nor start a
   * countdown for the one being stepped to.
   */
  let tvStale = false

  /**
   * Move what is playing onto the television, and stand the phone down.
   *
   * The blanking is not a nicety. While casting, the phone is *serving* the
   * stream to the receiver; if its own iframe keeps playing the same film it is
   * pulling the whole thing twice and playing audio in two rooms. The embed is
   * blanked rather than closed so the chrome, the episode list and the source
   * picker all stay where they are and `restore` can bring the picture back.
   */
  const beamToTv = async (): Promise<{ ok: boolean; error?: string; providerName?: string; final?: boolean }> => {
    const playing = nowPlaying()
    if (playing === null) return { ok: false, error: 'Nothing is playing.' }
    // On a download: cast its files from the phone (`beamDownload` in cast.ts).
    const found =
      session && isDownloadedSource(session.candidates[session.index]?.provider.id)
        ? (downloads?.manager.playable({
            tmdbId: session.req.tmdbId,
            type: session.req.type,
            season: session.req.season ?? null,
            episode: session.req.episode ?? null,
          }) ?? null)
        : null
    const playlist = found ? await readDownloadPlaylist(found.id) : null
    const now = found && playlist ? { ...playing, download: { id: found.id, playlist } } : playing

    const result = await castBridge.beam(now)
    if (result.ok) {
      onTv = true
      tvStale = false
      surface.blank()
      standDownForTv()
      // Before the remote's own portrait lock, which is not ours to undo.
      phoneFullscreen.setActive(false)
      standUpright()
    }
    // A beam that identified a stream measured the source, succeeded or not —
    // filed like the desktop's. No verdict from the TV: see `PhoneBeamResult`.
    const providerId = currentPlayerState?.providerId
    if (result.delivery && session && providerId) {
      const learned = { delivery: result.delivery, outcome: null }
      const where = { device: testResults.device(), titleKey: titleKey(session.req), episode: episodeOf(session.req), providerId }
      testResults.record([castResult(where, learned, Date.now())])
    }
    return {
      ok: result.ok,
      error: result.error,
      providerName: result.providerName,
      final: !result.ok && result.delivery !== undefined,
    }
  }

  /**
   * Turn the phone the right way up for the remote.
   *
   * A video wants landscape; a remote control does not. Once the picture is on
   * the television the phone is a column of buttons — a time bar, five
   * transport keys and a volume slider — and that is a portrait shape in every
   * device that has ever done this job.
   *
   * Released rather than re-locked when the cast ends. Locking back to
   * landscape would rotate the screen under a user who may well have put the
   * phone down, and `followFullscreen` already owns landscape for the case
   * that actually wants it.
   */
  const standUpright = (): void => {
    void ScreenOrientation.lock({ orientation: 'portrait' }).catch(() => {})
  }

  const releaseOrientation = (): void => {
    void ScreenOrientation.unlock().catch(() => {})
  }

  /**
   * The phone's picture out of sight and its sound off while the television
   * has the film, and both back after.
   *
   * Blanking covered only the moment of the beam. An episode step while
   * casting (auto-next, the remote's ⏭) loads the source on the phone again,
   * because its stream is what the television is handed, and that page showed
   * and played aloud until the next beam landed, or for good when it did not:
   * in a pocket, the film twice. Concealed and muted, it loads and is captured
   * with nothing seen or heard.
   */
  const standDownForTv = (): void => {
    surface.setConcealed(true)
    void setPageMuted(true)
  }

  const standUpFromTv = (): void => {
    surface.setConcealed(false)
    void setPageMuted(false)
  }

  /** For what should happen only with the app on screen; see `reclaimFromTv`. */
  const visibleGate = createVisibleGate()

  /**
   * Casting stopped: take the film back, at the position the television reached.
   *
   * Written as a resume point rather than passed along, so the ordinary
   * resume does the work: `resumeUrl` puts it in the provider's URL and arms
   * the relay seek. Without this the embed would come back at whatever position
   * it was blanked at, rewinding the user by however long they watched on the
   * TV. (Until 1.9.9 that is what happened anyway: the restore reloaded the URL
   * built when Play was pressed.)
   */
  const reclaimFromTv = async (): Promise<void> => {
    const status = await castBridge.status()
    if (session && status.seconds > 0) {
      const context = contextFor(session.req, progress?.reading ?? null)
      store.collection('resumePoints').put({
        key: resumeKey(context),
        tmdbId: context.tmdbId,
        seconds: status.seconds,
        duration: status.duration,
      })
    }
    onTv = false
    tvStale = false
    handover = null
    // The picture, the sound and the source come back only on screen. A cast
    // that ends in a pocket (the set switched off, the Wi-Fi gone) used to
    // reload the source there, and one that plays by itself played aloud.
    visibleGate.run(() => {
      standUpFromTv()
      const candidate = session?.candidates[session.index]
      surface.restore(candidate ? resumeUrl(candidate) : undefined)
      releaseOrientation()
      phoneFullscreen.setActive(session !== null && !mini)
    })
  }

  /*
   * A cast can end without the app asking. The television is switched off, the
   * Chromecast is claimed by another phone, the Wi-Fi drops. In every one of
   * those the picture here is still blank and the user is looking at a black
   * rectangle wondering what happened — so the same recovery runs, driven by
   * the session event rather than by a button.
   */
  castBridge.onSession((state) => {
    if (state === 'ended' || state === 'failed') void reclaimFromTv()
  })

  /**
   * What `beam` should tell the receiver it is playing.
   *
   * Reads the live position rather than the stored resume point where one is
   * available: the user presses Cast *during* playback, and starting the
   * television from the last saved position would rewind them by however long
   * they have been watching.
   */
  const nowPlaying = (): { title: string; subtitle: string; providerName: string; startSeconds: number } | null => {
    if (!currentPlayerState || !session) return null
    const episode =
      currentPlayerState.season !== null && currentPlayerState.episode !== null
        ? `S${currentPlayerState.season}E${currentPlayerState.episode}`
        : ''
    return {
      title: currentPlayerState.title,
      subtitle: [episode, currentPlayerState.providerName ?? ''].filter(Boolean).join(' · '),
      providerName: currentPlayerState.providerName ?? 'This source',
      startSeconds: progress?.reading?.seconds ?? 0,
    }
  }

  /** Tell the renderer's chrome what it is framing. */
  const emitPlayerState = (): void => {
    if (!session) {
      currentPlayerState = null
      playerState.emit(null)
      return
    }
    const current = session.candidates[session.index]
    currentPlayerState = {
      title: session.req.title,
      type: session.req.type,
      tmdbId: session.req.tmdbId,
      imdbId: session.req.imdbId,
      season: session.req.season,
      episode: session.req.episode,
      providerId: current?.provider.id ?? null,
      providerName: current?.provider.name ?? null,
      providers: session.candidates.map((c) => ({ id: c.provider.id, name: c.provider.name })),
    }
    playerState.emit(currentPlayerState)
  }

  /**
   * How long a provider has to hold the screen before we call it a stream.
   *
   * The behavioural stand-in for the desktop's direct observation of the frame.
   * A minute is longer than anyone spends on a source that shows an error page,
   * a dead player or a wall of ads, and shorter than any real viewing.
   */
  const DWELL_STREAM_MS = 60_000

  /**
   * Below this, switching away is a complaint rather than a preference.
   *
   * Only *switching* counts. Closing the player quickly means the user changed
   * their mind about watching, which says nothing about the provider, and
   * recording that as a failure would demote whichever source happened to be
   * first in the order.
   */
  const DWELL_FAILED_MS = 20_000

  /**
   * Write down what a provider actually proved, when it proved anything.
   *
   * This replaced an optimistic record written the instant a URL was handed to
   * the iframe, which marked every play a success — so `automaticOrder` saw an
   * unbroken run of wins for every provider ever opened, and the source
   * picker's dots were green across the board whatever had really happened.
   * That is not a ranking, it is a list of things that have been clicked.
   *
   * There are now three answers rather than one, and the third is the important
   * one: **say nothing.** A provider shown for half a minute and then left has
   * demonstrated neither success nor failure, and silence keeps it exactly
   * where the user's own ordering put it. Guessing in either direction is what
   * produced the useless ranking.
   */
  /**
   * The source on screen has shown the film: a test result from watching,
   * timed from when it was shown (`PlayMeasurement`). No quality, since the
   * relay's readings do not carry the picture, and no failures: nothing the
   * phone sees while playing is the source's servers declaring one.
   */
  /**
   * Starts of sources on titles here: a warm one files no start time. The
   * phone most of all, where the preview and the player share one WebView
   * and its cache (`WarmStarts`).
   */
  const warmStarts = new WarmStarts()

  /**
   * The source is streaming: the film element itself, at a film's length,
   * with its time moving between two reports. Only the relay's reading of the
   * element counts (`onFilmTime`).
   *
   * Until 2.0.9 any film-length reading did, including what a provider posts
   * of its own accord: VidFast posts its whole watch history the moment its
   * page loads, so a source that then failed was filed as streaming (measured
   * on the emulator: VidFast "streamed" The Office in 8.3 s and never played).
   * Timed to the first report at a film's length, not to the proof.
   */
  const noteFilmPlaying = (time: RelayTime): void => {
    if (!session || !progress || progress.candidateMeasured) return
    if (time.duration < PLAY_MIN_FILM_SECONDS || !time.playing) return
    const first = progress.filmFirst
    if (first === null) {
      progress.filmFirst = { at: Date.now(), seconds: time.seconds }
      return
    }
    if (time.seconds <= first.seconds) return
    progress.candidateMeasured = true
    progress.candidateReported = true
    recordPlay(session, first.at)
  }

  const recordPlay = (current: { req: PlayRequest; candidates: PlayCandidate[]; index: number }, filmAt: number): void => {
    const providerId = current.candidates[current.index]?.provider.id
    // Never for a download: Resume's source rule reads these results.
    if (!progress || providerId === undefined || isDownloadedSource(providerId)) return
    const at = Date.now()
    const ms = filmAt - progress.candidateShownAt
    const where = { device: testResults.device(), titleKey: titleKey(current.req), episode: episodeOf(current.req), providerId }
    const seen = warmStarts.measure(where.titleKey, providerId, {
      at,
      streamed: true as const,
      ...(ms <= PLAY_TIMING_MAX_MS ? { ms } : {}),
    })
    testResults.record([playResult(where, 'play', seen)])
    // The film is playing: its playlist is among the newest requests now, and
    // will not be once the segments have flooded the capture.
    void segmentStore?.notePlaylist(
      windowWhere(current.req, providerId),
      capture.list().catch(() => []),
      progress.reading?.duration ?? 0,
      current.req.runtimeMinutes ?? null,
    )
  }

  const settleOutcome = (req: PlayRequest, providerId: string, switching: boolean): void => {
    // A download is not a source: counting it would rank one that does not exist.
    if (!progress || isDownloadedSource(providerId)) return
    const shownMs = Date.now() - progress.candidateShownAt

    // Proof, not inference: the film element was seen playing (`noteFilmPlaying`).
    // A position the provider posts is not proof since 2.0.9: VidFast posts
    // its watch history on load.
    const outcome: Outcome | null = progress.candidateReported
      ? 'stream'
      : shownMs >= DWELL_STREAM_MS
        ? 'stream'
        : switching && shownMs < DWELL_FAILED_MS
          ? 'failed'
          : null
    if (outcome === null) return

    store.collection('streamOutcomes').replaceAll(
      record(store.read().streamOutcomes, {
        providerId,
        mediaKey: mediaKey(req),
        outcome,
      }),
    )
  }

  /**
   * The request a reading is really about.
   *
   * Not always the one the app opened. Several providers carry their own
   * "next episode" control, and a user who presses it is watching E2 while the
   * app still believes it is showing E1 — the reading says so, and filing its
   * position under the app's belief would write E2's progress onto E1 and
   * resume the wrong episode next time.
   */
  const contextFor = (req: PlayRequest, reading: PlayerReading | null): PlayRequest => {
    const named = reading === null ? null : readingEpisode(req.type, reading)
    if (named === null) return req
    if (named.season === req.season && named.episode === req.episode) return req
    return { ...req, ...named }
  }

  /**
   * Save the place being left. Position only, deliberately.
   *
   * Called on every navigation *within* a title — a provider switch or a
   * reload. `settleProgress` additionally decides "watched" and drains the
   * elapsed-time counter, and neither belongs here: the desktop used to settle
   * on every switch and it cost real progress, because switching source three
   * times split one viewing into three stretches, none long enough to count.
   */
  /** What this device last wrote per title; see `WrittenPositions`. */
  const writtenPositions = new WrittenPositions()

  const rememberPosition = (req: PlayRequest): void => {
    // The video is where the provider put it, not where the viewer is, until
    // the resume seek is seen to take; see `ResumeSeek.pending`. The
    // television resumes by itself, and nothing feeds the seek while it plays.
    if (!onTv && resumeSeek?.pending()) return
    const reading = progress?.reading ?? null
    writePosition(
      contextFor(req, reading),
      reading === null ? null : { seconds: reading.seconds, duration: reading.duration ?? 0, ended: reading.ended },
    )
  }

  /** Write one reading down for `context`: save it, forget a finished one, or leave the memory alone. */
  const writePosition = (
    context: PlayRequest,
    reading: { seconds: number; duration: number; ended: boolean } | null,
  ): void => {
    const points = store.collection('resumePoints')

    // `resumeAction` rather than a threshold of our own. Its three answers exist
    // because collapsing "nothing was learned" into "forget what you knew" is
    // what made resuming flaky on the desktop, and a provider that reports
    // nothing is the *normal* case here rather than the exception.
    const action = resumeAction(reading, context.runtimeMinutes)
    if (action === 'keep') return
    if (action === 'forget') {
      points.remove(resumeKey(context))
      writtenPositions.forget(resumeKey(context))
      return
    }
    const duration = lengthToStore(reading!.duration, points.get(resumeKey(context))?.duration)
    if (!writtenPositions.isChange(resumeKey(context), reading!.seconds, duration)) return

    points.put({
      key: resumeKey(context),
      tmdbId: context.tmdbId,
      seconds: reading!.seconds,
      duration,
    })
  }

  /**
   * Longer than any amount of browsing, shorter than most of what anyone opens
   * on purpose. The desktop's number, for the same reason: it is what stands in
   * when there is no position and TMDB has no runtime either.
   */
  const WATCHED_FALLBACK_MS = 15 * 60_000

  /**
   * Settle the episode being left: save the place, and decide whether it counts
   * as watched.
   *
   * Only on actually leaving an episode — closing the player, or stepping to
   * another one. Never on starting one, which is the mistake that marked a
   * title watched for having been opened and backed out of.
   *
   * `playedMs` here is time the player was *open*, where the desktop measures
   * time the video was *playing*. It is a weaker signal — a paused player still
   * accumulates it — and it is the only one available, because the frame that
   * would know is cross-origin. It matters only for providers that report no
   * position at all, and only past fifteen minutes.
   */
  const settleProgress = (req: PlayRequest): void => {
    if (!progress) return
    const reading = progress.reading
    const context = contextFor(req, reading)

    rememberPosition(req)

    // Leaving is when the other device most wants the place: not in ten seconds.
    pushPositions.now()

    const playedMs = Date.now() - progress.episodeOpenedAt
    const watched = isWatchedEnough({
      seconds: reading?.seconds ?? null,
      duration: reading?.duration ?? null,
      playedMs,
      runtimeMinutes: req.runtimeMinutes,
      fallbackMs: WATCHED_FALLBACK_MS,
      ended: reading?.ended ?? false,
    })

    /**
     * The measurement goes out whatever the verdict — see `playbackSettled` in
     * the IPC contract. It matters more here than on the desktop: most
     * providers report no position on Android, so for many plays this event is
     * the *only* record that anything happened at all.
     */
    playbackSettled.emit({
      tmdbId: context.tmdbId,
      type: context.type,
      season: context.season,
      episode: context.episode,
      playedMs,
      seconds: reading?.seconds ?? null,
      duration: reading?.duration ?? null,
      watched,
    })

    if (!watched) return

    episodeWatched.emit({
      tmdbId: context.tmdbId,
      type: context.type,
      season: context.season,
      episode: context.episode,
    })
  }

  /**
   * Settle whatever is on screen before anything replaces it.
   *
   * Split out because the two halves have different scopes and are needed in
   * different combinations: the *candidate* is settled on every provider
   * switch, the *episode* only when the episode is genuinely being left.
   */
  const leaveCandidate = (switching: boolean): void => {
    if (!session || !progress) return
    const current = session.candidates[session.index]
    if (current) settleOutcome(session.req, current.provider.id, switching)
  }

  /**
   * Leave the player.
   *
   * One function because there is more than one way out — the Android back
   * gesture and `player.close` from the app renderer — and an exit that forgot
   * to take the chrome down with it would leave a bar floating over the browse
   * view.
   */
  /**
   * What the player was fetching, before it goes: the preview cache keeps a
   * window of it from here. Not while casting: the TV's place is not this
   * stream's. Every way a session ends goes through here; until 2.0.8 Play on
   * another title (from the mini player, say) settled the old one and kept
   * nothing, so on a phone used that way the cache stayed empty.
   */
  const keepSessionWindow = (): void => {
    const reading = progress?.reading ?? null
    if (!session || onTv || reading === null || reading.duration === null) return
    keepStreamWindow(session.req, session.candidates[session.index]?.provider.id ?? null, {
      seconds: reading.seconds,
      duration: reading.duration,
    })
  }

  const closePlayer = (): void => {
    // Closed while still held (Back during the carry): the page's preview is
    // standing in for a player that will now never show.
    if (carry !== null && !carry.done) carryReleased.emit(null)
    endCarryTimer()
    carry = null
    if (session) {
      keepSessionWindow()
      leaveCandidate(false)
      settleProgress(session.req)
    }
    upNext.reset()
    skipWatch.reset()
    handover = null
    visibleGate.cancel()
    setMini(false)
    videoPlaying = false
    phoneFullscreen.setActive(false)
    chrome.close()
    surface.close()
    overlayHost.close()
    session = null
    progress = null
    playbackActive.emit(false)
    emitPlayerState()
  }

  /**
   * Step to another episode of the same title.
   *
   * The URLs are rebuilt from scratch rather than patched, because each
   * provider has its own template and only `buildPlayUrl` knows them. The
   * provider in hand is passed as `providerId` so it stays selected across
   * the step.
   *
   * Declared here rather than inline in the returned object because the
   * player's chrome calls the same three verbs the renderer does, and two
   * implementations of "go to the next episode" would eventually disagree
   * about which provider survives the step.
   */
  const playerGoTo = async (season: number, episode: number): Promise<void> => {
    if (!session) return
    const current = session.candidates[session.index]
    const req: PlayRequest = {
      ...session.req,
      season,
      episode,
      providerId: current?.provider.id ?? session.req.providerId,
    }
    const selection = buildPlayUrl(
      orderedForRequest(req),
      req,
      // The episode being stepped to has its own stored position.
      resumeOfferFor(store.read().resumePoints, req),
    )
    const downloaded = downloadedCandidate(req)
    const candidates = [...(downloaded ? [downloaded] : []), ...(selection?.candidates ?? [])]
    if (candidates.length === 0) return

    // Settle the episode being left while `session.req` still names it. After
    // the line below, its time and its position would be credited to the
    // episode being moved to.
    leaveCandidate(false)
    settleProgress(session.req)

    session = { req, candidates, index: 0 }
    if (progress) {
      progress.reading = null
      progress.namedEpisode = null
      progress.episodeOpenedAt = Date.now()
    }
    // A new episode: its end is a new end, and any countdown is for the old one.
    upNext.reset()
    if (onTv) tvStale = true
    showCandidate(0)
  }

  /* ── Auto-next, and the television's position ────────────────────────── */

  /** Where auto-next counts from, or null for a film or an unnumbered episode. */
  const placeOf = (req: PlayRequest): UpNextPlace | null =>
    req.type === 'tv' && req.season !== null && req.episode !== null
      ? { tmdbId: req.tmdbId, season: req.season, episode: req.episode }
      : null

  /** The next episode on its way to the television, or null; see `TvHandover`. */
  let handover: TvHandover | null = null

  const handOverToTv = (): void => {
    handover = new TvHandover(Date.now())
    setTimeout(pumpHandover, TV_HANDOVER.firstTryAfterMs)
  }

  /**
   * Try the hand-over if one is due. Asked by a timer while the app is in
   * front, and by the television's progress events, which keep arriving with
   * the phone in a pocket, where timers run about once a minute.
   */
  const pumpHandover = (): void => {
    const current = handover
    if (current === null) return
    const step = current.next(Date.now())
    if (step === 'give-up') {
      handoverFailed(current)
      return
    }
    if (step !== 'try') return
    void beamToTv().then((result) => {
      if (handover !== current) return
      current.settle(result.ok ? 'ok' : result.final ? 'final' : 'retry')
      if (result.ok) handover = null
      else if (current.done) handoverFailed(current)
      else setTimeout(pumpHandover, TV_HANDOVER.retryEveryMs)
    })
  }

  const handoverFailed = (current: TvHandover): void => {
    if (handover !== current) return
    handover = null
    console.warn('[upnext] the next episode could not be sent to the television')
    // Nobody is looking at the phone, and the episode it loaded for the
    // television would play on there, unseen, unheard and downloading.
    if (document.visibilityState === 'hidden') surface.setPaused(true)
  }

  /** The aired episode after `place`, or null; for auto-next and the credits' "Next episode". */
  const nextEpisodeAfter = async (place: UpNextPlace): Promise<NextEpisode | null> => {
    const detail = await tmdb.detail(place.tmdbId, 'tv').catch(() => null)
    if (detail === null) return null
    // Capped at TMDB's own last aired episode: see `canStepTo` in episodesteps.ts.
    return nextAiredEpisode(place, detail.seasonCount, (n) => tmdb.season(place.tmdbId, n), Date.now(), detail.lastEpisode)
  }

  const upNext = new UpNextController({
    enabled: () => store.read().settings.autoNext,
    resolve: nextEpisodeAfter,
    advance: (next, toTv) => {
      console.log(`[upnext] playing S${next.season}E${next.episode}${toTv ? ' on the television' : ''}`)
      void playerGoTo(next.season, next.episode).then(() => {
        if (toTv) handOverToTv()
      })
    },
  })

  /**
   * The television's position, from native code every five seconds.
   *
   * Taken as the reading while casting, so everything that saves or settles
   * the position — the five-second save, a pause, leaving — uses where the
   * television is. Until 1.9.8 nothing was saved during a cast until it
   * ended. Native rather than a JavaScript poll because a phone casting is
   * usually a phone in a pocket, where JavaScript timers run once a minute;
   * see `onProgress`.
   */
  castBridge.onProgress((tv) => {
    // First, whatever state the readings are in: these events are the
    // hand-over's clock while the app is in the background.
    pumpHandover()
    if (!session || !progress || !onTv || tvStale) return
    // A finished receiver often reports no media at all; its end is the last
    // length it did report.
    const duration = tv.duration > 0 ? tv.duration : (progress.reading?.duration ?? 0)
    if (duration <= 0) return
    const wasPlaying = progress.reading?.playing ?? false
    const reading: PlayerReading = {
      tmdbId: null,
      seconds: tv.finished ? duration : tv.seconds,
      duration,
      season: null,
      episode: null,
      ended: tv.finished,
      playing: tv.playing,
    }
    progress.reading = reading
    rememberPosition(session.req)
    // Paused on the television: the other device may pick up from here.
    if (wasPlaying && !tv.playing && !tv.finished) pushPositions.now()

    const place = placeOf(session.req)
    if (place !== null) upNext.observe(place, reading, session.req.runtimeMinutes, true)
  })

  const playerSwitchProvider = async (providerId: string): Promise<boolean> => {
    if (!session) return false
    const index = session.candidates.findIndex((c) => c.provider.id === providerId)
    if (index < 0) return false

    // Still the same episode, so the position carries over and "watched" is not
    // decided here — only the outgoing provider's outcome is, and switching
    // away quickly is the user telling us it did not work.
    leaveCandidate(true)
    rememberPosition(session.req)
    return showCandidate(index)
  }

  const playerReload = async (): Promise<void> => {
    // Save the place first: the frame is about to be thrown away, and whatever
    // it reported is the last thing anything will know about this attempt.
    if (!session) return
    rememberPosition(session.req)
    const candidate = session.candidates[session.index]
    surface.reload(candidate ? resumeUrl(candidate) : undefined)
  }

  /**
   * The source's URL with the stored position as of now, and the relay seek
   * armed to the same place. Every load goes through here: a new source, a
   * reload, and the picture coming back after a cast or a source test.
   *
   * The candidates' URLs are built when Play is pressed, and until 1.9.9 every
   * later load reused them. So switching source twenty minutes in, or taking
   * the film back from the television, sent the provider to the minute the
   * session *started* at. The seek then saw a provider already past thirty
   * seconds, took that for the provider's own resume, and left it there.
   */
  const resumeUrl = (candidate: PlayCandidate): string => {
    if (!session) return candidate.url
    const offer = resumeOfferFor(store.read().resumePoints, session.req)
    resumeSeek = new ResumeSeek(offer?.seconds ?? 0, session.req.runtimeMinutes)
    return renderTemplate(candidate.provider, session.req, offer) ?? candidate.url
  }

  /** Load `index` of the current session's candidates. */
  const showCandidate = (index: number): boolean => {
    if (!session) return false
    const candidate = session.candidates[index]
    if (!candidate) return false

    session.index = index

    /*
     * Forget what the previous source fetched, before the next one starts.
     *
     * Everything `beam` can cast comes out of a buffer filled by watching the
     * WebView, and for the first few seconds after a switch the newest thing in
     * it still belongs to the *old* provider or the *old* episode. Casting then
     * would put the wrong film on the television while the phone showed the
     * right one — the same error as a provider sweep crediting each provider
     * with its predecessor's stream, and just as hard to see.
     */
    void castBridge.forget()

    surface.show({ ...candidate, url: resumeUrl(candidate) })
    if (progress) {
      progress.candidateShownAt = Date.now()
      progress.candidateReported = false
      progress.candidateMeasured = false
      progress.filmFirst = null
    }
    emitPlayerState()
    return true
  }

  /**
   * One release sweep, plus everything that has to happen around it here.
   *
   * The desktop runs this on a timer in a process that never sleeps. A WebView
   * has no such process, so the sweep runs when the app is in front and the
   * *notifications* are what reach into the future — see `notifications.ts`.
   */
  const sweepReleases = async (): Promise<{ checked: number; found: number }> => {
    const before = store.read().trackers.length
    const notices = await checkAll(store)

    /**
     * The setting the Releases view offers, which this used to ignore.
     *
     * Desktop honours it in one place (`src/main/index.ts`); here it has to be
     * honoured twice, because a phone notification has two lifetimes — the one
     * raised now, and the alarm armed weeks ahead. Turning the toggle off has
     * to disarm the alarms as well, or the app keeps notifying for a month
     * after the user asked it to stop.
     */
    const notificationsEnabled = store.read().settings.notificationsEnabled

    if (notices.length > 0) {
      releaseFound.emit(notices.map((n) => ({ title: n.tracker.title, episode: n.episode })))
      if (notificationsEnabled) {
        void notifyFound(
          notices.map((n) => ({
            title: n.tracker.title,
            season: n.episode.season,
            episode: n.episode.episode,
            episodeName: n.episode.name,
            tmdbId: n.tracker.tmdbId,
          })),
        )
      }
    }

    // Rebuilt after every sweep, because the sweep is what corrects the dates
    // the alarms are set from.
    rearmReleaseAlarms()

    return { checked: before, found: notices.length }
  }

  /**
   * Arm the episode alarms from the trackers as they stand. No requests.
   *
   * An empty list is the disarm: the reconcile cancels every pending alarm it
   * no longer wants.
   */
  const rearmReleaseAlarms = (): void => {
    const trackers = store.read().settings.notificationsEnabled ? store.read().trackers : []
    void syncScheduledReleases(trackers)
  }

  /**
   * The floor under `settings.releaseCheckMinutes`, not a replacement for it.
   *
   * Desktop reads the setting and runs a timer on it. This is a throttle on an
   * event the user does not control — Android fires `resume` for every return
   * from a share sheet or a notification tap — so the setting is honoured and
   * then clamped: a user who asks for five minutes on the desktop should not
   * get a TMDB call per tracked series every time they glance at their phone.
   */
  const MIN_SWEEP_INTERVAL_MS = 15 * 60 * 1000
  /** Before this, a `resume` does nothing at all; see `sweepIfStale`. */
  let nextLookAt = 0

  /**
   * Sweep when the app comes back to the foreground, if one is due.
   *
   * Due by the trackers' own `lastChecked`, not by when this process last
   * swept: a cold start used to sweep every series even minutes after the last
   * sweep, here or on the desktop (the stamps sync). Throttled on top, because
   * Android fires `resume` for every return from a Custom Tab, a share sheet or
   * a notification tap: the next look is when the next sweep falls due.
   */
  const sweepIfStale = (): void => {
    const trackers = store.read().trackers
    if (trackers.length === 0 || Date.now() < nextLookAt) return
    const configured = (store.read().settings.releaseCheckMinutes || 60) * 60 * 1000
    const interval = Math.max(configured, MIN_SWEEP_INTERVAL_MS)

    const wait = sweepDueIn(trackers, interval)
    if (wait > 0) {
      nextLookAt = Date.now() + wait
      // Not due, but the other device's sweep may have synced in new dates or
      // new series, and a sweep here is the only other thing that arms them.
      rearmReleaseAlarms()
      return
    }
    nextLookAt = Date.now() + interval
    void sweepReleases().catch(() => {
      // Offline, most likely. The next resume tries again.
    })
  }

  /**
   * Flush the store the moment the app leaves the foreground.
   *
   * Writes are debounced by 400ms to keep episode toggles from serialising the
   * whole document three times in a row — which is right while the app is in
   * front and wrong the instant it is not, because Android kills a backgrounded
   * app without warning and whatever was still in that window is gone. `pause`
   * is the last callback guaranteed to run.
   */
  void CapacitorApp.addListener('pause', () => {
    // The exact place first: Android may not let this process run again for a
    // while, and the last five-second sample could be up to five seconds old.
    if (session) rememberPosition(session.req)
    void store.flush().catch(() => {})
    void resultStore.flush().catch(() => {})
    pushPositions.now()
  })

  /**
   * Tapping an episode notification.
   *
   * The desktop does exactly this and nothing more — focus the window, show the
   * Releases tab — and matching it is the whole ambition here. A notification is
   * an interruption the user chose to act on, so the right response is to put
   * them where the thing they were told about is listed, not to guess at a
   * deeper destination and be wrong.
   *
   * Registered on every launch rather than only on a warm resume: a notification
   * is most often tapped when the app is *not* running, and the plugin holds the
   * launching intent until a listener exists to receive it.
   */
  void LocalNotifications.addListener('localNotificationActionPerformed', () => {
    navigate.emit('releases')
  })

  void CapacitorApp.addListener('resume', sweepIfStale)
  // Also on launch: the app is "resumed" only on a *return*, and a cold start
  // after a week away is exactly when there is most to catch up on. A moment
  // after it, as on the desktop, so the first views load before the sweep's
  // requests, and a sync on launch can bring in the other device's stamps.
  setTimeout(sweepIfStale, 15_000)

  /**
   * Android's back button.
   *
   * Registering a listener replaces Capacitor's default, so this has to answer
   * every case, not just the interesting one. In order: leave the player, then
   * close whatever overlay is open, then quit.
   *
   * The overlay check reads the DOM, which is a reach across the platform
   * boundary this file otherwise keeps clean. The alternative is a new signal
   * in `WtaApi` — the contract all three desktop processes compile against —
   * for a question only Android asks. Dispatching the key the renderer already
   * binds is the smaller lie.
   */
  void CapacitorApp.addListener('backButton', () => {
    // Each press takes one layer away: an open panel of the player closes,
    // fullscreen ends, a full player shrinks into the corner (as the chrome's
    // ← does), then an open panel of the app closes, then the mini player
    // stops, and only then does the app quit.
    // Our controls' own menu (subtitles, quality): the overlay closes it on Escape.
    if (session && !mini && document.querySelector('#wta-player-overlay .menu')) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      return
    }
    if (session && !mini && overlayHub.panelOpen()) {
      overlayHub.closePanel()
      return
    }
    if (session && !mini && phoneFullscreen.current()) {
      phoneFullscreen.toggle()
      return
    }
    if (session && !mini) {
      setMini(true)
      return
    }
    // An open layer of the app (the detail view, a dialog, the providers
    // panel), which Escape closes. Asked by the mark the layer helper puts on
    // them (`lib/modal.ts`), not by class: this matched `.scrim` until 2.0.12,
    // and the player overlay keeps a `.scrim` of its own in the page while the
    // player is small, so once only the mini player was left, Back sent a
    // useless Escape for ever and could neither stop it nor quit.
    if (document.querySelector('[data-layer]')) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return
    }
    // Stopped here, not left to die with the app: the episode's position and
    // whether it counts as watched are settled only when the player closes.
    if (session) {
      closePlayer()
      return
    }
    void CapacitorApp.exitApp()
  })

  /**
   * Order the enabled providers for one request.
   *
   * `scanAwareOrder` rather than `automaticOrder`, matching the desktop: it
   * folds in the measurement when something has been scanned, which the older
   * function cannot. Both apps must rank identically — the source picker's
   * dots are drawn from the same ranking, and the renderer that draws them is
   * shared. The same goes for `resumeFirst` after it.
   */
  const automaticOrderFor = (req: TitleRef & { season?: number | null; episode?: number | null }): AutomaticOrder => {
    const { streamOutcomes, favouriteProviderIds, settings } = store.read()
    const key = titleKey(req)
    const outcomes = outcomesForTitle(streamOutcomes, key)
    // The episode's own results where there are any: see `titleResults`.
    const { scan } = titleResults(testResults.sources(), key, episodeOf(req), 'phone')
    const ordered = scanAwareOrder(enabledProviders(), outcomes, {
      order: providerOrder(),
      favouriteIds: favouriteProviderIds,
      scan,
      sourceOrder: settings.sourceOrder,
    })
    // Then back to the source this title was last watched on here, unless the
    // owner asked for the best every time — see `resumeFirst`, `lastPlayedHere`.
    const last = settings.resumeSource === 'best' ? null : lastPlayedHere(testResults.sources(), key)
    return resumeFirst(ordered, last, outcomes, scan)
  }
  const orderedForRequest = (req: TitleRef & { season?: number | null; episode?: number | null }): Provider[] =>
    automaticOrderFor(req).providers

  /**
   * Everything a source picker draws for one title, including the order.
   *
   * One function for both surfaces that ask — the detail view's picker and the
   * player chrome's source menu — which previously carried a copy each. The
   * order comes from `orderedForRequest`, the function playback itself uses,
   * so the rows read top to bottom in the order Automatic will try them.
   */
  const providerStateFor = (media: TitleRef, episode?: { season: number; episode: number } | null): TitleProviderState => {
    const doc = store.read()
    const key = titleKey(media)
    const now = Date.now()
    // The episode's own results where there are any; without one, the whole title's.
    const request = { ...media, season: episode?.season ?? null, episode: episode?.episode ?? null }
    const automatic = automaticOrderFor(request)
    const order = automatic.providers.map((provider) => provider.id)
    const sources = testResults.sources()
    const results = titleResults(sources, key, episodeOf(request), 'phone', now)
    return {
      outcomes: outcomesForTitle(doc.streamOutcomes, key),
      resume: automatic.resume,
      scan: results.scan,
      sharedFrom: results.sharedFrom,
      castability: castabilities(order, results.scan, everyRow(sources, 'phone', now), now),
      order,
    }
  }

  /**
   * Trying every provider in hidden sessions, two at a time, with playback
   * stopped so the probes have the phone's bandwidth and decoder to
   * themselves — see `scan.ts`. `suspendPlayback` reuses the surface's
   * `blank`/`restore`, which casting added for the same need.
   */
  const scanRunner = createScanRunner({
    providers: enabledProviders,
    // Left alone while casting: the television has the picture, and bringing
    // the phone's back when the scan ends would play the film twice.
    suspendPlayback: () => {
      if (onTv) return
      // The exact place, not the last five-second sample: it is where the
      // picture comes back to.
      if (session) rememberPosition(session.req)
      surface.blank()
    },
    resumePlayback: () => {
      if (onTv) return
      const candidate = session?.candidates[session.index]
      surface.restore(candidate ? resumeUrl(candidate) : undefined)
    },
    onProgress: (payload) => providerScan.emit(payload),
    onStream: (key, providerId, requests) => {
      const title = scanStreams.get(key) ?? new Map<string, Candidate[]>()
      title.set(providerId, requests)
      scanStreams.set(key, title)
    },
  })

  /**
   * The playlists each source's session asked for in the scan under way, by
   * title then source; in memory only, dropped once the scan is filed.
   */
  const scanStreams = new Map<string, Map<string, Candidate[]>>()

  /**
   * After a test, keep the preview's first seconds, as on the desktop
   * (`cacheAfterTest` in `src/main/index.ts`): its source, from where it would
   * start, if no window is kept yet.
   */
  const cacheAfterTest = (media: TitleRef, episode: { season: number; episode: number } | null, runtimeMinutes: number | null): void => {
    const key = titleKey(media)
    const streams = scanStreams.get(key)
    scanStreams.delete(key)
    const cache = segmentStore
    if (!streams || cache === null) return
    const req: PlayRequest = {
      ...media,
      title: '',
      season: episode?.season ?? null,
      episode: episode?.episode ?? null,
      providerId: null,
      runtimeMinutes,
    }
    const choice = choosePreview({
      providers: automaticOrderFor(req).providers,
      scan: titleResults(testResults.sources(), key, episodeOf(req), 'phone').scan,
      req,
      resume: resumeOfferFor(store.read().resumePoints, req),
    })
    const requests = choice && streams.get(choice.provider.id)
    if (!choice || !requests) {
      const why = choice ? `${choice.provider.id}, its preview source, did not stream in it` : 'no source previews'
      console.log(`[cache] nothing kept after the test (${key}): ${why}`)
      return
    }
    if (cache.find(windowWhere(req, choice.provider.id), choice.startSeconds) !== null) return
    void cache.save(
      windowWhere(req, choice.provider.id),
      requests,
      { seconds: choice.startSeconds, duration: 0 },
      runtimeMinutes,
      saveNames(req, choice.provider.id),
    )
  }

  /**
   * A scan stops when the app leaves the foreground.
   *
   * Android throttles a backgrounded WebView, and a probe starved of it looks
   * exactly like a provider that does not stream: a scan left running with the
   * screen off stored a row of false reds that steered Automatic for days.
   * Cancelled, it records only what it finished measuring in the foreground,
   * and the user can scan again.
   */
  void CapacitorApp.addListener('pause', () => scanRunner.cancel())

  /**
   * Run a scan and write down what it found.
   *
   * One function because both the detail view's picker and the player's source
   * menu start scans, and two copies would be two chances to forget the store
   * write — which would leave the dots correct until the app restarted.
   */
  const runProviderScan = async (
    media: TitleRef,
    episode?: { season: number; episode: number } | null,
    runOptions?: ScanRunOptions,
  ): Promise<ProviderScan> => {
    const key = titleKey(media)
    // Only what has come out, as on the desktop — see `aired.ts` and the
    // scan handler in `src/main/ipc.ts`.
    const facts = await tmdb.detail(media.tmdbId, media.type).catch(() => null)
    if (facts && notOutYet(facts.releaseDate, Date.now())) return { titleKey: key, at: Date.now(), verdicts: {} }
    // Never probe a TV title without an episode — see `scanEpisode`.
    const wanted = scanEpisode(media.type, episode)
    const target = wanted && facts ? airedEpisode(wanted, facts.lastEpisode) : wanted
    const result = await scanRunner.run(
      key,
      {
        imdbId: media.imdbId,
        tmdbId: media.tmdbId,
        type: media.type,
        season: target?.season ?? null,
        episode: target?.episode ?? null,
      },
      runOptions,
    )
    // Filed under the episode it tested: see `scanEpisode` and `airedEpisode`.
    testResults.record(resultsFromScan(result, testResults.device(), target))
    cacheAfterTest(media, target, facts?.runtime ?? null)
    return result
  }

  /**
   * Every source of a title, tested by itself (`main/autotest.ts`): ten
   * minutes after it is added, while nothing plays; or while it is watched
   * for the first time, one source at a time beside the film, which is not
   * paused for it, and none started while the film buffers. The episode is
   * the one playing, or where the viewer is (`resumeAnchor`), or S1E1.
   */
  const autoTester = new AutoTester({
    watchlist: () => store.read().watchlist,
    tested: (key) => kindTested(testResults.sources(), 'phone', key, enabledProviders().map((p) => p.id)),
    playing: () =>
      session && !onTv && (carry === null || carry.done)
        ? {
            tmdbId: session.req.tmdbId,
            type: session.req.type,
            download: isDownloadedSource(session.candidates[session.index]?.provider.id),
          }
        : null,
    busy: () => scanRunner.busy(),
    log: (line) => console.log(line),
    run: async (entry, mode) => {
      const watching =
        mode === 'watching' && session?.req.tmdbId === entry.tmdbId && session.req.type === entry.type ? session.req : null
      const episode =
        watching && watching.season != null && watching.episode != null
          ? { season: watching.season, episode: watching.episode }
          : entry.type === 'tv'
            ? resumeAnchor(entry)
            : null
      await runProviderScan(
        { tmdbId: entry.tmdbId, imdbId: entry.imdbId, type: entry.type },
        episode,
        mode === 'watching'
          ? { concurrency: 1, keepPlaying: true, hold: () => filmBuffering }
          : { hold: () => session !== null },
      )
    },
  })
  setInterval(() => autoTester.tick(), AUTO_TEST_TICK_MS)

  /**
   * The player chrome's own API, installed the moment the bridge exists.
   *
   * Separate from `window.wta` for the same reason it is on desktop: the
   * chrome is a different surface with a much smaller set of verbs, every one
   * of which the app could already do. It is installed here rather than in
   * `main.ts` so that nothing can mount `PlayerChrome` before it is available
   * — the component reads `window.wtaChrome` at the top of its script.
   */
  window.wtaChrome = createChromeApi({
    subscribeState: (cb) => playerState.subscribe(cb),
    currentState: () => currentPlayerState,
    subscribeSuggestion: (cb) => playerSuggestion.subscribe(cb),
    subscribeSkip: (cb) => playerSkip.subscribe(cb),
    skip: pressSkip,
    minimize: () => setMini(true),
    subscribeMini: (cb) => playerMini.subscribe(cb),
    goTo: playerGoTo,
    switchProvider: playerSwitchProvider,
    reload: playerReload,
    season: (tmdbId, season) => tmdb.season(tmdbId, season),
    scan: (media, episode) => runProviderScan(media, episode),
    cancelScan: async () => scanRunner.cancel(),
    // Only runs about what is playing, as main does for the desktop's chrome
    // (`progressIsAbout`): an automatic test of another title, or of the
    // episode before a step, painted its verdicts onto this source list.
    subscribeScan: (cb) =>
      providerScan.subscribe((progress) => {
        if (session && progressIsAbout(progress, titleKey(session.req), episodeOf(session.req))) cb(progress)
      }),
    outcomes: async (media, episode) => providerStateFor(media, episode),
    overlay: overlayHub.chrome,
    /**
     * The chrome gets the same cast bridge the main API uses, not a second one.
     *
     * Two instances would each believe they owned the proxy, and stopping a
     * cast from one would leave the other reporting a session that no longer
     * exists.
     */
    cast: {
      available: () => castBridge.available(),
      startDiscovery: () => castBridge.startDiscovery(),
      stopDiscovery: () => castBridge.stopDiscovery(),
      devices: () => castBridge.devices(),
      connect: (deviceId) => castBridge.connect(deviceId),
      disconnect: async () => {
        await reclaimFromTv()
        await castBridge.disconnect()
      },
      status: () => castBridge.status(),
      beam: async () => beamToTv(),
      control: (action, seconds) => castBridge.control(action, seconds),
      setVolume: (level) => castBridge.setVolume(level),
      setMuted: (muted) => castBridge.setMuted(muted),
    },
  })

  /**
   * Background work over the saved library, in order and off the hot path.
   *
   * The desktop does the same at startup; the phone needs its own call because
   * the two have no shared process, only a shared module. Unawaited and slow on
   * purpose — nothing on screen waits for either, and a run cut short by the
   * app being backgrounded resumes next launch. They are *sequenced* rather
   * than fired together because the season split tombstones legacy watched
   * entries, and a score write landing on one of those ids afterwards would
   * resurrect it.
   */
  void (async () => {
    /**
     * Split whole-series watched entries into one per season.
     *
     * A library built before 1.5.7 holds one entry per series meaning "all of
     * it", which under the per-season model reads as a shelf of single cards
     * with every season claimed at once — see `seasonsplit.ts`.
     */
    await runSeasonSplit({
      watched: () => store.read().watched,
      ratings: () => store.read().ratings,
      watchlistEntry: (tmdbId) => store.read().watchlist.find((w) => w.tmdbId === tmdbId),
      identify: tmdbIdentify(tmdb.detail),
      putWatched: (entries) => store.collection('watched').putMany(entries),
      removeWatched: (id) => void store.collection('watched').remove(id),
      putRatings: (ratings) => store.collection('ratings').putMany(ratings),
      removeRating: (key) => void store.collection('ratings').remove(key),
    }).catch(() => {
      // Whatever it managed is already saved and the rest is still legacy, so
      // the next launch tries again. Failing here must not stop the backfill.
    })

    /** Top up scores for titles saved before the app stored one. */
    await backfillScores({
      pending: () => {
        const document = store.read()
        const seen = new Set<number>()
        return [
          ...document.watchlist.filter((w) => !(w.rating > 0)),
          ...document.watched.filter((w) => !(w.rating > 0)),
        ].filter((entry) => {
          if (seen.has(entry.tmdbId)) return false
          seen.add(entry.tmdbId)
          return true
        })
      },
      score: async (tmdbId, type) => (await tmdb.detail(tmdbId, type))?.rating ?? 0,
      save: (tmdbId, score) => {
        for (const name of ['watchlist', 'watched'] as const) {
          const collection = store.collection(name)
          // Every entry for the title, not the first: a split series has one
          // watched entry per season and they all want the same score.
          for (const entry of store.read()[name].filter((e) => e.tmdbId === tmdbId)) {
            collection.put({ ...entry, rating: score })
          }
        }
      },
    })
  })()

  return {
    store: {
      read: async () => {
        // See `StoreCore.loadFailure`: never hand the app an empty stand-in.
        if (store.loadFailure !== null) throw new Error(unreadableLibrary(store.loadFailure))
        return store.read()
      },
      write: async (patch: Partial<StoreShape>) => {
        store.applyPatch(patch)
      },
      seed: async (patch: Partial<StoreShape>) => {
        store.seedPatch(patch)
      },
      recovered: async () => (store.recovered === null ? null : recoveredLibrary(store.recovered)),
    },

    tmdb: {
      row: (req: RowRequest | GenreRowRequest | DiscoverRequest) =>
        tmdb.row(req) as Promise<Paged<MediaSummary>>,

      /**
       * The personalised rows, planned and filled here rather than in the
       * renderer — the same two calls the desktop's IPC handlers make, over
       * the same store document, so the two platforms cannot disagree about
       * what a user's Browse page is.
       */
      forYouPlan: (req: ForYouPlanRequest) => forYouPlan(store.read(), req.seed, tmdbNetwork),
      forYouRow: (req: ForYouRowRequest) => forYouRow(store.read(), req, tmdbNetwork),

      detail: (id: number, type: MediaType): Promise<MediaDetail | null> => tmdb.detailOrNull(id, type),
      season: (id: number, s: number): Promise<Season | null> => tmdb.season(id, s),
      trailer: (id: number, type: MediaType) => tmdb.trailer(id, type),
    },

    search: (query: string, page: number) => search.search(query, page),
    resolve: (item: MediaSummary) => search.resolve(item),

    providers: {
      list: async () => allProviders(),
      outcomes: async (media: TitleRef, episode?: { season: number; episode: number } | null): Promise<TitleProviderState> =>
        providerStateFor(media, episode),
      scan: (media, episode) => runProviderScan(media, episode),
      cancelScan: async () => scanRunner.cancel(),
      // No background tester here: a probe needs the visible surface, and a
      // phone testing sources on its own would spend battery and data unasked.
      backgroundStatus: async () => null,
    },

    releases: {
      checkNow: sweepReleases,
    },

    /**
     * Start playback in the in-app surface.
     *
     * The same shape as the desktop: the renderer mounts its player chrome off
     * `playerState`, and the platform layer puts a video surface in the hole
     * that chrome leaves. Only the surface differs — a `WebContentsView` there,
     * an iframe here.
     */
    play: async (req: PlayRequest, options?: { carry?: boolean }) => {
      if (!(await providersAllowed)) return { ok: false, error: OUTDATED_WEBVIEW }
      const enabled = orderedForRequest(req)
      if (enabled.length === 0) {
        return { ok: false, error: 'No providers are enabled — turn one on in the Providers panel' }
      }

      /**
       * Start where the user left off, by asking the provider to.
       *
       * This is the only resume mechanism the phone has. The desktop reaches
       * into the provider's frame and sets `currentTime`; a WebView cannot —
       * `evaluateJavascript` sees the main frame only and most providers nest
       * their player an iframe deeper — so without this the app remembers the
       * position perfectly and then starts the episode from the beginning,
       * which is exactly how it was reported.
       */
      // The other device may have played this moments ago; its place is worth
      // up to a second and a half of waiting. See `PositionsChannel.freshen`.
      await sync.freshenPositions()
      const built = buildPlayUrl(
        enabled,
        req,
        resumeOfferFor(store.read().resumePoints, req),
      )
      // A finished download plays first, and plays with no source enabled.
      await downloadsReady
      const downloaded = downloadedCandidate(req)
      const candidates = [...(downloaded ? [downloaded] : []), ...(built?.candidates ?? [])]
      const selection = candidates[0] ? { ...candidates[0], candidates } : null
      if (!selection) {
        return { ok: false, error: 'No enabled provider can play this' }
      }

      // Playing something new while something else is up: settle the old one
      // first, exactly as closing the player would.
      if (session) {
        keepSessionWindow()
        leaveCandidate(false)
        settleProgress(session.req)
      }
      // Pressing Play is asking to watch, so what plays next opens full size
      // even when it replaces a mini player.
      setMini(false)
      upNext.reset()
      // A picture held back for when the app returns belongs to what played before.
      visibleGate.cancel()

      session = { req, candidates: selection.candidates, index: 0 }
      const now = Date.now()
      progress = {
        reading: null,
        episodeOpenedAt: now,
        candidateShownAt: now,
        candidateReported: false,
        candidateMeasured: false,
        filmFirst: null,
        writtenAt: now,
        namedEpisode: null,
      }
      // A carry belongs to the Resume that asked for it. Until this, one that
      // had finished lived on to the next play (a Watchlist card's, from the
      // mini player) and took away that title's resume seek below.
      if (carry !== null) {
        // Only one still in flight is announced as over: a finished one was,
        // and announcing it again would end the carry this play is starting.
        if (!carry.done) releaseCarry()
        endCarryTimer()
        carry = null
      }
      if (options?.carry) holdForCarry()
      showCandidate(0)
      // The carry does the seeking, to where the preview is by then.
      if (carry !== null) resumeSeek = null
      chrome.open()
      phoneFullscreen.setActive(!onTv)
      playbackActive.emit(true)

      return {
        ok: true,
        url: selection.url,
        providerId: selection.provider.id,
        providerName: selection.provider.name,
      }
    },

    /**
     * Driving the surface.
     *
     * All of these are real now except `dismissSuggestion`, which stays a no-op
     * because nothing on this platform can raise a suggestion: detecting a
     * stall means reading a `<video>` in a cross-origin document.
     */
    player: {
      setBounds: async (bounds) => {
        surface.setBounds(bounds)
      },

      close: async () => closePlayer(),
      dismissSuggestion: async () => {},
      reload: playerReload,
      setMini: async (next) => setMini(next),
      setPaused: async (paused) => surface.setPaused(paused),
      // The keys `PlayerFrame` takes off the page.
      action: async (action) => routePlayerAction(action, 'keys', playerActions),
    },

    cast: {
      available: () => castBridge.available(),
      startDiscovery: () => castBridge.startDiscovery(),
      stopDiscovery: () => castBridge.stopDiscovery(),
      devices: () => castBridge.devices(),
      connect: (deviceId) => castBridge.connect(deviceId),
      disconnect: async () => {
        await reclaimFromTv()
        await castBridge.disconnect()
      },
      status: () => castBridge.status(),
      control: (action, seconds) => castBridge.control(action, seconds),
      setVolume: (level) => castBridge.setVolume(level),
      setMuted: (muted) => castBridge.setMuted(muted),
      beam: async () => beamToTv(),
    },

    mal: {
      preview: async (): Promise<MalPreview | null> => {
        const text = await pickTextFile('.xml,text/xml,application/xml')
        if (text === null) return null

        const parsed = parseMalExport(text)
        pendingMal = parsed.entries
        return {
          userName: parsed.userName,
          entries: parsed.entries,
          skipped: parsed.skipped,
          defaultTargets: DEFAULT_TARGETS,
          defaultSelected: DEFAULT_SELECTED,
          labels: STATUS_LABELS,
        }
      },

      commit: async (decisions: MalDecisions): Promise<MalImportSummary> => {
        /**
         * Resolve each MAL title to a TMDB one.
         *
         * The variant/ranking logic is imported rather than reimplemented —
         * it is what took the match rate from 9/15 to 60/60 and it has nothing
         * platform-specific in it. `findBestMatch` is the same function the
         * desktop resolves with.
         */
        const resolveTitle = async (
          title: string,
          type: MediaType,
        ): Promise<ResolvedTitle | null> => {
          const best = await findBestMatch(title, type, async (term) => (await tmdb.search(term, 1)).items)
          if (!best) return null
          return {
            tmdbId: best.tmdbId,
            type: best.type,
            imdbId: best.imdbId ?? null,
            title: best.title,
            posterPath: best.posterPath ?? null,
            genreIds: best.genreIds ?? [],
            rating: best.rating ?? 0,
          }
        }

        const { store: next, summary } = await applyMalImport(
          store.read(),
          pendingMal,
          decisions,
          resolveTitle,
          (done, total) => malProgress.emit({ done, total }),
        )
        // Merged rather than replaced, as on the desktop: see `StoreCore.mergeDocument`.
        await store.mergeDocument(next)
        /**
         * Cleared, exactly as `src/main/ipc.ts` does after its own commit.
         * Left in place, a second commit without an intervening `preview()`
         * re-imports the previous file — and the MAL dialog offers "Import"
         * again without closing.
         */
        pendingMal = []
        return summary
      },
    },

    /**
     * Open a web address outside the app.
     *
     * A Custom Tab rather than a plain intent, which matters for the one caller
     * there is: it shares the system browser's cookies, so a user signing this
     * app into their Google account is usually already signed in there, and the
     * page lands ready to accept the code rather than on a login form.
     *
     * `Browser.open` resolves once Android has accepted the intent, which is
     * not the same as a tab having appeared. The false this can return means
     * the app refused to hand the URL over, not that displaying it failed.
     */
    /*
     * The detail view's stream preview, on the phone: the provider's own URL,
     * which the page puts in an iframe of its own and drives itself. The relay
     * is already in every frame of this WebView (`installFilmRelay`), and the
     * preview iframe is a direct child of the page, which is the parent the
     * relay obeys. It is not the player's surface, so the player's controls
     * never mount over it.
     */
    /** Downloads, on the shared core (`./downloads.ts`). A null status leaves every download control out. */
    downloads: {
      status: async () => (await downloadsReady)?.manager.status() ?? null,
      start: async (request) => (await downloadsReady)?.manager.start(request) ?? { ok: false, error: 'Downloads are unavailable on this phone' },
      pause: async (id) => void (await (await downloadsReady)?.manager.pause(id)),
      resume: async (id) => void (await (await downloadsReady)?.manager.resume(id)),
      remove: async (id) => void (await (await downloadsReady)?.manager.remove(id)),
      setQuality: async (quality) => void (await (await downloadsReady)?.manager.setQuality(quality)),
    },
    preview: {
      plan: async (req: PlayRequest): Promise<PreviewPlan | null> => {
        // A preview is a provider in a frame of this WebView too.
        if (!(await providersAllowed)) return null
        const key = titleKey(req)
        // Straight after the player: its window may still be arriving, and is the one to start from.
        await segmentStore?.settled(key, PLAN_WAITS_FOR_SAVE_MS)
        const doc = store.read()
        const resume = resumeOfferFor(doc.resumePoints, req)
        // The window kept for this episode, from whichever source it came: it
        // plays whatever source the preview then takes over from.
        const keptSource = segmentStore?.keptSource(episodeWhere(req), resume?.seconds ?? 0) ?? null
        const choice = planPreview({
          providers: automaticOrderFor(req).providers,
          scan: titleResults(testResults.sources(), key, episodeOf(req), 'phone').scan,
          req,
          resume,
          keptSource,
        })
        if (choice === null) return null
        return {
          surface: 'iframe',
          src: choice.url,
          providerId: choice.provider.id,
          providerName: choice.provider.name,
          startSeconds: choice.startSeconds,
          cached: keptSource === null ? null : (segmentStore?.find(windowWhere(req, keptSource), choice.startSeconds) ?? null),
        }
      },
      record: async (req: PlayRequest, providerId: string, streamedMs: number, filmSeconds = 0): Promise<void> => {
        const where = { device: testResults.device(), titleKey: titleKey(req), episode: episodeOf(req), providerId }
        const result = previewResult(where, streamedMs, Date.now())
        if (result) testResults.record([warmStarts.measure(where.titleKey, providerId, result)])
        // The preview's film is playing: note its playlist while the capture still has it.
        void segmentStore?.notePlaylist(windowWhere(req, providerId), capture.list().catch(() => []), filmSeconds, req.runtimeMinutes ?? null)
      },
      carry: async (report: CarryReport): Promise<void> => {
        if (carry === null || carry.done) return
        const mutedBefore = carry.last()?.muted
        carry.update({ ...report, at: Date.now() })
        if (report.muted !== mutedBefore) announceOverlayConfig()
      },
      carryEnd: async (): Promise<void> => releaseCarry(),
      cacheStatus: async () => segmentStore?.status() ?? null,
      /** The preview settles like a play; see `keepPreviewPosition` on the desktop. */
      keep: async (
        req: PlayRequest,
        seconds: number,
        duration: number,
        options?: { cacheSource?: string; playedMs?: number },
      ): Promise<void> => {
        if (!Number.isFinite(seconds) || seconds <= 0) return
        const length = Number.isFinite(duration) ? duration : 0
        writePosition(req, { seconds, duration: length, ended: false })
        pushPositions.now()
        const playedMs = Math.max(0, options?.playedMs ?? 0)
        const watched = isWatchedEnough({
          seconds,
          duration: length > 0 ? length : null,
          playedMs,
          runtimeMinutes: req.runtimeMinutes,
          fallbackMs: WATCHED_FALLBACK_MS,
        })
        const episode = { tmdbId: req.tmdbId, type: req.type, season: req.season ?? null, episode: req.episode ?? null }
        playbackSettled.emit({ ...episode, playedMs, seconds, duration: length > 0 ? length : null, watched })
        if (watched) episodeWatched.emit(episode)
        if (options?.cacheSource) keepStreamWindow(req, options.cacheSource, { seconds, duration })
      },
    },
    openExternal: async (url: string): Promise<boolean> => {
      if (!isOpenableExternally(url)) return false
      try {
        await Browser.open({ url })
        return true
      } catch {
        // No browser and no Custom Tab provider at all. Rare, and survivable:
        // the caller keeps the address on screen for the user to type.
        return false
      }
    },

    data: {
      /**
       * The share sheet, then the desktop's own result shape.
       *
       * Returning the payload — which is what this used to do — made a
       * *successful* export report "Export failed." to the user, because the
       * only consumer (`Watchlist.svelte`) reads `result.ok` and an export
       * document has no such field. The contract types this `Promise<unknown>`,
       * so nothing in three type-checked processes could notice.
       */
      export: async () => {
        const payload = exportStore(store.read())
        const stamp = new Date().toISOString().slice(0, 10)
        const name = `watchthemall-${stamp}.json`
        try {
          await shareTextFile(name, JSON.stringify(payload, null, 2), 'Export WatchThemAll data')
        } catch (err) {
          /**
           * Dismissing the share sheet rejects, and so does a write that
           * failed. They are not the same answer: `cancelled` is silent in the
           * renderer and an error is not. Capacitor's Share plugin says which
           * by message — there is no error code to test.
           */
          const message = err instanceof Error ? err.message : 'Export failed'
          if (/cancel/i.test(message)) return { ok: false, cancelled: true }
          return { ok: false, error: message }
        }
        return { ok: true, path: name }
      },

      import: async (payload: unknown) => {
        /**
         * Null means "ask the user for a file", matching the desktop contract
         * where a null payload opens the picker rather than importing nothing.
         */
        let incoming = payload
        if (incoming === null || incoming === undefined) {
          const text = await pickTextFile('.json,application/json')
          // `cancelled`, not an error message: the renderer returns silently on
          // the first and prints the second as a failure note. Saying
          // "Cancelled" in the error slot put the word on screen in red.
          if (text === null) return { ok: false, cancelled: true }
          try {
            incoming = JSON.parse(text)
          } catch {
            return { ok: false, error: 'That file is not valid JSON' }
          }
        }

        const current = store.read()
        const result = importIntoStore(current, incoming)
        if (!result.ok) return { ok: false, error: result.error }
        await store.replaceDocument(current)
        return { ok: true }
      },
    },

    sync: {
      status: async () => sync.status(),
      connect: () => sync.connect(),
      cancel: async () => sync.cancel(),
      disconnect: () => sync.disconnect(),
      now: () => sync.now(),
    },

    on: {
      menuAction: (cb) => menuAction.subscribe(cb),
      navigate: (cb) => navigate.subscribe(cb),
      releaseFound: (cb) => releaseFound.subscribe(cb),
      episodeWatched: (cb) => episodeWatched.subscribe(cb),
      playbackSettled: (cb) => playbackSettled.subscribe(cb),
      storeChanged: (cb) => storeChanged.subscribe(cb),
      playbackActive: (cb) => playbackActive.subscribe(cb),
      carryReleased: (cb) => carryReleased.subscribe(() => cb()),
      carryAction: (cb) => carryAction.subscribe(cb),
      playerState: (cb) => playerState.subscribe(cb),
      playerMini: (cb) => playerMini.subscribe(cb),
      playerPaused: (cb) => playerPaused.subscribe(cb),
      playerSuggestion: (cb) => playerSuggestion.subscribe(cb),
      playerPointerTop: (cb) => playerPointerTop.subscribe(cb),
      providerScan: (cb) => providerScan.subscribe(cb),
      watchlistTest: () => () => {},
      downloads: (cb) => downloadsStatus.subscribe(cb),
      syncStatus: (cb) => syncStatus.subscribe(cb),
      malProgress: (cb) => malProgress.subscribe(cb),
    },
  }
}
