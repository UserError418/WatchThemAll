/**
 * Electron main process — composition root.
 *
 * Everything substantial lives in a sibling module; this file wires them
 * together and owns the app lifecycle. It is deliberately short: the original's
 * 872-line main.js mixed window management, storage, IPC, HTTP and a video
 * downloader in one file, and there was no way to test any of it.
 */

import { app, BrowserWindow, ipcMain, Notification, session } from 'electron'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { isListed } from '@shared/listed'
import { EV } from '@shared/ipc'
import type { PlayRequest, PreviewPlan, TitleRef } from '@shared/ipc'
import type { CapturedRequest } from './segmentsave'
import { NodePersistence, Store } from './store'
import { registerIpc, type IpcHandles } from './ipc'
import { createCastService } from './castservice'
import { UpNextController, type UpNextPlace } from './upnext'
import { nextAiredEpisode, type NextEpisode } from '@shared/episodesteps'
import { malIdFor } from './animeids'
import { buildMenu, createTray, type MenuDeps } from './menu'
import { createAppWindow } from './windows'
import { createInlinePlayer, type InlinePlayer } from './playerview'
import * as tmdb from './tmdb'
import { applyBrowserIdentity, CHROME_UA } from './identity'
import { APP_PERMISSIONS, restrictPermissions, SOURCE_PERMISSIONS } from './permissions'
import { playerShellUrl, serveCacheFrom, startRendererServer, stopRendererServer } from './localserver'
import { createSegmentStore, type SaveNames, type SegmentStore, type WindowWhere } from './segmentstore'
import { nodeCacheFiles } from './segmentfiles'
import { choosePreview, planPreview } from './previewplan'
import { allowStreamPreviews, previewRequests } from './previewview'
import { isProbeRun, probeAndQuit } from './probecli'
import type { PlayCandidate } from './providers'
import type { VideoPosition } from './playerview'
import { checkAll, describeNotice, startReleaseTimer, type ReleaseNotice } from './releases'
import { backfillScores } from './scorebackfill'
import { runSeasonSplit, tmdbIdentify } from './seasonsplit'
import { buildPlayUrl } from './providers'
import bundledCatalog from './providers.json'
import type { Provider, ProviderCatalog } from '@shared/types'
import {
  defaultProviderOrder,
  mediaKey,
  outcomesForTitle,
  record,
  titleKey,
} from './outcomes'
import {
  kindTested,
  lastPlayedHere,
  WarmStarts,
  ownRows,
  playResult,
  resumeFirst,
  scanAwareOrder,
  titleResults,
  type AutomaticOrder,
  type ResultsAccess,
} from './providerscan'
import { ResultStore } from '@shared/store/results'
import { episodeOf, resultsFromScan } from '@shared/sourceresults'
import { createScanService } from './scanservice'
import { createWatchlistTester, episodeToTest } from './watchlisttester'
import { AUTO_TEST_TICK_MS, AutoTester } from './autotest'
import { isWatchedEnough, resumeAction, resumeKey, resumeOfferFor, WrittenPositions } from './resume'
import {
  readCache,
  refreshCatalog,
  resolveProviders,
  REFRESH_INTERVAL_MS,
  type CachedCatalog,
} from './catalog'
import { fileCatalogStore } from './catalogcache'
import { oauthClient } from '@shared/sync/credentials'
import { throttle } from '@shared/sync/throttle'
import { SyncService } from './syncservice'
import { TokenStore } from './synctokens'
import { airedEpisode, localMidnight, notOutYet } from '@shared/aired'
import { batchChanges } from '@shared/store/changebatch'

const dirname = fileURLToPath(new URL('.', import.meta.url))

/**
 * The compiled-in provider list — the floor under everything.
 *
 * Same document shape as the fetched list on purpose, so both go through one
 * validator and one resolver. The bundled copy is what guarantees the app can
 * play something offline, on first run, and when the managed list is
 * unreachable or has been published broken.
 */
const BUNDLED_PROVIDERS = (bundledCatalog as ProviderCatalog).providers

/**
 * The browser identity every frame and request carries (`identity.ts`). Set
 * before any window exists, because it is a fallback: it reaches every page's
 * `navigator.userAgent` as well as its requests, which a header handler alone
 * cannot.
 */
app.userAgentFallback = CHROME_UA

/**
 * Every session refuses what its pages have no use for (`permissions.ts`):
 * Electron would otherwise grant a source's page the microphone, the camera
 * and the clipboard without asking. Here rather than where each surface makes
 * its partition, so that no surface can be added without it. The app's own
 * session is created lazily after `ready`, so the comparison is safe.
 */
app.on('session-created', (created) => {
  restrictPermissions(created, created === session.defaultSession ? APP_PERMISSIONS : SOURCE_PERMISSIONS)
})

/**
 * Chromium flags. Must be set before `app.whenReady`.
 *
 * Providers stream HLS, so autoplay cannot require a gesture. The rest are the
 * GPU decode path: Nvidia's RTX Video Super Resolution only engages when video
 * frames are decoded on the GPU, so dropping these silently costs the feature
 * on the hardware that has it.
 */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('enable-accelerated-video-decode')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport')
// Media engagement heuristics otherwise re-block autoplay on sites the user
// has not "engaged with", which is every provider on a fresh install.
app.commandLine.appendSwitch(
  'disable-features',
  'PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies',
)

const store = new Store()

/**
 * One place that tells the renderer the document changed.
 *
 * This used to be a `send(EV.storeChanged, null)` after each write, and the
 * bug that pattern produces is always the same: the write that forgets it. A
 * film's progress bar spent a release invisible for exactly that reason —
 * `rememberPosition` wrote and said nothing, so the bar appeared only after a
 * restart. The store announces its own changes now, so forgetting is not an
 * option a caller has. Batched (`batchChanges`), naming the keys that changed,
 * so the renderer re-reads once per burst and only what it shows.
 */
store.subscribe(batchChanges((keys) => send(EV.storeChanged, keys)))

/**
 * Every test result this install has, its own and the other devices': the
 * history (`@shared/sourceresults`), in its own file beside the library.
 * Compact rather than indented: nobody repairs it by hand, and it syncs.
 */
const resultStore = new ResultStore(new NodePersistence(store.dir, join(store.dir, 'source-results.json'), false))

/** The results as everything that reads or records them reaches them. */
const testResults: ResultsAccess = {
  sources: () => ({ history: resultStore.all(), doc: store.read() }),
  device: () => ({ deviceId: store.read().deviceId, deviceKind: 'desktop' }),
  record: (results) => resultStore.record(results),
}


/**
 * Set once the app is ready, and null in a build with no OAuth client.
 *
 * Module scope rather than inside `whenReady` because the window lifecycle
 * handlers below reach for it — a sync on focus is one of the triggers.
 */
let sync: SyncService | null = null

/**
 * How long a local change settles before it is pushed.
 *
 * Long enough that a burst — marking a season watched, reordering providers —
 * becomes one sync rather than one per keystroke, and short enough that closing
 * the laptop a minute later still carries the change across.
 */
const SYNC_AFTER_WRITE_MS = 8_000

/**
 * Push the positions file at most this often while positions keep changing.
 *
 * The owner's number (2026-09-27): a position should reach the other device
 * within about ten seconds. It is a few kilobytes, so this costs next to
 * nothing; the library file keeps `SYNC_AFTER_WRITE_MS`. See `sync/positions.ts`.
 */
const POSITIONS_PUSH_MS = 10_000

/** True while sync is writing a merge result, rather than the user changing something. */
let applyingRemote = false

/**
 * The positions push: every change asks, at most one push per ten seconds
 * goes out, and a stop (pause, close, next episode, quit) sends one at once.
 */
const pushPositions = throttle(() => void sync?.positions(), POSITIONS_PUSH_MS)

