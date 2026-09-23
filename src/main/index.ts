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
import { EV } from '@shared/ipc'
import type { PlayRequest } from '@shared/ipc'
import { Store } from './store'
import { registerIpc } from './ipc'
import { createCastService } from './castservice'
import { buildMenu, createTray, type MenuDeps } from './menu'
import { createAppWindow } from './windows'
import { createInlinePlayer, type InlinePlayer } from './playerview'
import * as tmdb from './tmdb'
import { applyBrowserIdentity } from './identity'
import { playerShellUrl, startRendererServer, stopRendererServer } from './localserver'
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
import { freshScan, scanAwareOrder } from './providerscan'
import { createScanService } from './scanservice'
import { isWatchedEnough, resumeAction, resumeKey, resumeOfferFor } from './resume'
import {
  readCache,
  refreshCatalog,
  resolveProviders,
  REFRESH_INTERVAL_MS,
  type CachedCatalog,
} from './catalog'
import { fileCatalogStore } from './catalogcache'
import { oauthClient } from '@shared/sync/credentials'
import { SyncService } from './syncservice'
import { TokenStore } from './synctokens'

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
 * option a caller has.
 */
store.subscribe(() => send(EV.storeChanged, null))

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

/** True while sync is writing a merge result, rather than the user changing something. */
let applyingRemote = false
let mainWindow: BrowserWindow | null = null
let stopReleaseTimer: (() => void) | null = null
/** Cleared on quit so a pending refresh cannot outlive the app. */
let catalogTimer: ReturnType<typeof setInterval> | null = null

/** Player windows keyed by URL, so replaying the same episode reuses one. */
/**
 * The one player, or none.
 *
 * Singular now that playback is inline: a second video inside the same window
 * has nowhere to go, and the old map of windows keyed by URL existed only to
 * stop the same URL opening twice. Netflix has one player and so does this.
 */
let player: InlinePlayer | null = null

const getMainWindow = (): BrowserWindow | null =>
  mainWindow && !mainWindow.isDestroyed() ? mainWindow : null

/**
 * Base URL of the loopback renderer server, or null in dev where Vite serves.
 * Held here so re-creating the window on `activate` reuses the same server.
 */
let rendererBaseUrl: string | null = null

async function createMainWindow(): Promise<void> {
  if (!process.env.ELECTRON_RENDERER_URL) {
    // Loopback HTTP rather than file:// — YouTube refuses to embed into any
    // non-http(s) origin, which would break every trailer in a packaged build.
    rendererBaseUrl ??= await startRendererServer(join(dirname, '../renderer'))
  }
  mainWindow = createAppWindow(dirname, store.dir, rendererBaseUrl)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

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
  frameUrl: (providerUrl) =>
    rendererBaseUrl ? playerShellUrl(rendererBaseUrl, providerUrl) : providerUrl,
  onProgress: (progress) => {
    send(EV.providerScan, progress)
    // The player chrome is a separate document with its own preload, so the
    // app window's `send` does not reach it. Both surfaces can start a scan
    // and both draw its dots, so both have to be told.
    player?.notifyChrome(EV.providerScan, progress)
  },
})

/**
 * A television that stops on its own gives the sound back.
 *
 * `setAudioMuted` is the one piece of cast state that lives outside the cast
 * service, so nothing else would ever undo it — and a user who ended the cast
 * from the TV's own remote would be left with a permanently silent player and
 * no control in this app that explains it.
 */
cast.onSessionEnded(() => player?.setMuted(false))

