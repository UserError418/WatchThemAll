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
 * ## What is genuinely missing, and why
 *
 * `player.*` is the exception. On desktop the video is a native
 * `WebContentsView` and main injects JavaScript into the provider's own frames
 * to read the `<video>` position and to notice a stall. Android's WebView
 * grants no equivalent cross-origin privilege, and neither does the iframe this
 * uses instead — see `playersurface.ts`. So playback, provider switching and
 * episode stepping all work; resume-to-position, stall detection and the
 * auto-switch countdown are absent rather than faked.
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
  DiscoverRequest,
  GenreRowRequest,
  MalDecisions,
  MalImportSummary,
  MalPreview,
  Paged,
  PlayRequest,
  PlayerState,
  PlayerSuggestion,
  RowRequest,
  TailoredRequest,
  TailoredRow,
  TitleProviderState,
  TitleRef,
  WtaApi,
} from '@shared/ipc'

import * as tmdb from '@main/tmdb'
import * as search from '@main/search'
import BUNDLED_CATALOG from '@main/providers.json'
import { buildPlayUrl } from '@main/providers'
import type { PlayCandidate } from '@main/providers'
import {
  automaticOrder,
  defaultProviderOrder,
  lastWorkingForTitle,
  mediaKey,
  outcomesForTitle,
  record,
  titleKey,
} from '@main/outcomes'
import { checkAll } from '@main/releases'
import { App as CapacitorApp } from '@capacitor/app'
import { createPlayerSurface } from './playersurface'
import { createChromeApi } from './chrome'
import { createChromeOverlay } from './chromeoverlay'
import { notifyFound, syncScheduledReleases } from './notifications'
import { exportStore, importIntoStore } from '@main/sync'
import { excludedTmdbIds, genreWeights, hasEnoughSignal } from '@main/taste'
import {
  DEFAULT_SELECTED,
  DEFAULT_TARGETS,
  STATUS_LABELS,
  parseMalExport,
  pickBestMatch,
  searchVariants,
} from '@main/malimport'
import type { MalEntry } from '@main/malimport'
import { applyMalImport } from '@main/malapply'
import type { ResolvedTitle } from '@main/malapply'

import { Signal } from './events'
import { MobileStore } from './store'
import { pickTextFile, shareTextFile } from './files'
import { createMobileSync } from './sync'
import type { SyncStatus } from '@shared/sync/types'

/** Interleave two lists, longest tail last. Mirrors the desktop tailored row. */
function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = []
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i]) out.push(a[i]!)
    if (b[i]) out.push(b[i]!)
  }
  return out
}

/** How long a local change settles before it is pushed. Matches the desktop. */
const SYNC_AFTER_WRITE_MS = 8_000

