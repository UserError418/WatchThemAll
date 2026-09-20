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
import {
  readCache,
  refreshCatalog,
  resolveProviders,
  REFRESH_INTERVAL_MS,
  type CachedCatalog,
} from '@main/catalog'
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
import type { Outcome } from '@main/outcomes'
import { checkAll } from '@main/releases'
import { isOpenableExternally } from '@main/externalurl'
import type { PlayerReading } from '@main/playermessage'
import { isWatchedEnough, resumeAction, resumeKey, resumeOfferFor } from '@main/resume'
import { createCastBridge } from './cast'
import { App as CapacitorApp } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { LocalNotifications } from '@capacitor/local-notifications'
import { createPlayerSurface } from './playersurface'
import { preferencesCatalogStore } from './catalogstore'
import { createChromeApi } from './chrome'
import { createChromeOverlay } from './chromeoverlay'
import { notifyFound, syncScheduledReleases } from './notifications'
import { exportStore, importIntoStore } from '@main/sync'
import { buildTailoredRow } from '@main/tailored'
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
  void (async () => {
    cachedCatalog = await readCache(catalogStore)
    if (cachedCatalog !== null) storeChanged.emit()

    const fresh = Date.now() - (cachedCatalog?.fetchedAt ?? 0) < REFRESH_INTERVAL_MS
    if (fresh) return

    const result = await refreshCatalog(catalogStore)
    if (result.status !== 'updated') return
    cachedCatalog = await readCache(catalogStore)
    // The providers panel and the source picker both render off this list.
    storeChanged.emit()
  })()

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
  }

  let progress: Progress | null = null

  const surface = createPlayerSurface({
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

      const held = progress.reading

      /**
       * The provider moved on by itself.
       *
       * Its own "next episode" button is outside the app entirely, so the only
       * notice we get is the episode number in the next reading changing. The
       * episode being left has to be settled *here* — by the time the player is
       * closed, the held reading is about the new one and the old episode would
       * never be marked watched despite having been watched to the end.
       */
      const advanced =
        held !== null &&
        held.season !== null &&
        held.episode !== null &&
        reading.season !== null &&
        reading.episode !== null &&
        (held.season !== reading.season || held.episode !== reading.episode)

      if (advanced) {
        settleProgress(session.req)
        progress.episodeOpenedAt = Date.now()
      }

      progress.reading = reading
      progress.candidateReported = true
    },
  })
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

  /**
   * Casting to a television.
   *
   * Constructed once and kept, because it owns the proxy's lifetime: a bridge
   * rebuilt per call would lose track of a server it had already started.
   */
  const castBridge = createCastBridge()

  /**
   * What `beam` should tell the receiver it is playing.
   *
   * Reads the live position rather than the stored resume point where one is
   * available: the user presses Cast *during* playback, and starting the
   * television from the last saved position would rewind them by however long
   * they have been watching.
   */
  /**
   * Move what is playing onto the television, and stand the phone down.
   *
   * The blanking is not a nicety. While casting, the phone is *serving* the
   * stream to the receiver; if its own iframe keeps playing the same film it is
   * pulling the whole thing twice and playing audio in two rooms. The embed is
   * blanked rather than closed so the chrome, the episode list and the source
   * picker all stay where they are and `restore` can bring the picture back.
   */
  const beamToTv = async (): Promise<{ ok: boolean; error?: string; providerName?: string }> => {
    const now = nowPlaying()
    if (now === null) return { ok: false, error: 'Nothing is playing.' }

    const result = await castBridge.beam(now)
    if (result.ok) surface.blank()
    return result
  }

  /**
   * Casting stopped: take the film back, at the position the television reached.
   *
   * Written as a resume point rather than passed along, so the existing
   * mechanism does the work — `buildPlayUrl` appends the provider's own start
   * parameter, which is how resuming works on this platform at all. Without
   * this the embed would come back at whatever position it was blanked at,
   * rewinding the user by however long they watched on the TV.
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
      storeChanged.emit()
    }
    surface.restore()
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
  const settleOutcome = (req: PlayRequest, providerId: string, switching: boolean): void => {
    if (!progress) return
    const shownMs = Date.now() - progress.candidateShownAt

    // Proof, not inference: the provider's player posted a position out, which
    // it only does once it has something to play.
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
    if (reading === null || reading.season === null || reading.episode === null) return req
    if (reading.season === req.season && reading.episode === req.episode) return req
    return { ...req, season: reading.season, episode: reading.episode }
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
  const rememberPosition = (req: PlayRequest): void => {
    const reading = progress?.reading ?? null
    const context = contextFor(req, reading)
    const points = store.collection('resumePoints')

    // `resumeAction` rather than a threshold of our own. Its three answers exist
    // because collapsing "nothing was learned" into "forget what you knew" is
    // what made resuming flaky on the desktop, and a provider that reports
    // nothing is the *normal* case here rather than the exception.
    const action = resumeAction(
      reading === null ? null : { seconds: reading.seconds, duration: reading.duration ?? 0, ended: reading.ended },
    )
    if (action === 'keep') return
    if (action === 'forget') {
      points.remove(resumeKey(context))
      return
    }

    points.put({
      key: resumeKey(context),
      tmdbId: context.tmdbId,
      seconds: reading!.seconds,
      duration: reading!.duration ?? 0,
    })
    storeChanged.emit()
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
   * Leave the player.
   *
   * One function rather than four repeated lines, because there are now three
   * ways out — the Android back gesture, the chrome's own Back button, and
   * `player.close` from the app renderer — and an exit that forgot to take the
   * chrome down with it would leave a bar floating over the browse view.
   */
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

  const closePlayer = (): void => {
    if (session) {
      leaveCandidate(false)
      settleProgress(session.req)
    }
    chrome.close()
    surface.close()
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
    if (!selection) return

    // Settle the episode being left while `session.req` still names it. After
    // the line below, its time and its position would be credited to the
    // episode being moved to.
    leaveCandidate(false)
    settleProgress(session.req)

    session = { req, candidates: selection.candidates, index: 0 }
    if (progress) {
      progress.reading = null
      progress.episodeOpenedAt = Date.now()
    }
    showCandidate(0)
  }

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
    if (session) rememberPosition(session.req)
    surface.reload()
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

    surface.show(candidate)
    if (progress) {
      progress.candidateShownAt = Date.now()
      progress.candidateReported = false
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
      tailored: (req: TailoredRequest): Promise<TailoredRow> =>
        buildTailoredRow(store.read(), req.page, {
          recommendations: tmdb.recommendations,
          discoverByGenres: tmdb.discoverByGenres,
        }),

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
     * an iframe here.
     */
    play: async (req: PlayRequest) => {
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
      const selection = buildPlayUrl(
        enabled,
        req,
        resumeOfferFor(store.read().resumePoints, req),
      )
      if (!selection) {
        return { ok: false, error: 'No enabled provider can play this' }
      }

      // Playing something new while something else is up: settle the old one
      // first, exactly as closing the player would.
      if (session) {
        leaveCandidate(false)
        settleProgress(session.req)
      }

      session = { req, candidates: selection.candidates, index: 0 }
      const now = Date.now()
      progress = {
        reading: null,
        episodeOpenedAt: now,
        candidateShownAt: now,
        candidateReported: false,
      }
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
                rating: best.rating ?? 0,
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
      playbackSettled: (cb) => playbackSettled.subscribe(cb),
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
