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

import { BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import { writeFileSync, readFileSync } from 'node:fs'
import { CH, EV } from '@shared/ipc'
import type {
  DiscoverRequest,
  GenreRowRequest,
  PlayRequest,
  RowRequest,
  TailoredRequest,
  TitleProviderState,
  TitleRef,
} from '@shared/ipc'
import type { MediaSummary, MediaType, StoreShape } from '@shared/types'
import type { Store } from './store'
import * as tmdb from './tmdb'
import * as search from './search'
import { buildPlayUrl } from './providers'
import type { PlayCandidate } from './providers'
import type { PlayerBounds } from './playerview'
import { lastWorkingForTitle, outcomesForTitle, titleKey } from './outcomes'
import { DEFAULT_SELECTED, DEFAULT_TARGETS, parseMalExport, pickBestMatch, searchVariants, STATUS_LABELS } from './malimport'
import type { MalEntry } from './malimport'
import { applyMalImport, type ImportDecisions } from './malapply'
import { excludedTmdbIds, genreWeights, hasEnoughSignal } from './taste'
import { exportStore, importIntoStore } from './sync'
import type { Provider } from '@shared/types'
import { NO_CLIENT_REASON } from '@shared/sync/credentials'
import type { SyncStatus } from '@shared/sync/types'
import type { SyncService } from './syncservice'

/** What the renderer sees when this build has no OAuth client at all. */
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
   * The enabled providers ordered by what has actually streamed for this
   * request, with the fallback chain spread across distinct backends.
   */
  orderProviders: (req: PlayRequest) => Provider[]
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
  /** Reload the embed currently playing, in place. */
  reloadPlayer: () => void
}

/**
 * Alternate two lists, longest tail last.
 *
 * Not concat: a mixed row that is all series followed by all films reads as two
 * rows that failed to separate.
 */
function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = []
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i]) out.push(a[i]!)
    if (b[i]) out.push(b[i]!)
  }
  return out
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
   * The tailored Browse row.
   *
   * Main decides the contents, not the renderer: the taste profile is derived
   * from the store, and the store is here. Having the renderer assemble genre
   * ids to send back would put the recommendation in the surface that draws it,
   * where the next surface wanting the same thing has to reimplement it.
   */
  ipcMain.handle(CH.tmdbTailored, async (_e, req: TailoredRequest) => {
    const data = store.read()
    if (!hasEnoughSignal(data)) return { items: [], genreIds: [], ready: false }

    const weights = genreWeights(data)
    if (weights.length === 0) return { items: [], genreIds: [], ready: false }

    /**
     * Up to three genres, combined with OR rather than AND.
     *
     * AND would demand a title be simultaneously every genre the user likes,
     * which for anything but the blandest taste profile returns almost nothing.
     * Three rather than all of them because past the third the weights are long
     * tails and including them makes the row indistinguishable from "popular".
     */
    const genreIds = weights.slice(0, 3).map((g) => g.genreId)
    const excluded = new Set(excludedTmdbIds(data))

    /**
     * Both media types, interleaved.
     *
     * A taste profile built from a mixed library and then answered with series
     * only reads as a bug to anyone whose likes are mostly films.
     */
    const [tv, movie] = await Promise.all([
      tmdb.discoverByGenres('tv', genreIds, req.page),
      tmdb.discoverByGenres('movie', genreIds, req.page),
    ])

    const items = interleave(tv.items, movie.items).filter((m) => !excluded.has(m.tmdbId))
    return { items, genreIds, ready: true }
  })

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
    const { streamOutcomes } = store.read()
    const key = titleKey(media)
    return {
      outcomes: outcomesForTitle(streamOutcomes, key),
      lastUsed: lastWorkingForTitle(streamOutcomes, key),
    }
  })
  ipcMain.handle(CH.dataDir, () => store.dir)

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
    const selection = buildPlayUrl(enabled, req)
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
       * network.
       *
       * Tries `searchVariants` in order and takes the first term that finds
       * anything, then `pickBestMatch` to decide which of that term's results
       * was meant. Both exist because MAL's titles and TMDB's disagree
       * systematically rather than randomly — each carries the measurement
       * that justifies it.
       */
      async (title, type) => {
        for (const term of searchVariants(title)) {
          const found = await tmdb.search(term, 1)
          const best = pickBestMatch(term, type, found.items)
          if (best) {
            return {
              tmdbId: best.tmdbId,
              imdbId: best.imdbId ?? null,
              title: best.title,
              posterPath: best.posterPath,
              genreIds: best.genreIds,
            }
          }
        }
        return null
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