export async function createBridge(): Promise<WtaApi> {
  const store = new MobileStore()
  await store.load()

  const storeChanged = new Signal<void>()
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
  const playbackActive = new Signal<boolean>()
  const playerState = new Signal<PlayerState | null>()
  const playerSuggestion = new Signal<PlayerSuggestion | null>()
  const playerPointerTop = new Signal<boolean>()
  const syncStatus = new Signal<SyncStatus>()

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
    host: {
      read: () => store.raw(),
      write: async (document) => {
        applyingRemote = true
        try {
          await store.replaceDocument(document)
        } finally {
          applyingRemote = false
        }
        /**
         * The one write the renderer did not ask for.
         *
         * Desktop emits `storeChanged` on every mutation because its store
         * lives in another process; here the renderer's own writes go through
         * `window.wta.store.write`, so it already knows about those. A merge
         * pulled down from the other device is the exception — nothing in the
         * renderer initiated it, and without this the user kept looking at the
         * pre-sync library until they restarted the app.
         */
        storeChanged.emit()
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
  let writeSyncTimer: ReturnType<typeof setTimeout> | null = null
  store.subscribe(() => {
    if (applyingRemote) return
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
   * Every provider the app knows about.
   *
   * The bundled list plus the user's custom entries. The desktop app also
   * merges a remote catalogue it refreshes in the background and caches to
   * disk; that is deliberately not here yet, so the phone ships whatever
   * catalogue its APK was built with. It is a staleness problem, not a
   * correctness one, and the custom-provider form covers the urgent case.
   */
  const allProviders = (): Provider[] => {
    const custom = store.read().customProviders
    const overridden = new Set(custom.map((p) => p.id))
    const bundled = BUNDLED_CATALOG.providers as unknown as Provider[]
    return [...bundled.filter((p) => !overridden.has(p.id)), ...custom]
  }

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
    store.setPreference('providerOrder', seeded)
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

  const surface = createPlayerSurface()
  const chrome = createChromeOverlay()
  let session: Session | null = null

  /**
   * The last state emitted, kept so a late subscriber can be caught up.
   *
   * The player's chrome mounts *after* playback starts and subscribes a tick
   * after that, so a signal with no replay tells it nothing until the next
   * episode or source change. See `chrome.ts`'s `onContext`.
   */
  let currentPlayerState: PlayerState | null = null

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
   * Record a hand-off as a successful stream.
   *
   * Optimistic, and deliberately so: nothing on this platform can see inside
   * the frame to know whether the video actually played, and recording every
   * play as a failure would poison the ranking that decides what to open next
   * time. The user's own correction is switching provider, which records the
   * new one the same way.
   */
  const recordStream = (req: PlayRequest, providerId: string): void => {
    store.collection('streamOutcomes').replaceAll(
      record(store.read().streamOutcomes, {
        providerId,
        mediaKey: mediaKey(req),
        outcome: 'stream',
      }),
    )
  }

  /**
   * Leave the player.
   *
   * One function rather than four repeated lines, because there are now three
   * ways out — the Android back gesture, the chrome's own Back button, and
   * `player.close` from the app renderer — and an exit that forgot to take the
   * chrome down with it would leave a bar floating over the browse view.
   */
  const closePlayer = (): void => {
    chrome.close()
    surface.close()
    session = null
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
    const selection = buildPlayUrl(orderedForRequest(req), req)
    if (!selection) return

    session = { req, candidates: selection.candidates, index: 0 }
    showCandidate(0)
  }

  const playerSwitchProvider = async (providerId: string): Promise<boolean> => {
    if (!session) return false
    const index = session.candidates.findIndex((c) => c.provider.id === providerId)
    if (index < 0) return false
    return showCandidate(index)
  }

  const playerReload = async (): Promise<void> => {
    surface.reload()
  }

  /** Load `index` of the current session's candidates. */
  const showCandidate = (index: number): boolean => {
    if (!session) return false
    const candidate = session.candidates[index]
    if (!candidate) return false

    session.index = index
    surface.show(candidate)
    recordStream(session.req, candidate.provider.id)
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
    storeChanged.emit()

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
    // the alarms are set from. An empty list is the disarm: the reconcile
    // cancels every pending alarm it no longer wants.
    void syncScheduledReleases(notificationsEnabled ? store.read().trackers : [])

    return { checked: before, found: notices.length }
  }

  /**
   * Sweep when the app comes back to the foreground.
   *
   * Throttled, because Android fires `resume` for every return from a Custom
   * Tab, a share sheet or a notification tap, and a TMDB call per tracked
   * series on each of those is rude to both the API and the battery. An hour is
   * far tighter than the desktop timer and far looser than the event rate.
   */
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
  let lastSweepAt = 0

  const sweepIfStale = (): void => {
    if (store.read().trackers.length === 0) return
    const configured = (store.read().settings.releaseCheckMinutes || 60) * 60 * 1000
    const interval = Math.max(configured, MIN_SWEEP_INTERVAL_MS)
    if (Date.now() - lastSweepAt < interval) return
    lastSweepAt = Date.now()
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
    void store.flush().catch(() => {})
  })

  void CapacitorApp.addListener('resume', sweepIfStale)
  // Also on launch: the app is "resumed" only on a *return*, and a cold start
  // after a week away is exactly when there is most to catch up on.
  sweepIfStale()

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
    if (session) {
      closePlayer()
      return
    }
    if (document.querySelector('.scrim, aside.panel')) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return
    }
    void CapacitorApp.exitApp()
  })

  const orderedForRequest = (req: PlayRequest): Provider[] => {
    const { streamOutcomes, favouriteProviderIds } = store.read()
    return automaticOrder(enabledProviders(), outcomesForTitle(streamOutcomes, titleKey(req)), {
      order: providerOrder(),
      favouriteIds: favouriteProviderIds,
    })
  }

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
    close: closePlayer,
    goTo: playerGoTo,
    switchProvider: playerSwitchProvider,
    reload: playerReload,
    season: (tmdbId, season) => tmdb.season(tmdbId, season),
    outcomes: async (media) => {
      const { streamOutcomes } = store.read()
      const key = titleKey(media)
      return {
        outcomes: outcomesForTitle(streamOutcomes, key),
        lastUsed: lastWorkingForTitle(streamOutcomes, key),
      }
    },
  })

  return {
    store: {
      read: async () => store.read(),
      write: async (patch: Partial<StoreShape>) => {
        store.applyPatch(patch)
      },
    },

    tmdb: {
      row: (req: RowRequest | GenreRowRequest | DiscoverRequest) =>
        tmdb.row(req) as Promise<Paged<MediaSummary>>,

      /**
       * The tailored row, assembled here rather than in the renderer.
       *
       * Same reasoning as on desktop: it is derived from the store, and having
       * the surface that draws it assemble the genre ids means the next surface
       * wanting the same thing reimplements the taste model.
       */
      tailored: async (req: TailoredRequest): Promise<TailoredRow> => {
        const data = store.read()
        if (!hasEnoughSignal(data)) return { items: [], genreIds: [], ready: false }

        const weights = genreWeights(data)
        if (weights.length === 0) return { items: [], genreIds: [], ready: false }

        const genreIds = weights.slice(0, 3).map((g) => g.genreId)
        const excluded = new Set(excludedTmdbIds(data))
        const [tv, movie] = await Promise.all([
          tmdb.discoverByGenres('tv', genreIds, req.page),
          tmdb.discoverByGenres('movie', genreIds, req.page),
        ])
        const items = interleave(tv.items, movie.items).filter((m) => !excluded.has(m.tmdbId))
        return { items, genreIds, ready: true }
      },

      search: (query: string, page: number) => tmdb.search(query, page),
      detail: (id: number, type: MediaType): Promise<MediaDetail | null> => tmdb.detail(id, type),
      season: (id: number, s: number): Promise<Season | null> => tmdb.season(id, s),
      genres: (type: MediaType) => tmdb.genres(type),
      trailer: (id: number, type: MediaType) => tmdb.trailer(id, type),
    },

    search: (query: string, page: number) => search.search(query, page),
    resolve: (item: MediaSummary) => search.resolve(item),

    providers: {
      list: async () => allProviders(),
      outcomes: async (media: TitleRef): Promise<TitleProviderState> => {
        const { streamOutcomes } = store.read()
        const key = titleKey(media)
        return {
          outcomes: outcomesForTitle(streamOutcomes, key),
          lastUsed: lastWorkingForTitle(streamOutcomes, key),
        }
      },
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
     * a sandboxed iframe here.
     */
    play: async (req: PlayRequest) => {
      const enabled = orderedForRequest(req)
      if (enabled.length === 0) {
        return { ok: false, error: 'No providers are enabled — turn one on in the Providers panel' }
      }

      const selection = buildPlayUrl(enabled, req)
      if (!selection) {
        return { ok: false, error: 'No enabled provider can play this' }
      }

      session = { req, candidates: selection.candidates, index: 0 }
      showCandidate(0)
      chrome.open()
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
      goTo: playerGoTo,
      switchProvider: playerSwitchProvider,
      dismissSuggestion: async () => {},
      reload: playerReload,
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
         * platform-specific in it.
         */
        const resolveTitle = async (
          title: string,
          type: MediaType,
        ): Promise<ResolvedTitle | null> => {
          for (const variant of searchVariants(title)) {
            const results = await tmdb.search(variant, 1)
            const best = pickBestMatch(variant, type, results.items)
            if (best) {
              return {
                tmdbId: best.tmdbId,
                imdbId: best.imdbId ?? null,
                title: best.title,
                posterPath: best.posterPath ?? null,
                genreIds: best.genreIds ?? [],
              }
            }
          }
          return null
        }

        const { store: next, summary } = await applyMalImport(
          store.read(),
          pendingMal,
          decisions,
          resolveTitle,
          (done, total) => malProgress.emit({ done, total }),
        )
        await store.replaceDocument(next)
        /**
         * Cleared, exactly as `src/main/ipc.ts` does after its own commit.
         * Left in place, a second commit without an intervening `preview()`
         * re-imports the previous file — and the MAL dialog offers "Import"
         * again without closing.
         */
        pendingMal = []
        storeChanged.emit()
        return summary
      },
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

      dir: () => store.describe(),
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
      storeChanged: (cb) => storeChanged.subscribe(cb),
      playbackActive: (cb) => playbackActive.subscribe(cb),
      playerState: (cb) => playerState.subscribe(cb),
      playerSuggestion: (cb) => playerSuggestion.subscribe(cb),
      playerPointerTop: (cb) => playerPointerTop.subscribe(cb),
      syncStatus: (cb) => syncStatus.subscribe(cb),
      malProgress: (cb) => malProgress.subscribe(cb),
    },
  }
}