/**
 * Push the test history at most this often while this device keeps
 * measuring. Nothing waits on another device's results, and the file is the
 * largest of the three, so this is the calm pace: the background tester
 * measures a source a minute.
 */
const RESULTS_PUSH_MS = 2 * 60_000
const pushResults = throttle(() => void sync?.results(), RESULTS_PUSH_MS)
let mainWindow: BrowserWindow | null = null
let stopReleaseTimer: (() => void) | null = null
/** Cleared on quit so a pending refresh cannot outlive the app. */
let catalogTimer: ReturnType<typeof setInterval> | null = null

/**
 * The one player, or none.
 *
 * Singular now that playback is inline: a second video inside the same window
 * has nowhere to go, and the old map of windows keyed by URL existed only to
 * stop the same URL opening twice. Netflix has one player and so does this.
 */
let player: InlinePlayer | null = null

/**
 * The own-controls switch applies to what is playing, not only to the next
 * thing played: the shell is told as soon as the setting changes.
 */
let shellSettingsWas: string | null = null
store.subscribe((key) => {
  if (key !== 'settings') return
  const { ownControls, subtitleLanguage } = store.read().settings
  const now = `${ownControls}:${subtitleLanguage}`
  if (now === shellSettingsWas) return
  shellSettingsWas = now
  player?.refreshConfig()
})

const getMainWindow = (): BrowserWindow | null =>
  mainWindow && !mainWindow.isDestroyed() ? mainWindow : null

/**
 * Base URL of the loopback renderer server, or null in dev where Vite serves.
 * Held here so re-creating the window on `activate` reuses the same server.
 */
let rendererBaseUrl: string | null = null
/** The preview cache's files; null until it has been opened, and on a probe run. */
let segmentStore: SegmentStore | null = null