function openPlayer(
  url: string,
  title: string,
  context: PlayRequest,
  candidates: PlayCandidate[] = [],
): void {
  const win = getMainWindow()
  if (!win) return

  // One player. Starting a second replaces the first rather than stacking two
  // videos in one window, which has no meaning.
  closePlayer(false)

  const [width = 1280, height = 800] = win.getContentSize()

  /*
   * The previous title's manifest is still the newest thing in the capture
   * buffer for the first seconds of this one, so casting now would put the
   * wrong film on the television while the screen showed the right one.
   */
  cast.forget()

  player = createInlinePlayer({
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
      The chrome's back button. It sends a request rather than closing itself,
      because leaving the player is the app's business: the window has to drop
      its player state and tell the renderer, and the view cannot do either.
    */
    onRequestClose: () => closePlayer(),
    /*
      The skip-intro offer, and the switch that governs it.

      `enabled` is read per episode rather than captured, so turning the
      setting off stops the lookups immediately instead of at the next
      restart — it decides whether two third parties are told what is
      playing, and a privacy switch that lags is not one.
    */
    skipIntro: {
      enabled: () => store.read().settings.skipIntro,
      dataDir: store.dir,
      isAnimated: isAnimatedTitle,
    },
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
      // `player.context` rather than the captured `context`: moving to another
      // episode reuses this view, and an outcome recorded against the episode
      // it opened on would credit the wrong key.
      recordOutcome(player?.context ?? context, providerId, outcome),
    /**
     * Write the position down as it goes, not only when the player closes.
     *
     * Deliberately just the position: `settleProgress` also decides "watched"
     * and consumes the elapsed-time counter, neither of which belongs in a
     * periodic sample. Reaching the end while still playing is caught on exit.
     */
    onPosition: (position) => rememberPosition(player?.context ?? context, position),
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
      const current = player?.context ?? context
      if (reason !== 'episode') rememberPosition(current, player?.position() ?? null)
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

  const action = resumeAction(position)
  if (action === 'keep') return
  if (action === 'forget') {
    points.remove(key)
    return
  }

  points.put({
    key,
    tmdbId: context.tmdbId,
    seconds: position!.seconds,
    duration: position!.duration,
  })
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
  const position = player.position()
  settleProgress(player.context, player.takeProgressMs(), position)
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
 * Stop playing and put the app back.
 *
 * `announce` is false only when a new player is about to replace this one —
 * telling the renderer playback stopped and then immediately that it started
 * makes every preview in the app restart for one frame.
 */
function closePlayer(announce = true): void {
  if (!player) return

  leaveCurrent()
  player.destroy()
  player = null

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

  // Settle the episode being left before the context is rewritten, or its time
  // would be credited to the one being moved to.
  leaveCurrent()

  const next: PlayRequest = { ...player.context, season, episode }
  // Keep the provider already loaded: changing episode should not silently
  // change source under the user.
  const selection = buildPlayUrl(
    enabledProviders(),
    { ...next, providerId: player.currentProviderId() ?? next.providerId },
    // The episode being stepped to has its own stored position — this is how
    // going back to one you abandoned half-way lands in the right place.
    resumeOfferFor(store.read().resumePoints, next),
  )
  if (!selection) return

  player.context = next
  player.candidates = selection.candidates
  player.candidateIndex = 0
  /*
   * The episode being left is still the newest thing in the capture buffer, and
   * stays so for the first seconds of the new one. Without this, the remote's
   * next-episode button would put the *previous* episode back on the
   * television while this window showed the right one — the same trap as
   * switching provider, which already clears it, and as opening a player,
   * which already clears it.
   */
  cast.forget()
  player.load(selection.url)

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
 * scan measured. The reasoning is in `scanAwareOrder`, which degrades to
 * exactly `automaticOrder` when nothing has been scanned.
 *
 * This is the half of the scan feature the user never sees. The dots tell them
 * which source to pick; this makes the *automatic* choice and every mid-episode
 * fallback use the same measurement, so "Automatic" stops walking into sources
 * that were measured dead a minute ago.
 */
function orderedForRequest(req: PlayRequest): Provider[] {
  const { streamOutcomes, favouriteProviderIds, providerScans } = store.read()
  const key = titleKey(req)
  return scanAwareOrder(enabledProviders(), outcomesForTitle(streamOutcomes, key), {
    order: providerOrder(),
    favouriteIds: favouriteProviderIds,
    scan: freshScan(providerScans, key),
  })
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
 * Where the floating player chrome is served from, or undefined if nowhere.
 *
 * Undefined is a supported answer and not an error: the player then runs with
 * no overlay, exactly as it did before the chrome existed.
 */
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

    registerIpc({
      store,
      sync,
      getMainWindow,
      openPlayer,
      setPlayerBounds: (bounds) => player?.setBounds(bounds),
      closePlayer: () => closePlayer(),
      navigatePlayer,
      switchPlayerProvider: (providerId) => {
        const ok = player?.switchTo(providerId) ?? false
        if (ok) sendPlayerState()
        return ok
      },
      keepWaiting: () => player?.keepWaiting(),
      reloadPlayer: () => player?.reload(),
      setPlayerMuted: (muted) => player?.setMuted(muted),
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
        }
      },
      checkReleases,
      allProviders,
      orderProviders: orderedForRequest,
      scan,
    })

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
    store.subscribe(() => {
      if (sync === null || applyingRemote) return
      if (writeSyncTimer !== null) clearTimeout(writeSyncTimer)
      writeSyncTimer = setTimeout(() => {
        writeSyncTimer = null
        sync?.syncSoon()
      }, SYNC_AFTER_WRITE_MS)
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

app.on('before-quit', () => {
  stopRendererServer()
  stopReleaseTimer?.()
  if (catalogTimer) clearInterval(catalogTimer)
  // A coalesced write may still be pending.
  void store.flush()
})
