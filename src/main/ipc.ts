/**
 * IPC registration.
 *
 * Split out of `index.ts` so the handler table is one readable list, and so the
 * completeness check below has something to check.
 *
 * That check is the point of this file. The original app exposed two channels
 * in its preload that no handler in main ever answered, so a whole piece of UI
 * silently did nothing for the life of the app. TypeScript catches a renderer
 * calling a method the contract does not declare; it cannot catch main
 * forgetting to register one. This does.
 */

import { BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { writeFileSync, readFileSync } from 'node:fs'
import { CH, EV } from '@shared/ipc'
import { isOpenableExternally } from './externalurl'
import type {
  DiscoverRequest,
  GenreRowRequest,
  PlayRequest,
  RowRequest,
  ForYouPlanRequest,
  ForYouRowRequest,
  ProviderScan,
  TitleProviderState,
  TitleRef,
  WatchlistTestStatus,
} from '@shared/ipc'
import type { MediaSummary, MediaType, StoreShape } from '@shared/types'
import type { Store } from './store'
import * as tmdb from './tmdb'
import * as search from './search'
import { buildPlayUrl } from './providers'
import { resumeOfferFor } from './resume'
import type { PlayCandidate } from './providers'
import type { PlayerBounds } from './playerview'
import { lastPlayedAt, lastWorkingForTitle, outcomesForTitle, titleKey } from './outcomes'
import { freshScan, pruneScans, recordScan, scanEpisode } from './providerscan'
import { airedEpisode, notOutYet } from '@shared/aired'
import type { ScanService } from './scanservice'
import { DEFAULT_SELECTED, DEFAULT_TARGETS, findBestMatch, parseMalExport, STATUS_LABELS } from './malimport'
import type { MalEntry } from './malimport'
import { applyMalImport, type ImportDecisions } from './malapply'
import { forYouPlan, forYouRow } from './foryou'
import { tmdbNetwork } from './foryou/network'
import { exportStore, importIntoStore } from './sync'
import type { Provider } from '@shared/types'
import { NO_CLIENT_REASON } from '@shared/sync/credentials'
import type { SyncStatus } from '@shared/sync/types'
import type { CastService, NowPlaying } from './castservice'
import type { SyncService } from './syncservice'

/** What the renderer sees when this build has no OAuth client at all. */
/** Shown when a cast is asked for with no player open. */
const NOTHING_PLAYING_REASON = 'Nothing is playing.'

const UNAVAILABLE_SYNC_STATUS: SyncStatus = {
  state: 'off',
  accountEmail: null,
  lastSyncedAt: null,
  error: NO_CLIENT_REASON,
  challenge: null,
}

export interface IpcDeps {
  store: Store
  getMainWindow: () => BrowserWindow | null
  openPlayer: (
    url: string,
    title: string,
    context: PlayRequest,
    /** Alternatives, best first, so the window can switch source without a round trip. */
    candidates: PlayCandidate[],
  ) => void
  /** Runs a release sweep and returns how many trackers turned up something. */
  checkReleases: () => Promise<{ checked: number; found: number }>
  /**
   * Every known provider: bundled, or the managed list once it has been
   * fetched, plus the user's own. Injected rather than resolved here so there
   * is exactly one place that decides which catalogue is in force — this file
   * previously read the bundled JSON directly, which would have made the
   * managed list invisible to playback.
   */
  allProviders: () => Provider[]
  /**
   * Cross-device sync, or `null` in a build with no OAuth client.
   *
   * Injected rather than constructed here for the same reason as the provider
   * list: exactly one place decides whether sync exists, and it is the place
   * that owns the token store.
   */
  sync: SyncService | null
  /**
   * The enabled providers in the order Automatic tries them for this title.
   *
   * Takes a title rather than a whole play request because the ordering only
   * ever depended on which title it is — and the source pickers need the same
   * order for a title nobody has pressed play on yet.
   */
  orderProviders: (media: TitleRef) => Provider[]
  /** Move the inline player's video to the rectangle the renderer reserved. */
  setPlayerBounds: (bounds: PlayerBounds) => void
  /** Stop playing and put the app's chrome back. */
  closePlayer: () => void
  /** Move the player to another episode of the same title. */
  navigatePlayer: (season: number, episode: number) => void
  /** Load a different source. False if it cannot serve the current title. */
  switchPlayerProvider: (providerId: string) => boolean
  /** The user chose to sit out a slow provider rather than switch away. */
  keepWaiting: () => void
  /** The user, or the countdown, took the offer to switch. False if there was none. */
  acceptSuggestion: () => boolean
  /** Reload the embed currently playing, in place. */
  reloadPlayer: () => void
  /**
   * Casting to a television.
   *
   * Injected rather than constructed here for the same reason as `sync`: it
   * owns a proxy's lifetime and a TLS session, and exactly one place should
   * decide when those start and stop.
   */
  cast: CastService
  /**
   * What the receiver should be told it is playing, or null when nothing is.
   *
   * Lives with the window rather than here because the player's state does.
   * The position is the *live* one: casting mid-film and starting the
   * television from the last saved point would rewind the user by however long
   * they had been watching.
   */
  castNowPlaying: () => NowPlaying | null
  /**
   * Silence the local copy while the television has it.
   *
   * See `PlayerWindow.setMuted` for why this is a mute and not a stop: the
   * embed is the only thing that can fetch the next episode's stream, so it
   * has to keep running for the remote's next-episode button to work at all.
   */
  setPlayerMuted: (muted: boolean) => void
  /**
   * Measure every enabled provider against one title.
   *
   * Injected for the same reason as `sync` and `cast`: it owns hidden browser
   * windows and their lifetime, and exactly one place should decide when those
   * exist.
   */
  scan: ScanService
  /** The watchlist tester's state, for Settings. */
  backgroundStatus: () => WatchlistTestStatus
}

/**
 * The entries from the most recent preview, awaiting a decision.
 *
 * Kept here rather than round-tripped through the renderer: the alternative is
 * shipping several hundred entries across the context bridge, having the
 * renderer hold them purely so it can hand them straight back, and paying the
 * structured-clone cost twice. The dialog is modal, so there is exactly one
 * pending import at a time by construction.
 */
let pendingMal: MalEntry[] = []

export function registerIpc(deps: IpcDeps): void {
  const { store, getMainWindow, openPlayer } = deps
  const providers = deps.allProviders

  ipcMain.handle(CH.storeRead, () => store.read())
  ipcMain.handle(CH.storeWrite, (_e, patch: Partial<StoreShape>) => store.applyPatch(patch))

  ipcMain.handle(CH.tmdbRow, (_e, req: RowRequest | GenreRowRequest | DiscoverRequest) => tmdb.row(req))
  /**
   * The personalised Browse rows.
   *
   * Main decides what they are and what goes in them, not the renderer: the
   * taste profile is derived from the store, and the store is here. The
   * renderer only asks for the plan and then for each planned row's pages.
   */
  ipcMain.handle(CH.tmdbForYouPlan, (_e, req: ForYouPlanRequest) =>
    forYouPlan(store.read(), req.seed, tmdbNetwork),
  )
  ipcMain.handle(CH.tmdbForYouRow, (_e, req: ForYouRowRequest) =>
    forYouRow(store.read(), req, tmdbNetwork),
  )

  ipcMain.handle(CH.tmdbSearch, (_e, query: string, page: number) => tmdb.search(query, page))
  ipcMain.handle(CH.tmdbDetail, (_e, id: number, type: MediaType) => tmdb.detail(id, type))
  ipcMain.handle(CH.tmdbSeason, (_e, id: number, season: number) => tmdb.season(id, season))
  ipcMain.handle(CH.tmdbGenres, (_e, type: MediaType) => tmdb.genres(type))
  ipcMain.handle(CH.tmdbTrailer, (_e, id: number, type: MediaType) => tmdb.trailer(id, type))

  ipcMain.handle(CH.search, (_e, query: string, page: number) => search.search(query, page))
  ipcMain.handle(CH.searchResolve, (_e, item: MediaSummary) => search.resolve(item))

  ipcMain.handle(CH.providersList, () => providers())
  /**
   * What has actually streamed for one title.
   *
   * Read straight from the store rather than cached in this module: the log is
   * appended to by the player as it plays, so anything held here would be stale
   * exactly when the user opens the picker to see what just happened.
   */
  ipcMain.handle(CH.providersOutcomes, (_e, media: TitleRef): TitleProviderState => {
    const { streamOutcomes, providerScans } = store.read()
    const key = titleKey(media)
    return {
      outcomes: outcomesForTitle(streamOutcomes, key),
      lastUsed: lastWorkingForTitle(streamOutcomes, key),
      scan: freshScan(providerScans, key, Date.now(), lastPlayedAt(streamOutcomes, key)),
      // From the same store read a moment later, by the function Automatic
      // itself calls — so the rows and the fallback chain cannot disagree.
      order: deps.orderProviders(media).map((provider) => provider.id),
    }
  })

  /**
   * Try every enabled provider and report which ones actually stream.
   *
   * The reply is the finished scan; the dots fill in from the `providerScan`
   * event as each source settles, because this takes tens of seconds and a UI
   * that says nothing until the end is indistinguishable from a hang.
   *
   * The result is stored even when the user cancels. A partial scan is not a
   * failed one — the providers it reached were genuinely measured, and throwing
   * that away would mean a cancelled run cost the user a minute for nothing.
   */
  ipcMain.handle(
    CH.providersScan,
    async (
      _e,
      media: TitleRef,
      episode: { season: number; episode: number } | null,
    ): Promise<ProviderScan> => {
      const key = titleKey(media)
      /*
       * Only what has come out can be tested — see `aired.ts`. The detail view
       * has usually just fetched these facts, so the lookup is a cache hit. A
       * failed one tests what was asked for, as before: a scan must not stop
       * working because TMDB is down.
       */
      const facts = await tmdb.detail(media.tmdbId, media.type).catch(() => null)
      if (facts && notOutYet(facts.releaseDate, Date.now())) {
        // Nothing stored: an empty result is not a measurement to keep.
        return { titleKey: key, at: Date.now(), verdicts: {} }
      }
      // Never probe a TV title without an episode — see `scanEpisode`.
      const wanted = scanEpisode(media.type, episode)
      const target = wanted && facts ? airedEpisode(wanted, facts.lastEpisode) : wanted
      const scan = await deps.scan.run(key, {
        imdbId: media.imdbId ?? '',
        tmdbId: media.tmdbId,
        type: media.type,
        season: target?.season,
        episode: target?.episode,
        label: key,
        // A scan asks whether a stream exists, not whether it is the right
        // programme, so it has no runtime and invents none. The one reader is
        // the quality reading's `lengthVerdict`, which without it still
        // refuses an ad's size, just not a wrong programme's.
        runtimeMinutes: null,
      })

      // Pruned on the way in rather than on load: this is the only moment the
      // list grows, so it is the only moment it can need trimming, and doing it
      // here keeps the expiry rule beside the code that depends on it.
      store.setProviderScans(recordScan(pruneScans(store.read().providerScans), scan))
      return scan
    },
  )

  ipcMain.handle(CH.providersScanCancel, () => deps.scan.cancel())
  ipcMain.handle(CH.providersBackgroundStatus, () => deps.backgroundStatus())
  ipcMain.handle(CH.dataDir, () => store.dir)

  /**
   * Open a web address outside the app.
   *
   * `shell.openExternal` hands the string to the desktop environment, which
   * resolves far more than http — so the guard is not optional, and it is
   * shared with the phone rather than written twice.
   */
  ipcMain.handle(CH.openExternal, async (_e, url: string): Promise<boolean> => {
    if (typeof url !== 'string' || !isOpenableExternally(url)) return false
    try {
      await shell.openExternal(url)
      return true
    } catch {
      // No browser, or the desktop environment refused. The caller keeps the
      // address on screen either way.
      return false
    }
  })

  /**
   * Sync.
   *
   * Every handler answers even when sync is unavailable, because the contract
   * says the channel exists and main asserts at startup that every channel has
   * a handler. A build with no client reports it in the status instead, which
   * is what the Settings screen renders.
   */
  const { sync } = deps
  ipcMain.handle(CH.syncStatus, () => sync?.status() ?? UNAVAILABLE_SYNC_STATUS)
  ipcMain.handle(CH.syncConnect, () =>
    sync?.connect() ?? { ok: false, error: NO_CLIENT_REASON },
  )
  ipcMain.handle(CH.syncCancel, () => sync?.cancel())
  ipcMain.handle(CH.syncDisconnect, () => sync?.disconnect())
  ipcMain.handle(CH.syncNow, () => sync?.now() ?? { ok: false, error: NO_CLIENT_REASON })
  /**
   * Casting.
   *
   * The desktop reaches a Chromecast through `castdiscovery.ts` and
   * `castsender.ts`, which speak mDNS and CastV2 by hand — Electron has no
   * Google Play Services, so unlike the phone there is nothing to delegate to.
   * These handlers are the thin part; everything interesting is in
   * `castservice.ts`.
   */
  const { cast } = deps
  ipcMain.handle(CH.castAvailable, () => true)
  ipcMain.handle(CH.castStartDiscovery, () => cast.startDiscovery())
  ipcMain.handle(CH.castStopDiscovery, () => cast.stopDiscovery())
  ipcMain.handle(CH.castDevices, () => cast.devices())
  ipcMain.handle(CH.castConnect, (_e, deviceId: string) => cast.connect(deviceId))
  ipcMain.handle(CH.castDisconnect, async () => {
    await cast.disconnect()
    // The picture is ours again, so give the sound back with it.
    deps.setPlayerMuted(false)
  })
  ipcMain.handle(CH.castStatus, () => cast.status())
  ipcMain.handle(CH.castControl, (_e, action: 'play' | 'pause' | 'stop' | 'seek', seconds?: number) =>
    cast.control(action, seconds),
  )
  ipcMain.handle(CH.castSetVolume, (_e, level: number) => cast.setVolume(level))
  ipcMain.handle(CH.castSetMuted, (_e, muted: boolean) => cast.setMuted(muted))
  ipcMain.handle(CH.castBeam, async () => {
    const now = deps.castNowPlaying()
    if (now === null) return { ok: false, error: NOTHING_PLAYING_REASON }
    const result = await cast.beam(now)
    // Only on success. A failed beam leaves the user watching here, and taking
    // the sound away from that would turn one disappointment into two.
    if (result.ok) deps.setPlayerMuted(true)
    return result
  })

  ipcMain.handle(CH.releasesCheck, () => deps.checkReleases())

  ipcMain.handle(CH.playOpen, (_e, req: PlayRequest) => {
    /**
     * Only providers the user has enabled, in the order they arranged them.
     *
     * Falling through to disabled providers would defeat the toggle entirely —
     * a provider switched off because it serves malware or does not work must
     * never be reached by the fallback chain. Better to fail with a reason the
     * user can act on.
     */
    const enabled = deps.orderProviders(req)

    if (enabled.length === 0) {
      return { ok: false, error: 'No providers are enabled — turn one on in the Providers panel' }
    }

    /**
     * Order the fallback chain by what has actually worked.
     *
     * The user's explicit choice still wins — `buildPlayUrl` puts
     * `req.providerId` first regardless — so this only decides what to try
     * *after* it. The ordering comes from recorded playback outcomes rather
     * than from reachability: a provider can answer every probe and still not
     * carry the episode, and "it responded" was never the question.
     */
    /**
     * Start where the user left off, by asking the provider to.
     *
     * Applied to every candidate rather than only the winner, because falling
     * back to another source mid-episode used to restart the title from the
     * beginning — which is the moment a resume matters most. The desktop's
     * seek-after-load stays as the fallback for providers that read no
     * parameter, and stands down on its own when one of these does.
     */
    const selection = buildPlayUrl(enabled, req, resumeOfferFor(store.read().resumePoints, req))
    if (selection) {
      openPlayer(selection.url, req.title, req, selection.candidates)
      return {
        ok: true,
        url: selection.url,
        providerId: selection.provider.id,
        providerName: selection.provider.name,
      }
    }

    // Distinguish "nothing enabled can serve this" from "we lack the id every
    // enabled provider needs", because the fixes are different.
    const needsImdb = enabled.every((p) => {
      const template = req.type === 'movie' ? p.movie?.urlTemplate : p.tv?.urlTemplate
      return template?.includes('{imdb}') ?? true
    })

    return {
      ok: false,
      error:
        needsImdb && !req.imdbId
          ? 'TMDB has no IMDB id for this title, which your enabled providers all require'
          : `None of your ${enabled.length} enabled providers can play a ${req.type === 'movie' ? 'film' : 'series'}`,
    }
  })

  /**
   * The renderer owns where the video sits.
   *
   * A `WebContentsView` is a native layer with no idea what the page layout is
   * doing, so the only component that can know its rectangle is the one that
   * reserved the space. It reports on mount, on resize, and on window resize.
   */
  ipcMain.handle(CH.playSetBounds, (_e, bounds: PlayerBounds) => deps.setPlayerBounds(bounds))
  ipcMain.handle(CH.playClose, () => deps.closePlayer())
  ipcMain.handle(CH.playGoTo, (_e, season: number, episode: number) =>
    deps.navigatePlayer(season, episode),
  )
  ipcMain.handle(CH.playSwitchProvider, (_e, providerId: string) =>
    deps.switchPlayerProvider(providerId),
  )
  ipcMain.handle(CH.playDismissSuggestion, () => deps.keepWaiting())
  ipcMain.handle(CH.playAcceptSuggestion, () => deps.acceptSuggestion())
  ipcMain.handle(CH.playReload, () => deps.reloadPlayer())

  ipcMain.handle(CH.dataExport, async () => {
    const payload = exportStore(store.read())
    const win = getMainWindow()
    const { filePath } = await dialog.showSaveDialog(win ?? undefined!, {
      title: 'Export WatchThemAll Data',
      defaultPath: `watchthemall-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (!filePath) return { ok: false, cancelled: true }
    try {
      writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8')
      return { ok: true, path: filePath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Write failed' }
    }
  })

  /**
   * Read a MAL export and describe it, without touching TMDB.
   *
   * Instant even for several hundred titles, so the user sees what they are
   * about to import before anything costs anything. Resolution happens in the
   * commit below, for the entries they keep.
   */
  ipcMain.handle(CH.malPreview, async () => {
    const win = getMainWindow()
    const { filePaths } = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Import a MyAnimeList export',
      filters: [{ name: 'MyAnimeList export', extensions: ['xml'] }],
      properties: ['openFile'],
    })
    if (!filePaths?.length) return null

    const parsed = parseMalExport(readFileSync(filePaths[0]!, 'utf-8'))
    // Held for the commit, so the renderer never has to carry 300 entries back
    // across the bridge just to hand them straight back.
    pendingMal = parsed.entries

    return {
      userName: parsed.userName,
      entries: parsed.entries,
      skipped: parsed.skipped,
      defaultTargets: DEFAULT_TARGETS,
      defaultSelected: DEFAULT_SELECTED,
      labels: STATUS_LABELS,
    }
  })

  ipcMain.handle(CH.malImport, async (_e, decisions: ImportDecisions) => {
    const win = getMainWindow()
    const { store: next, summary } = await applyMalImport(
      store.read(),
      pendingMal,
      decisions,
      /**
       * The resolver. Injected so the assembly logic is testable without a
       * network. `findBestMatch` is the whole of it apart from the search
       * itself, shared with the phone.
       */
      async (title, type) => {
        const best = await findBestMatch(title, type, async (term) => (await tmdb.search(term, 1)).items)
        if (!best) return null
        return {
          tmdbId: best.tmdbId,
          type: best.type,
          imdbId: best.imdbId ?? null,
          title: best.title,
          posterPath: best.posterPath,
          genreIds: best.genreIds,
          rating: best.rating,
        }
      },
      (done, total) => win?.webContents.send(EV.malProgress, { done, total }),
    )

    await store.replaceDocument(next)
    pendingMal = []
    return summary
  })

  ipcMain.handle(CH.dataImport, async (_e, payload: unknown) => {
    // Called either with a parsed payload from the renderer, or with nothing —
    // in which case main owns the file picker.
    let incoming = payload
    if (incoming == null) {
      const win = getMainWindow()
      const { filePaths } = await dialog.showOpenDialog(win ?? undefined!, {
        title: 'Import WatchThemAll Data',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      })
      if (!filePaths?.length) return { ok: false, cancelled: true }
      try {
        incoming = JSON.parse(readFileSync(filePaths[0]!, 'utf-8'))
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Unreadable file' }
      }
    }

    const current = store.read()
    const result = importIntoStore(current, incoming)
    if (!result.ok) return result

    // `importIntoStore` mutates the document it is given, so what it produced
    // is `current` — handed back whole rather than as a patch, because an
    // import is exactly the case `replaceDocument` exists for.
    await store.replaceDocument(current)
    return result
  })

  assertEveryChannelHandled()
}

/**
 * Fail loudly at startup if a channel in the contract has no handler.
 *
 * A missing handler is otherwise invisible until a user reaches the feature
 * that needs it, at which point `invoke` rejects with "No handler registered"
 * inside whatever promise chain called it — usually swallowed.
 */
function assertEveryChannelHandled(): void {
  const missing = Object.values(CH).filter((channel) => {
    // `ipcMain.eventNames()` does not include invoke handlers, so probe the
    // private handler table Electron keeps. Fall back to trusting it if the
    // internal shape ever changes rather than crashing the app over a check.
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, unknown> })
      ._invokeHandlers
    if (!handlers) return false
    return !handlers.has(channel)
  })

  if (missing.length > 0) {
    throw new Error(
      `IPC contract violated: no handler registered for ${missing.join(', ')}. ` +
        'Every channel in CH must be handled in registerIpc().',
    )
  }
}

/** Notify the user that a tracked series has new content. */
export function notifyRelease(title: string, body: string, onClick: () => void): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body, urgency: 'normal' })
  notification.on('click', onClick)
  notification.show()
}