async function createMainWindow(): Promise<void> {
  if (!process.env.ELECTRON_RENDERER_URL) {
    // Loopback HTTP rather than file:// — YouTube refuses to embed into any
    // non-http(s) origin, which would break every trailer in a packaged build.
    rendererBaseUrl ??= await startRendererServer(join(dirname, '../renderer'))
  }
  mainWindow = createAppWindow(dirname, store.dir, rendererBaseUrl)
  if (rendererBaseUrl) allowStreamPreviews(mainWindow, dirname, rendererBaseUrl)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * Casting to a television.
 *
 * Process-wide and created once, because it owns a proxy's lifetime and a TLS
 * session — a second instance would each believe it owned them, and stopping a
 * cast from one would leave the other reporting a session that is gone.
 */
const cast = createCastService()

/**
 * Trying every provider in the background, so the user does not have to.
 *
 * Constructed here beside `cast` and for the same reason: it owns hidden
 * browser windows, and exactly one place should decide when those exist. The
 * provider list is read per run rather than captured, so a scan started after
 * the user switches a source on includes it.
 */
const scan = createScanService({
  providers: enabledProviders,
  /**
   * Overridable so the trade can be *measured* rather than argued about.
   *
   * Raising it makes a scan finish sooner and risks measuring the user's
   * bandwidth instead of the providers — a starved player produces no media
   * and scores `dead`, which is the one verdict that costs a working source.
   * `WTA_SCAN_CONCURRENCY=6` next to a run at the default is how that claim
   * gets checked against real providers instead of reasoning.
   */
  concurrency: Number(process.env.WTA_SCAN_CONCURRENCY) || undefined,
  // The bare shell: a test measures the source, not v2's controls over it.
  frameUrl: (providerUrl) =>
    rendererBaseUrl ? playerShellUrl(rendererBaseUrl, providerUrl, { bare: true }) : providerUrl,
  onStream: noteScanStream,
  onProgress: (progress) => {
    send(EV.providerScan, progress)
    // The player chrome is a separate document with its own preload, so the
    // app window's `send` does not reach it. Both surfaces can start a scan
    // and both draw its dots, so both have to be told.
    player?.notifyChrome(EV.providerScan, progress)
  },
})

/**
 * Testing the watchlist's sources in the background, one a minute, so the
 * answer is ready before the user asks. See `watchlisttester.ts` for the rules
 * it keeps — above all, never while the user is watching or scanning by hand.
 */
const watchlistTester = createWatchlistTester({
  watchlist: () => store.read().watchlist,
  history: () => store.read().history,
  scans: () => ownRows(testResults.sources(), 'desktop'),
  // A film's watched fraction, as the Watchlist tab computes it for its order.
  filmPercent: (tmdbId) => {
    const key = resumeKey({ tmdbId, season: null, episode: null })
    const point = store.read().resumePoints.find((p) => p.key === key)
    return point && point.duration > 0 ? Math.min(100, Math.round((point.seconds / point.duration) * 100)) : null
  },
  providers: enabledProviders,
  lookUp: async (entry) => {
    try {
      const found = await tmdb.detail(entry.tmdbId, entry.type)
      const date = found.releaseDate ? localMidnight(found.releaseDate) : Number.NaN
      return {
        released: Number.isFinite(date) && date <= Date.now(),
        imdbId: found.imdbId,
        lastAired: found.lastEpisode,
      }
    } catch {
      return null
    }
  },
  probeOne: (key, subject, provider) => scan.probeOne(key, subject, provider),
  pausedFor: () => (player ? 'playback' : scan.busy() ? 'scan' : null),
  save: (result, episode) => testResults.record(resultsFromScan(result, testResults.device(), episode)),
  onStatus: (status) => send(EV.watchlistTest, status),
  // Two minutes after launch: start-up, the catalogue refresh and the release
  // sweep all want the network first.
  startDelayMs: 2 * 60_000,
})

/**
 * Whether the film playing is buffering: playing, and its time did not move
 * between the last two readings (2.5 s apart). The gentle automatic test
 * starts nothing while it is.
 */
let lastFilmReading: { seconds: number; paused: boolean } | null = null
let filmBuffering = false
function noteFilmReading(position: VideoPosition): void {
  filmBuffering = lastFilmReading !== null && !position.paused && position.seconds <= lastFilmReading.seconds
  lastFilmReading = { seconds: position.seconds, paused: position.paused }
}

/**
 * Every source of a title, tested by itself: ten minutes after it is added to
 * the watchlist, or while it is watched for the first time (`autotest.ts`).
 * Filed like a test by hand.
 */
const autoTester = new AutoTester({
  watchlist: () => store.read().watchlist,
  tested: (key) => kindTested(testResults.sources(), 'desktop', key, enabledProviders().map((p) => p.id)),
  playing: () => (player && !player.held() && !onTv ? { tmdbId: player.context.tmdbId } : null),
  busy: () => scan.busy(),
  log: (line) => console.log(line),
  run: async (entry, mode) => {
    const facts = await tmdb.detail(entry.tmdbId, entry.type).catch(() => null)
    // Offline, or TMDB is down: every source would read red for days.
    if (facts === null || notOutYet(facts.releaseDate, Date.now())) return
    const watching = mode === 'watching' && player?.context.tmdbId === entry.tmdbId ? player.context : null
    const wanted =
      watching && watching.season !== null && watching.episode !== null
        ? { season: watching.season, episode: watching.episode }
        : episodeToTest(entry, facts.lastEpisode)
    const target = wanted && airedEpisode(wanted, facts.lastEpisode)
    const key = titleKey(entry)
    const result = await scan.run(
      key,
      {
        imdbId: facts.imdbId ?? entry.imdbId ?? '',
        tmdbId: entry.tmdbId,
        type: entry.type,
        season: target?.season,
        episode: target?.episode,
        label: key,
        runtimeMinutes: null,
      },
      // Beside the viewer's film: two at a time, and none started while it
      // buffers. Otherwise the ordinary pool, held while anything plays.
      mode === 'watching'
        ? { concurrency: 2, hold: () => filmBuffering }
        : { hold: () => player !== null },
    )
    testResults.record(resultsFromScan(result, testResults.device(), target))
    cacheAfterTest(entry, target)
  },
})

/*
 * A title added to the watchlist should be tested soon, not at the tester's
 * next idle check ten minutes away. Keyed on the watchlist's ids rather than
 * on any change: the store changes constantly — a position every thirty
 * seconds while playing — and poking on each would make the tester run far
 * more often than once a minute.
 */
let watchlistIds = ''
store.subscribe(() => {
  // Listed only: ticking an episode of an unlisted title changes nothing
  // the tester works on, and listing one is exactly a new addition.
  const ids = store
    .read()
    .watchlist.filter(isListed)
    .map((entry) => entry.id)
    .sort()
    .join(',')
  if (ids === watchlistIds) return
  watchlistIds = ids
  watchlistTester.poke()
  autoTester.tick()
})

/**
 * A television that stops on its own gives the sound back.
 *
 * `setAudioMuted` is the one piece of cast state that lives outside the cast
 * service, so nothing else would ever undo it — and a user who ended the cast
 * from the TV's own remote would be left with a permanently silent player and
 * no control in this app that explains it.
 */
cast.onSessionEnded(() => setOnTv(false))

/* ── The television, and auto-next ────────────────────────────────────── */

/**
 * Whether the picture is on the television.
 *
 * While it is, the television's position is the one that counts: the local
 * copy keeps playing muted (the next episode's stream can only be fetched
 * through it), but the viewer is watching the television, which they may
 * have paused or skipped on with its own remote.
 */
let onTv = false
/** The television's last reading, while `onTv`. */
let tvPosition: VideoPosition | null = null
let tvPlaying = false
let tvWatch: ReturnType<typeof setInterval> | null = null
/**
 * True from an episode step until the next beam lands. Until then the
 * television is still reporting the episode it had — finished, as often as
 * not — and those readings must be filed under neither episode, nor start a
 * countdown for the one being stepped to.
 */
let tvStale = false

/** How often the television is asked where it is: the same five seconds as the local save. */
const TV_WATCH_MS = 5_000

/** Set once the IPC is up; auto-next beams through the Cast button's own path. */
let ipc: IpcHandles | null = null

function setOnTv(next: boolean): void {
  onTv = next
  player?.setMuted(next)
  tvPosition = null
  tvPlaying = false
  tvStale = false
  if (tvWatch !== null) clearInterval(tvWatch)
  tvWatch = next ? setInterval(() => void watchTv(), TV_WATCH_MS) : null
}

/**
 * Record where the television is, and notice when it finishes.
 *
 * Until 1.9.8 a cast recorded the muted local copy's position, which knows
 * nothing of a pause or a skip on the television's own remote.
 */
async function watchTv(): Promise<void> {
  if (!player || !onTv || tvStale) return
  const context = player.context
  const status = await cast.status().catch(() => null)
  if (status === null || !status.connected || tvStale || player?.context !== context) return

  // A finished receiver often reports no media at all; its end is the last
  // length it did report.
  const duration = status.duration > 0 ? status.duration : (tvPosition?.duration ?? 0)
  const reading: VideoPosition = {
    seconds: status.finished ? duration : status.seconds,
    duration,
    ended: status.finished,
    paused: !status.playing,
  }
  if (reading.duration <= 0) return
  tvPosition = reading
  rememberPosition(context, reading)

  // Paused on the television: the other device may pick up from here.
  if (tvPlaying && !status.playing && !status.finished) pushPositions.now()
  tvPlaying = status.playing

  const place = placeOf(context)
  if (place !== null) upNext.observe(place, reading, context.runtimeMinutes, true)
}

/** Where auto-next counts from, or null for a film or an unnumbered episode. */
function placeOf(context: PlayRequest): UpNextPlace | null {
  if (context.type !== 'tv' || context.season === null || context.episode === null) return null
  return { tmdbId: context.tmdbId, season: context.season, episode: context.episode }
}

/**
 * How long the television is waited on for the next episode's stream.
 *
 * The same budget the remote's own next-episode button gives it: this window
 * loads the episode, the provider fetches the stream, and only then can it
 * be sent. Some providers fetch nothing until pressed, which `beam` does.
 */
const TV_NEXT_WAIT_MS = 25_000

async function beamNextToTv(): Promise<void> {
  // Nothing is captured for a beat after a navigation; asking at once only
  // burns the first attempt.
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  const deadline = Date.now() + TV_NEXT_WAIT_MS
  while (Date.now() < deadline && player && ipc) {
    const result = await ipc.beam()
    if (result.ok) return
    if (result.final) break
    await new Promise((resolve) => setTimeout(resolve, 1_200))
  }
  console.warn('[upnext] the next episode could not be sent to the television')
}

/** The aired episode after `place`, or null; for auto-next and the credits' "Next episode". */
async function nextEpisodeAfter(place: UpNextPlace): Promise<NextEpisode | null> {
  const detail = await tmdb.detail(place.tmdbId, 'tv').catch(() => null)
  if (detail === null) return null
  return nextAiredEpisode(place, detail.seasonCount, (n) => tmdb.season(place.tmdbId, n))
}

const upNext = new UpNextController({
  enabled: () => store.read().settings.autoNext,
  resolve: nextEpisodeAfter,
  advance: (next, toTv) => {
    console.log(`[upnext] playing S${next.season}E${next.episode}${toTv ? ' on the television' : ''}`)
    navigatePlayer(next.season, next.episode)
    if (toTv) void beamNextToTv()
  },
})

/**
 * Start playing, inline.
 *
 * The video is a native view layered over the app window, so it needs a
 * rectangle before it can exist. The renderer has not drawn its player chrome
 * yet at this point, so the first bounds are a full-window placeholder and the
 * renderer corrects them the moment its slot is measured. Waiting for the
 * renderer instead would mean a visible gap between hitting play and anything
 * appearing.
 */
function openPlayer(
  url: string,
  title: string,
  context: PlayRequest,
  candidates: PlayCandidate[] = [],
  options: { held?: boolean } = {},
): void {
  const win = getMainWindow()
  if (!win) return

  // One player. Starting a second replaces the first rather than stacking two
  // videos in one window, which has no meaning.
  closePlayer(false)
  upNext.reset()

  const [width = 1280, height = 800] = win.getContentSize()

  /*
   * The previous title's manifest is still the newest thing in the capture
   * buffer for the first seconds of this one, so casting now would put the
   * wrong film on the television while the screen showed the right one.
   */
  cast.forget()

  /*
   * The player these callbacks belong to, set the moment it exists. Not the
   * module's `player`, which is whichever player is current when a callback
   * runs: a report from this one can arrive after it has been replaced, and
   * was then filed under the title that replaced it.
   */
  let self: InlinePlayer | null = null
  /** What this player is showing now; it moves with every episode step. */
  const showing = (): PlayRequest => self?.context ?? context
  /** Still the player on screen, so its readings are what the viewer is watching. */
  const isCurrent = (): boolean => self !== null && player === self

  self = createInlinePlayer({
    window: win,
    dirname,
    url,
    /*
      The floating controls: Vite in dev, the loopback server in a packaged
      build — the same split the app window itself uses. It was previously
      only wired to the server, so `npm run dev` had no player chrome at all
      and every change to it had to be checked in a packaged build.
    */
    chromeUrl: chromeDocumentUrl(),
    /*
      The chrome's Back button shrinks the player into the app's corner, like
      YouTube's (the owner, 2026-09-27); the mini player's ✕ is what stops it.
      A request rather than something the view does itself, because the app
      window has to be told and has to make room.
    */
    onBack: () => setPlayerMini(true),
    /*
      Resume carried over from the detail view's preview (the owner,
      2026-09-28): held out of sight until its film is where the preview is.
      See `shared/carryover.ts`. The page owns the preview, so it hears the
      keys meant for it and when to let it go.
    */
    held: options.held === true,
    onHeldAction: (action) => send(EV.carryAction, action),
    onReleased: () => send(EV.carryReleased, null),
    ownControls: () => store.read().settings.ownControls,
    subtitleLanguage: () => store.read().settings.subtitleLanguage,
    // The mini player hears about a failing source too, since the chrome
    // that normally shows the offer is out of sight while it is small.
    onSuggest: (suggestion) => send(EV.playerSuggestion, suggestion),
    onPlayingChange: (playing) => {
      if (!isCurrent()) return
      videoPlaying = playing
      if (playing) notePlayerPlaylist()
      if (playing) autoTester.tick()
      send(EV.playerPaused, !playing)
      // A pause is a stop the other device may pick up from: write the exact
      // place and send it now, rather than at the next five-second sample.
      if (!playing && player && !onTv) {
        rememberPosition(player.context, player.position())
        pushPositions.now()
      }
    },
    /*
      The skip buttons, and the switch that governs them.

      `enabled` is read per reading rather than captured, so turning the
      setting off stops the lookups immediately instead of at the next
      restart — it decides whether two third parties are told what is
      playing, and a privacy switch that lags is not one. Not while the
      television has the film: the button would skip the picture here.
    */
    skipIntro: {
      enabled: () => store.read().settings.skipIntro && !onTv,
      animeId: async (tmdbId, season) =>
        (await isAnimatedTitle(tmdbId)) ? malIdFor(store.dir, tmdbId, season) : null,
      hasNext: async (context) => {
        const place = placeOf(context)
        return place !== null && (await nextEpisodeAfter(place)) !== null
      },
      playNext: () => {
        const place = player ? placeOf(player.context) : null
        if (place === null) return
        void nextEpisodeAfter(place).then((next) => {
          // Only if the viewer is still where the button was pressed.
          const now = player ? placeOf(player.context) : null
          if (next === null || now?.season !== place.season || now.episode !== place.episode) return
          console.log(`[skip] next episode: S${next.season}E${next.episode}`)
          navigatePlayer(next.season, next.episode)
        })
      },
    },
    /*
      Never let the countdown switch away from a source "Test all sources"
      found working for this title. Read at the moment of the offer, from the
      same results the source pickers show.
    */
    testedWorking: (providerId) =>
      // The episode showing now: results are per episode, and this view
      // outlives the one it opened on.
      titleResults(testResults.sources(), titleKey(showing()), episodeOf(showing()), 'desktop').scan?.verdicts[
        providerId
      ] === 'stream',
    // Where this was left last time; the view only acts on it if the provider
    // has not restored the position itself.
    resumeAt: savedPositionFor(context),
    /**
     * Frame the provider instead of navigating to it.
     *
     * Falls back to the bare URL when the renderer server has not started —
     * only true in a dev build served by Vite, where the provider is loaded
     * directly and a host enforcing embedding will refuse it. Worth knowing if
     * a provider works packaged and not in `npm run dev`.
     */
    frameUrl: (providerUrl) =>
      rendererBaseUrl ? playerShellUrl(rendererBaseUrl, providerUrl) : providerUrl,
    context,
    candidates,
    bounds: { x: 0, y: 0, width, height },
    reportOutcome: (providerId, outcome) =>
      // What it shows now rather than the captured `context`: moving to
      // another episode reuses this view, and an outcome recorded against the
      // episode it opened on would credit the wrong key.
      recordOutcome(showing(), providerId, outcome),
    // A test result from watching, filed under the episode playing, as above.
    reportResult: (providerId, seen) => {
      const playing = showing()
      const where = { device: testResults.device(), titleKey: titleKey(playing), episode: episodeOf(playing), providerId }
      testResults.record([playResult(where, 'play', warmStarts.measure(where.titleKey, providerId, seen))])
    },
    /**
     * Write the position down as it goes, not only when the player closes.
     *
     * Deliberately just the position: `settleProgress` also decides "watched"
     * and consumes the elapsed-time counter, neither of which belongs in a
     * periodic sample. Reaching the end while still playing is caught on exit.
     */
    onPosition: (position) => {
      // While casting, the muted local copy is not what anyone is watching.
      if (onTv || !isCurrent()) return
      rememberPosition(showing(), position)
    },
    onPositionRead: (position) => {
      if (!isCurrent()) return
      noteFilmReading(position)
      if (onTv) return
      const current = showing()
      const place = placeOf(current)
      if (place !== null) upNext.observe(place, position, current.runtimeMinutes, false)
    },
    /**
     * Save the place being left, and hand back the place to pick up at.
     *
     * Note what this does *not* do: settle. Every reason that reaches here is a
     * navigation **within the same title** — a provider switch, a reload, a
     * fallback after a crash — and `'episode'` is already settled by
     * `navigatePlayer` before it rewrites the context. It used to call
     * `leaveCurrent()`, which decided "watched" and drained the elapsed-time
     * counter on each of them. That cost real progress on exactly the providers
     * that need the counter most: where no `<video>` is reachable, elapsed time
     * is the only evidence there is, and switching source three times split it
     * into three stretches, none long enough to count. "Watched" is decided
     * when the player is actually left — `closePlayer` and `navigatePlayer`
     * both settle — so deferring it here loses nothing.
     */
    onNavigate: (reason) => {
      const current = showing()
      if (reason !== 'episode') rememberPosition(current, self?.position() ?? null)
      return savedPositionFor(current)
    },
    /*
     * A new source means the previous one's captures are stale, and for a few
     * seconds they are also the *newest* thing in the buffer — so a cast
     * started right after a switch would send the old provider's stream.
     */
    onProviderChanged: () => {
      cast.forget()
      sendPlayerState()
    },
  })
  player = self

  /*
   * Watch this embed's network for the stream, which is the only way the app
   * can learn its address: the video is resolved inside a cross-origin frame.
   * Read immediately — `webContents.session` throws once the view is destroyed.
   */
  cast.watch(player.session)

  // Previews stop while something plays; see `EV.playbackActive`.
  send(EV.playbackActive, true)
  sendPlayerState()
}

/**
 * Decide whether what just played counts as watched, and say so if it does.
 *
 * Called when leaving an episode — closing the player, or stepping to another
 * one — never when starting it. Opening the player used to be what counted,
 * which meant loading a title and backing straight out marked it watched, and
 * browsing through a few of them ticked off the lot.
 *
 * The bar is *the end*, not a fraction — see `isWatchedEnough`. Reaching the
 * credits is what finishing something means, and it is what the position read
 * off the provider's own `<video>` can actually answer.
 *
 * When no video element is reachable and TMDB has no runtime either, a flat
 * floor stands in. Fifteen minutes is longer than any amount of browsing and
 * shorter than most of what anyone opens on purpose.
 */
const WATCHED_FALLBACK_MS = 15 * 60_000

function settleProgress(
  context: PlayRequest,
  playedMs: number,
  position: VideoPosition | null,
): void {
  rememberPosition(context, position)

  const watched = isWatchedEnough({
    seconds: position?.seconds ?? null,
    duration: position?.duration ?? null,
    playedMs,
    runtimeMinutes: context.runtimeMinutes,
    fallbackMs: WATCHED_FALLBACK_MS,
    ended: position?.ended ?? false,
  })
  /**
   * The measurement goes out whatever the verdict.
   *
   * History wants to record eleven minutes of something abandoned just as much
   * as a finished episode; an event that only fired on success could not say
   * so, which is why this is not folded into `episodeWatched` below.
   */
  send(EV.playbackSettled, {
    tmdbId: context.tmdbId,
    type: context.type,
    season: context.season,
    episode: context.episode,
    playedMs,
    seconds: position?.seconds ?? null,
    duration: position?.duration ?? null,
    watched,
  })

  if (!watched) return

  send(EV.episodeWatched, {
    tmdbId: context.tmdbId,
    type: context.type,
    season: context.season,
    episode: context.episode,
  })
}

/** What this device last wrote per title; see `WrittenPositions`. */
const writtenPositions = new WrittenPositions()

/**
 * Write down where this was left, forget it if it is finished, or leave the
 * memory alone when this reading has nothing to say.
 *
 * That third case is the one that was missing, and its absence is what made
 * resuming flaky across providers: a provider whose player exposes no readable
 * `<video>` produced no reading, no reading was treated as "forget", and so
 * switching to it deleted the position a working provider had stored. See
 * `resumeAction`.
 */
function rememberPosition(context: PlayRequest, position: VideoPosition | null): void {
  const key = resumeKey(context)
  const points = store.collection('resumePoints')

  const action = resumeAction(position, context.runtimeMinutes)
  if (action === 'keep') return
  if (action === 'forget') {
    points.remove(key)
    writtenPositions.forget(key)
    return
  }
  if (!writtenPositions.isChange(key, position!.seconds, position!.duration)) return

  points.put({
    key,
    tmdbId: context.tmdbId,
    seconds: position!.seconds,
    duration: position!.duration,
  })
}

/**
 * The detail view's stream preview for one episode or film, or null.
 *
 * The rule is `planPreview`'s: this device's own fresh test results, the
 * enabled sources in Automatic's order for the ties, else the source of a
 * window kept for this episode. Without the local server
 * (a dev build on Vite) there is no shell to preview in, so none.
 */
async function previewPlanFor(req: PlayRequest): Promise<PreviewPlan | null> {
  if (!rendererBaseUrl) return null
  // Straight after the player: its window may still be arriving, and is the one to start from.
  await segmentStore?.settled(titleKey(req), PLAN_WAITS_FOR_SAVE_MS)
  const doc = store.read()
  const key = titleKey(req)
  const resume = resumeOfferFor(doc.resumePoints, req)
  // The window kept for this episode, from whichever source it came: it plays
  // whatever source the preview then takes over from.
  const keptSource = segmentStore?.keptSource(episodeWhere(req), resume?.seconds ?? 0) ?? null
  const choice = planPreview({
    providers: automaticOrderFor(req).providers,
    scan: titleResults(testResults.sources(), key, episodeOf(req), 'desktop').scan,
    req,
    resume,
    keptSource,
  })
  if (choice === null) return null
  const kept = keptSource === null ? null : (segmentStore?.find(windowWhere(req, keptSource), choice.startSeconds) ?? null)
  return {
    surface: 'webview',
    src: playerShellUrl(rendererBaseUrl, choice.url, { preview: { startSeconds: choice.startSeconds } }),
    providerId: choice.provider.id,
    providerName: choice.provider.name,
    startSeconds: choice.startSeconds,
    cached: kept,
  }
}

/** How long a preview's plan waits for the window the player is saving; the source would take longer to start. */
const PLAN_WAITS_FOR_SAVE_MS = 5_000

/** The source and episode whose playlist was last noted, so a pause and play does not note it again. */
let notedPlaylistFor: string | null = null

/**
 * The player's film is playing: note its playlist for the preview cache
 * while it is still among the newest requests. A source whose segments have
 * no file extension floods the capture within a minute.
 */
function notePlayerPlaylist(): void {
  const providerId = player?.currentProviderId() ?? null
  if (!player || providerId === null || segmentStore === null || onTv) return
  const where = windowWhere(player.context, providerId)
  const key = `${where.titleKey}|${where.season}|${where.episode}|${providerId}`
  if (key === notedPlaylistFor) return
  notedPlaylistFor = key
  void segmentStore.notePlaylist(where, cast.candidates(), player.position()?.duration ?? 0, player.context.runtimeMinutes ?? null)
}

/** Which window of the preview cache a request and source are. */
/** Which episode a kept window is of. */
function episodeWhere(req: PlayRequest): Omit<WindowWhere, 'providerId'> {
  const episode = episodeOf(req)
  return { titleKey: titleKey(req), season: episode?.season ?? null, episode: episode?.episode ?? null }
}

function windowWhere(req: PlayRequest, providerId: string): WindowWhere {
  return { ...episodeWhere(req), providerId }
}

/** What a kept window is of, in words, for the Settings line (`SaveNames`). */
function saveNames(req: PlayRequest, providerId: string): SaveNames {
  return {
    title: req.title || 'a tested title',
    source: allProviders().find((p) => p.id === providerId)?.name ?? providerId,
  }
}

/**
 * Keep a window of the stream a page was playing, from where it stopped: the
 * player on closing, the preview on being left. In the background, one save
 * at a time; nothing waits for it.
 */
function keepStreamWindow(
  req: PlayRequest,
  providerId: string | null,
  position: { seconds: number; duration: number } | null,
  requests: readonly { url: string; headers: Record<string, string> }[],
): void {
  if (segmentStore === null || providerId === null || position === null || requests.length === 0) return
  void segmentStore.save(windowWhere(req, providerId), requests, position, req.runtimeMinutes ?? null, saveNames(req, providerId))
}

/** Starts of sources on titles on this device: a warm one files no start time (`WarmStarts`). */
const warmStarts = new WarmStarts()

/**
 * The playlists each source's page asked for in the scan under way, by title
 * then source: what `cacheAfterTest` saves the preview's window from. In
 * memory only, and dropped once the scan is filed.
 */
const scanStreams = new Map<string, Map<string, CapturedRequest[]>>()

/** Titles held at most: the background tester's one-source probes are never filed through `cacheAfterTest`. */
const SCAN_STREAM_TITLES = 4

function noteScanStream(key: string, providerId: string, requests: CapturedRequest[]): void {
  const title = scanStreams.get(key) ?? new Map<string, CapturedRequest[]>()
  title.set(providerId, requests)
  scanStreams.delete(key)
  scanStreams.set(key, title)
  // Oldest first out; a Map iterates in insertion order.
  while (scanStreams.size > SCAN_STREAM_TITLES) scanStreams.delete(scanStreams.keys().next().value!)
}

/**
 * After a test, keep the preview's first seconds (scope agreed 2026-09-29):
 * a title that was tested and never played then previews at once, as one
 * left from the player does. The window is the one the preview would play —
 * its source, from the place it would start — and only if none is kept yet.
 */
function cacheAfterTest(ref: TitleRef, episode: { season: number; episode: number } | null): void {
  const key = titleKey(ref)
  const streams = scanStreams.get(key)
  scanStreams.delete(key)
  if (!streams || segmentStore === null) return
  const cache = segmentStore
  void (async () => {
    const facts = await tmdb.detail(ref.tmdbId, ref.type).catch(() => null)
    const req: PlayRequest = {
      tmdbId: ref.tmdbId,
      imdbId: ref.imdbId,
      type: ref.type,
      title: facts?.title ?? '',
      season: episode?.season ?? null,
      episode: episode?.episode ?? null,
      providerId: null,
      runtimeMinutes: facts?.runtime ?? null,
    }
    const choice = choosePreview({
      providers: automaticOrderFor(req).providers,
      scan: titleResults(testResults.sources(), key, episodeOf(req), 'desktop').scan,
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
    await cache.save(
      windowWhere(req, choice.provider.id),
      requests,
      { seconds: choice.startSeconds, duration: 0 },
      req.runtimeMinutes,
      saveNames(req, choice.provider.id),
    )
  })()
}

/**
 * The preview settles like a play (the owner, 2026-09-29: watching counts
 * wherever it happened): the place, the time played into the history, and
 * "watched" if it reached the credits. See `PreviewWatch`.
 */
function keepPreviewPosition(
  req: PlayRequest,
  seconds: number,
  duration: number,
  cacheSource: string | null,
  playedMs: number,
): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return
  settleProgress(req, playedMs, { seconds, duration: Number.isFinite(duration) ? duration : 0, ended: false, paused: false })
  pushPositions.now()
  if (cacheSource !== null) keepStreamWindow(req, cacheSource, { seconds, duration }, previewRequests())
}

/** Where this episode or film was left, in seconds. Zero if it was not. */
function savedPositionFor(context: PlayRequest): number {
  const key = resumeKey(context)
  return store.read().resumePoints.find((point) => point.key === key)?.seconds ?? 0
}

/**
 * Settle whatever is playing before leaving it.
 *
 * Order matters: the position has to be read while the view is still alive, so
 * this runs before any teardown or before the context is rewritten for another
 * episode.
 */
function leaveCurrent(): void {
  if (!player) return
  // While casting, the television's place, not the muted copy's.
  const position = onTv ? tvPosition : player.position()
  settleProgress(player.context, player.takeProgressMs(), position)
  // Leaving is when the other device most wants the place: not in ten seconds.
  pushPositions.now()
}

/** Tell the app's chrome what is playing, so it can label itself. */
function sendPlayerState(): void {
  if (!player) {
    send(EV.playerState, null)
    return
  }
  const current = player.candidates[player.candidateIndex]
  send(EV.playerState, {
    title: player.context.title,
    type: player.context.type,
    tmdbId: player.context.tmdbId,
    imdbId: player.context.imdbId,
    season: player.context.season,
    episode: player.context.episode,
    providerId: current?.provider.id ?? null,
    providerName: current?.provider.name ?? null,
    providers: player.candidates.map((c) => ({ id: c.provider.id, name: c.provider.name })),
  })
}

/**
 * Whether the player is shrunk into the app's corner.
 *
 * Kept here rather than in the renderer, because the Back that starts it is
 * pressed in the player's own chrome, which only reaches main.
 */
let playerMini = false

/** Whether the provider's video is moving, per Chromium's media events. */
let videoPlaying = false

function setPlayerMini(mini: boolean): void {
  if (!player || playerMini === mini) return
  playerMini = mini
  player.setMini(mini)
  send(EV.playerMini, mini)
  // The button's first state. Events only report changes, and the mini
  // player did not exist to hear the last one.
  send(EV.playerPaused, !videoPlaying)
}

/**
 * Stop playing and put the app back.
 *
 * `announce` is false only when a new player is about to replace this one —
 * telling the renderer playback stopped and then immediately that it started
 * makes every preview in the app restart for one frame.
 */
function closePlayer(announce = true): void {
  if (!player) return
  // Closed while still held: the page's preview is standing in for a player
  // that will now never show, and must stop.
  if (player.held()) send(EV.carryReleased, null)

  // What the player was fetching, read before it goes: the preview cache keeps
  // a window of it from here. Not while casting: the picture here was a muted
  // copy, and the television's place is not this stream's.
  if (!onTv) keepStreamWindow(player.context, player.currentProviderId(), player.position(), cast.candidates())
  leaveCurrent()
  upNext.reset()
  player.destroy()
  player = null
  videoPlaying = false
  // Whatever plays next opens full size, even when it replaces a mini player:
  // pressing Play is asking to watch.
  if (playerMini) {
    playerMini = false
    send(EV.playerMini, false)
  }
  // The user stopped watching; the tester may take its turn again.
  watchlistTester.poke()

  if (announce) {
    send(EV.playbackActive, false)
    send(EV.playerState, null)
    // An offer to switch source is meaningless once there is no player; left
    // standing it would be the only thing on screen from a torn-down session.
  }
}

/**
 * Move the player to another episode of the same title.
 *
 * The URL is rebuilt from the provider template rather than by editing the
 * current URL in place — which is what the original's preload did, using three
 * fallback heuristics to guess which path segments meant season and episode.
 */
function navigatePlayer(season: number, episode: number): void {
  if (!player) return

  const next: PlayRequest = { ...player.context, season, episode }
  // Keep the provider already loaded: changing episode should not silently
  // change source under the user. Behind it, the same Automatic order a fresh
  // play gets (tests, outcomes, favourites, the user's order). This passed the
  // enabled list in raw order until 2026-09-27, so after an episode step the
  // fallback walked into sources the tests had just called dead. The phone's
  // `playerGoTo` always used the Automatic order.
  const selection = buildPlayUrl(
    automaticOrderFor(next).providers,
    { ...next, providerId: player.currentProviderId() ?? next.providerId },
    // The episode being stepped to has its own stored position — this is how
    // going back to one you abandoned half-way lands in the right place.
    resumeOfferFor(store.read().resumePoints, next),
  )
  if (!selection) return

  // Settle the episode being left before the context is rewritten, or its time
  // would be credited to the one being moved to. After the check above, as on
  // the phone: a step that cannot happen leaves the episode playing unsettled.
  leaveCurrent()
  // A new episode: its end is a new end, and any countdown is for the old one.
  upNext.reset()
  tvPosition = null
  if (onTv) tvStale = true

  /*
   * The episode being left is still the newest thing in the capture buffer, and
   * stays so for the first seconds of the new one. Without this, the remote's
   * next-episode button would put the *previous* episode back on the
   * television while this window showed the right one — the same trap as
   * switching provider, which already clears it, and as opening a player,
   * which already clears it.
   */
  cast.forget()
  player.goToEpisode({ context: next, candidates: selection.candidates, url: selection.url })

  sendPlayerState()
}

/**
 * The catalogue currently in force.
 *
 * Held in memory because it is read on every play and every provider-panel
 * render, and re-reading the cache file for each would be a filesystem hit on
 * the play path. Refreshed in the background; null until the first read.
 */
let cachedCatalog: CachedCatalog | null = null

/** Every provider the app knows about, whether or not the user has enabled it. */
function allProviders(): Provider[] {
  const { customProviders } = store.read()
  return resolveProviders(BUNDLED_PROVIDERS, cachedCatalog, customProviders)
}

/**
 * The user's enabled providers, in their configured order.
 *
 * If none of the stored ids still exist — which happens when the catalogue
 * drops entries, and eight were dropped at once — this falls back to the core
 * tier rather than returning an empty list. An empty list is indistinguishable
 * from "the user turned everything off", and would fail every play on an
 * install that worked the day before.
 */
function enabledProviders(): Provider[] {
  const { activeProviderIds } = store.read()
  const all = allProviders()
  const enabled = activeProviderIds
    .map((id) => all.find((p) => p.id === id))
    .filter((p): p is Provider => !!p)

  if (enabled.length > 0) return enabled
  return all.filter((p) => p.tier === 'core')
}

/**
 * Order the enabled providers for one request.
 *
 * Every rule is the user's own — their drag order, narrowed to sources known to
 * have played this title, with favourites in front — plus whatever a recent
 * scan measured, and then the source the title was last watched on moved to
 * the front while it is still green. The reasoning is in `scanAwareOrder` and
 * in `resumeFirst`.
 *
 * This is the half of the scan feature the user never sees. The dots tell them
 * which source to pick; this makes the *automatic* choice and every mid-episode
 * fallback use the same measurement, so "Automatic" stops walking into sources
 * that were measured dead a minute ago.
 */
function automaticOrderFor(req: TitleRef & { season?: number | null; episode?: number | null }): AutomaticOrder {
  const { streamOutcomes, favouriteProviderIds, settings } = store.read()
  const key = titleKey(req)
  const outcomes = outcomesForTitle(streamOutcomes, key)
  // The episode's own results where there are any: see `titleResults`.
  const { scan } = titleResults(testResults.sources(), key, episodeOf(req), 'desktop')
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

/**
 * The user's provider order, seeded from the catalogue the first time it is
 * needed.
 *
 * Seeded here rather than in the renderer so there is exactly one definition of
 * what "no order yet" means. Both processes read the order — main to pick a
 * source, the Providers panel to lay out the rows the user drags — and two
 * seeding sites would be two orders that agree until the catalogue changes.
 */
function providerOrder(): string[] {
  const stored = store.read().providerOrder
  if (stored.length > 0) return stored

  const seeded = defaultProviderOrder(allProviders())
  store.setPreference('providerOrder', seeded)
  return seeded
}

/** Write down what a playback attempt proved, for the next ranking to read. */
function recordOutcome(req: PlayRequest, providerId: string, outcome: 'stream' | 'failed'): void {
  const key = mediaKey(req)
  store
    .collection('streamOutcomes')
    .replaceAll(record(store.read().streamOutcomes, { providerId, mediaKey: key, outcome }))
}

/**
 * Whether TMDB calls this series animation.
 *
 * A gate on one thing only: whether it is worth downloading the 5.8 MB anime
 * id mapping to ask AniSkip. Over-inclusive by design — Western animation
 * passes, finds nothing in the mapping, and that costs one lookup — and it
 * answers false whenever TMDB cannot be reached, because the cost of a wrong
 * "no" is a missing button and the cost of a wrong "yes" is a large download.
 */
async function isAnimatedTitle(tmdbId: number): Promise<boolean> {
  try {
    const detail = await tmdb.detail(tmdbId, 'tv')
    return detail.genres.includes('Animation')
  } catch {
    return false
  }
}

/**
 * Where the floating player chrome is served from, or undefined if nowhere.
 *
 * Undefined is a supported answer and not an error: the player then runs with
 * no overlay, exactly as it did before the chrome existed.
 */
function chromeDocumentUrl(): string | undefined {
  const dev = process.env.ELECTRON_RENDERER_URL
  if (dev) return `${dev}/chrome.html`
  return rendererBaseUrl ? `${rendererBaseUrl}/chrome.html` : undefined
}

function send(channel: string, payload: unknown): void {
  const win = getMainWindow()
  if (win) win.webContents.send(channel, payload)
}

function announce(notices: ReleaseNotice[]): void {
  send(
    EV.releaseFound,
    notices.map((n) => ({ title: n.tracker.title, episode: n.episode })),
  )

  if (!Notification.isSupported()) return
  if (!store.read().settings.notificationsEnabled) return

  // One notification per series, not a burst — a weekly sweep can turn up
  // several at once and stacking six toasts is worse than saying so in one.
  if (notices.length === 1) {
    const only = notices[0]!
    show(only.tracker.title, describeNotice(only))
  } else if (notices.length > 1) {
    show(
      `${notices.length} series have new episodes`,
      notices
        .slice(0, 4)
        .map((n) => n.tracker.title)
        .join(', ') + (notices.length > 4 ? '…' : ''),
    )
  }
}

function show(title: string, body: string): void {
  const notification = new Notification({ title, body, urgency: 'normal' })
  notification.on('click', () => {
    const win = getMainWindow()
    if (!win) void createMainWindow()
    getMainWindow()?.focus()
    send(EV.navigate, 'releases')
  })
  notification.show()
}

async function checkReleases(): Promise<{ checked: number; found: number }> {
  const checked = store.read().trackers.length
  const notices = await checkAll(store)
  if (notices.length > 0) announce(notices)
  return { checked, found: notices.length }
}

/** Fire-and-forget wrapper for the menu and tray, which cannot await. */
function checkReleasesNow(): void {
  void checkReleases().catch((err) => console.error('[main] release check failed:', err))
}

/**
 * A second instance would fight this one over the same JSON document — except
 * in probe mode, which opens no windows and never writes to the store, and is
 * something you very much want to be able to run while the app is open.
 */
if (!isProbeRun(process.argv) && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getMainWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    } else {
      void createMainWindow()
    }
  })

  void app.whenReady().then(async () => {
    await store.load()
    await resultStore.load()
    try {
      const root = join(app.getPath('userData'), 'preview-cache')
      segmentStore = await createSegmentStore(await nodeCacheFiles(root, () => rendererBaseUrl))
      serveCacheFrom(root)
    } catch (error) {
      // The preview then simply starts from its source, as before the cache.
      console.log(`[cache] unavailable: ${String(error)}`)
    }

    // Before any window is created: providers reject Electron's own
    // User-Agent, so every request the app makes has to look like Chrome.
    applyBrowserIdentity(session.defaultSession)

    /**
     * Probe mode: measure the catalogue and quit, without ever showing a window.
     *
     * It runs here rather than in a separate Electron entry point because the
     * probe needs a real browser and this process already is one, with a build
     * that is known to work. A second entry point is a second bundling target
     * that would quietly drift from this one.
     */
    if (isProbeRun(process.argv)) {
      void probeAndQuit(BUNDLED_PROVIDERS, process.argv)
      return
    }

    // Seed the provider order before any window reads the store, so the
    // Providers panel opens on a sensible order rather than showing the raw
    // catalogue until the first play happens to seed it.
    providerOrder()

    /**
     * Sync, if this build has an OAuth client.
     *
     * The service reads and writes the *whole* document, tombstones included —
     * `store.read()` filters those out for readers, and a merge that cannot see
     * a deletion resurrects it on the next sync.
     */
    sync =
      oauthClient() === null
        ? null
        : new SyncService({
            positionsHost: {
              read: () => store.raw().resumePoints,
              adopt: (points) => {
                // Flagged like the library's write below, so taking the other
                // device's position does not schedule a push of it straight back.
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
                // Flagged so the write-triggered sync below can tell sync's own
                // write from the user's. Without it every sync that changed
                // anything scheduled another sync to look at its own result.
                applyingRemote = true
                try {
                  await store.replaceDocument(document)
                } finally {
                  applyingRemote = false
                }
              },
            },
            tokens: new TokenStore(),
            onStatus: (status) => send(EV.syncStatus, status),
          })
    await sync?.load()

    ipc = registerIpc({
      store,
      sync,
      getMainWindow,
      backgroundStatus: () => watchlistTester.status(),
      openPlayer,
      setPlayerBounds: (bounds) => player?.setBounds(bounds),
      closePlayer: () => closePlayer(),
      freshenPositions: async () => {
        await sync?.freshenPositions()
      },
      keepWaiting: () => player?.keepWaiting(),
      acceptSuggestion: () => player?.acceptSuggestion() ?? false,
      reloadPlayer: () => player?.reload(),
      setPlayerMini,
      setPlayerPaused: (paused) => player?.setPaused(paused),
      playerAction: (action) => player?.action(action),
      subtitleQuery: (sender) =>
        player !== null && player.owns(sender)
          ? { imdbId: player.context.imdbId, season: player.context.season, episode: player.context.episode }
          : null,
      setSubtitleLanguage: (code) => {
        const settings = store.read().settings
        if (settings.subtitleLanguage !== code) store.applyPatch({ settings: { ...settings, subtitleLanguage: code } })
      },
      setOnTv,
      pressPlay: async () => player?.pressPlay(),
      cast,
      castNowPlaying: () => {
        if (!player) return null
        const context = player.context
        const provider = player.candidates[player.candidateIndex]?.provider
        const episode =
          context.season !== null && context.episode !== null ? `S${context.season}E${context.episode}` : ''
        return {
          title: context.title,
          subtitle: [episode, provider?.name ?? ''].filter(Boolean).join(' · '),
          providerName: provider?.name ?? 'This source',
          // The live position, not the stored resume point: the user pressed
          // Cast during playback, and the saved point is however far back the
          // last write was.
          startSeconds: player.position()?.seconds ?? 0,
          titleKey: titleKey(context),
          providerId: provider?.id ?? null,
          episode: episodeOf(context),
        }
      },
      checkReleases,
      allProviders,
      automaticOrder: automaticOrderFor,
      results: testResults,
      preview: {
        plan: previewPlanFor,
        keep: keepPreviewPosition,
        started: (req, providerId, filmSeconds) =>
          void segmentStore?.notePlaylist(windowWhere(req, providerId), previewRequests(), filmSeconds, req.runtimeMinutes ?? null),
        carry: (report) => player?.carryTo(report),
        // Nothing held to show (the player closed, or never opened): the page
        // is told the carry is over all the same, or it would stand in forever.
        carryEnd: () => (player?.held() ? player.carryEnd() : send(EV.carryReleased, null)),
        cacheStatus: () => segmentStore?.status() ?? null,
      },
      scan,
      warmStarts,
      scanFiled: cacheAfterTest,
    })

    // After the IPC is up, so its first status reaches a window that can ask.
    watchlistTester.start()
    // Additions come of age while the app runs; playback and list changes poke it too.
    setInterval(() => autoTester.tick(), AUTO_TEST_TICK_MS)

    // Export/import from the menu are routed back through the renderer so they
    // reach the same IPC handler the in-app buttons use. The original had two
    // divergent copies of the merge logic — one in the menu, one in the
    // handler — and only the handler's was ever fixed.
    const menuDeps: MenuDeps = {
      getMainWindow,
      createMainWindow: () => void createMainWindow(),
      exportData: () => send(EV.menuAction, 'export'),
      importData: () => send(EV.menuAction, 'import'),
      checkReleasesNow,
      dataDir: store.dir,
    }

    buildMenu(menuDeps)
    createTray(dirname, menuDeps)
    void createMainWindow()

    stopReleaseTimer = startReleaseTimer(store, announce)

    /**
     * Background work over the saved library, in order and off the hot path.
     *
     * Both passes are deliberately unawaited and deliberately slow — nothing on
     * screen is waiting for either, and a run cut short by the app closing
     * resumes on the next launch. They are *sequenced* rather than fired
     * together for a specific reason: the season split tombstones legacy
     * watched entries, and a score write landing on one of those ids
     * afterwards would resurrect it.
     */
    void (async () => {
      /**
       * Split whole-series watched entries into one per season.
       *
       * A library built before 1.5.7 holds one entry per series meaning "all of
       * it". Under the per-season model that reads as a shelf of single cards
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
        // Whatever it managed is already saved, and the rest is still legacy,
        // so the next launch simply tries again. Failing here must not stop
        // the score backfill below.
      })

      /** Top up scores for titles saved before the app stored one. */
      await backfillScores({
        pending: () => {
          const document = store.read()
          const missing = [
            ...document.watchlist.filter((w) => !(w.rating > 0)),
            ...document.watched.filter((w) => !(w.rating > 0)),
          ]
          // A title in both lists is one lookup, not two.
          const seen = new Set<number>()
          return missing.filter((entry) => {
            if (seen.has(entry.tmdbId)) return false
            seen.add(entry.tmdbId)
            return true
          })
        },
        score: async (tmdbId, type) => (await tmdb.detail(tmdbId, type)).rating,
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

    /**
     * Load the managed provider list, then look for a newer one.
     *
     * Read-then-refresh, in that order and both non-blocking. The cached copy
     * is what the app runs on for the rest of this session, and it is available
     * immediately; the network fetch is a bonus that lands whenever it lands.
     * Doing it the other way round would make the app's first play wait on
     * github.com, which is exactly the kind of dependency a desktop app should
     * not have on its hot path.
     *
     * A failure is not surfaced. The bundled list is a working catalogue, and
     * an error toast about a background refresh the user never asked for tells
     * them about a problem they cannot act on.
     */
    void (async () => {
      const catalogStore = fileCatalogStore(store.dir)
      cachedCatalog = await readCache(catalogStore)

      const refresh = async (): Promise<void> => {
        const result = await refreshCatalog(catalogStore)
        if (result.status === 'updated') {
          cachedCatalog = await readCache(catalogStore)
          console.log(
            `[catalog] updated: ${result.providers} providers, curated ${result.updatedAt}`,
          )
          send(EV.storeChanged, null)
        } else if (result.status === 'failed') {
          console.warn(`[catalog] refresh failed (${result.reason}); keeping the current list`)
        }
      }

      await refresh()
      catalogTimer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS)
    })()

    // The controls injected into the provider's page ask to change episode;
    // main rebuilds the URL from the provider template and navigates.
    ipcMain.on(EV.playerNavigate, (_event, payload: { season: number; episode: number }) => {
      navigatePlayer(payload.season, payload.episode)
    })

    // The user picking a different source from inside the player page.
    ipcMain.on(EV.playerSwitchProvider, (_event, payload: { providerId: string }) => {
      if (player?.switchTo(payload.providerId)) sendPlayerState()
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createMainWindow()
    })

    /**
     * When sync runs by itself.
     *
     * Three moments, chosen because each is one where the *other* device may
     * have moved on without this one hearing about it:
     *
     * - once the window is up, which covers "I watched something on my phone",
     * - whenever the window regains focus, which covers coming back to the
     *   desktop after using the phone, and
     * - after a local write settles, which pushes what just happened here.
     *
     * All three go through the same runner, so overlapping triggers — focus
     * arriving while the launch sync is still going, which is the normal case —
     * coalesce into one follow-up rather than three syncs.
     */
    sync?.syncSoon()

    app.on('browser-window-focus', () => sync?.syncSoon())

    /**
     * A local write, debounced.
     *
     * The store notifies on every mutation, and a session marking ten episodes
     * watched would otherwise be ten syncs. The delay is generous on purpose:
     * nothing is lost by syncing a minute late, and the next trigger would have
     * caught it anyway.
     */
    let writeSyncTimer: ReturnType<typeof setTimeout> | null = null
    store.subscribe((key) => {
      if (sync === null || applyingRemote) return
      // Positions change every five seconds while something plays. They go by
      // the positions file on its own pace; debounced here, they would hold
      // the library sync off until playback stopped. The library still gets
      // them with its next sync.
      if (key === 'resumePoints') {
        pushPositions.request()
        return
      }
      if (writeSyncTimer !== null) clearTimeout(writeSyncTimer)
      writeSyncTimer = setTimeout(() => {
        writeSyncTimer = null
        sync?.syncSoon()
      }, SYNC_AFTER_WRITE_MS)
    })
    // What this device measures goes out at the history's own pace; what it
    // took from another device is already there.
    resultStore.subscribe((change) => {
      if (change === 'local') pushResults.request()
    })
  })
}

app.on('window-all-closed', () => {
  /**
   * A probe run has no windows *between* subjects, and that is not the end of
   * it.
   *
   * `--extract-streams` and its siblings create one hidden `BrowserWindow` per
   * provider and destroy it before moving to the next. Without this guard the
   * gap between the first and second provider looks exactly like the user
   * closing the app: `window-all-closed` fires, `app.quit()` runs, and the
   * process exits **zero** partway through a fifteen-minute measurement. It
   * reported success and one result, which is the worst shape a failure can
   * take — `probeAndQuit` owns the exit for these runs and calls `app.exit(0)`
   * when it is genuinely finished.
   */
  if (isProbeRun(process.argv)) return
  if (process.platform !== 'darwin') app.quit()
})

/**
 * Quitting with a player open settles it first, and gives the positions file
 * a moment to go out.
 *
 * Until 1.9.8 quitting only flushed the store, so the stretch since the last
 * saved position was lost and the episode never had "watched" decided. The
 * push is waited on for at most `QUIT_PUSH_WAIT_MS`: a quit that hangs on the
 * network is worse than a position that arrives at the next launch instead.
 */
const QUIT_PUSH_WAIT_MS = 1_500
let quitSettled = false

app.on('before-quit', (event) => {
  if (!quitSettled) {
    quitSettled = true
    const watching = player !== null
    // Settling sends the positions push on its own; the wait below joins it.
    closePlayer(false)
    if (sync !== null && watching) {
      event.preventDefault()
      const pushed = sync.positions()
      void Promise.race([pushed, new Promise((resolve) => setTimeout(resolve, QUIT_PUSH_WAIT_MS))]).finally(() =>
        app.quit(),
      )
      return
    }
  }
  stopRendererServer()
  stopReleaseTimer?.()
  if (catalogTimer) clearInterval(catalogTimer)
  // A coalesced write may still be pending.
  void store.flush()
  void resultStore.flush()
})
