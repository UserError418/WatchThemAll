/**
 * The inline player.
 *
 * Playback happens **inside the app window**, not in a separate one. A second
 * window meant alt-tabbing between the thing you were watching and the thing
 * you were browsing, and it meant the app had no idea what the player was
 * doing — which is how a preview ended up playing forever behind a film nobody
 * could find the source of.
 *
 * ## Why a `WebContentsView` and not an `<iframe>`
 *
 * An iframe in the app's own document looks like the obvious answer and would
 * cost four things the separate window was giving us for free:
 *
 * - **Per-provider `Referer`/`Origin`.** `applyProviderReferer` installs an
 *   `onBeforeSendHeaders` handler, and Electron allows exactly one per session.
 *   An iframe shares the app's session, so installing it there would silently
 *   replace the app-wide identity handler that every TMDB and IMDB request
 *   depends on. A view gets its own partition.
 * - **The in-page controls.** Episode navigation and the source switcher are
 *   injected into the provider's page by a preload. A cross-origin iframe
 *   cannot be scripted into at all; a view has its own preload.
 * - **`webSecurity: false`.** Embed players need it. Scoped to a view it
 *   affects the player and nothing else; the app window keeps its CSP.
 * - **Cookie isolation.** Provider cookies stay out of the store the rest of
 *   the app uses.
 *
 * ## The one thing a view costs
 *
 * It is a **native layer, not a DOM node**. It does not participate in
 * stacking, scrolling or layout, and it always paints over the page. So the
 * renderer measures where the video should go and tells the main process, and
 * anything the app draws must live *outside* that rectangle — which is why the
 * player chrome is a bar above the video rather than an overlay on top of it.
 * Controls that genuinely need to sit over the picture are injected into the
 * page by the preload instead, where they are part of it.
 */

import { WebContentsView, BrowserWindow, ipcMain, webFrameMain, type Session } from 'electron'
import { join } from 'node:path'
import { EV } from '@shared/ipc'
import type { BarState, EpisodeNav, OverlayArea, PlayRequest, PlayerSuggestion } from '@shared/ipc'
import { filmRelayScript } from '@shared/filmrelay'
import { isPlayerAction, type PlayerAction } from '@shared/playerkeys'
import { applyProviderReferer } from './identity'
import { blockAdverts, installFilmRelay, keepProviderInPlace, refusePopupsAndDownloads } from './providerguard'
import { clickPlayInFrames, pressPlay as pressPlayIn } from './pressplay'
import { beginStallWatch, frozenSeconds, observeStall, type StallWatch } from './playbackstall'
import { checkRuntime } from '@shared/runtimecheck'
import { findSegments } from './skiplookup'
import { skipButtonBounds } from './skipplacement'
import { SkipWatch } from './skipwatch'
import type { PlayCandidate } from './providers'
import { ResumeSeek } from './resume'
import { createPointerZoneWatcher } from './pointerzone'
import { isProviderFailure, judgeSilence, mayAutoSwitch, type LoadEvidence, type OfferKind } from './switchoffer'
import { mediaKind, totalBytesOf } from './mediarequest'
import { isSameOrigin } from './sameorigin'
import { observeCompleted, observeErrors, observeSendHeaders } from './webrequesthub'
import { loadFailureReason } from './loadfailure'
import { PLAY_MIN_FILM_SECONDS, PLAY_TIMING_MAX_MS, withPlayOffer, withQualityReading, type PlayMeasurement } from './providerscan'
import { isAudioList } from '@shared/audiotracks'
import { CarryOver } from '@shared/carryover'
import type { CarryAction, CarryReport } from '@shared/ipc'
import { QUALITY_CLASSES, qualityClass } from '@shared/streamquality'
import type { QualityKind, ScanReason } from '@shared/types'

/** Where the video sits, in the app window's content coordinates. */
export interface PlayerBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface InlinePlayer {
  /** What is showing. Rewritten by `goToEpisode`; read it, do not assign it. */
  context: PlayRequest
  /**
   * Where the detail view's preview is, while it stands in for this held
   * player (`InlinePlayerOptions.held`). Ignored once the player shows.
   */
  carryTo: (report: CarryReport) => void
  /** The preview stopped standing in: show the player now, wherever its film is. */
  carryEnd: () => void
  /** Still held behind the preview: not yet shown. */
  held: () => boolean
  /** Every provider that can serve this title, best first. */
  candidates: PlayCandidate[]
  /** Index into `candidates` of the provider currently loaded. */
  candidateIndex: number
  /**
   * Sources that failed this episode, with why (shown if all of them do):
   * `providerId` to skip them by, `provider` (the name) and `reason` to tell
   * the viewer. Matched by id: two sources may share a display name (a custom
   * one named after a catalogue entry), and by name the second was skipped
   * without ever being tried.
   */
  exhausted: Array<{ providerId: string; provider: string; reason: string }>
  /** Switch to a named provider. Returns false if it cannot serve this title. */
  switchTo: (providerId: string) => boolean
  /** "Keep waiting": stop offering to leave the provider currently loading. */
  keepWaiting: () => void
  /**
   * Take the offer on screen: mark the current source tried and move on.
   * Returns false when there is no offer to take.
   */
  acceptSuggestion: () => boolean
  /** Move the video. Called by the renderer whenever its slot moves or resizes. */
  setBounds: (bounds: PlayerBounds) => void
  /**
   * Shrink into the app's corner, or come back.
   *
   * The video view itself moves wherever the renderer's slot says, as
   * always. What this changes is the two views stacked on it: the chrome
   * and the skip button are sized to nothing, because at a few hundred
   * pixels wide the app draws its own controls beside the picture instead.
   * The chrome is told as well, so that it holds any countdown to switch
   * source while nobody can see it.
   */
  setMini: (mini: boolean) => void
  /** Pause or resume the provider's video. See `PAUSE_SCRIPT`. */
  setPaused: (paused: boolean) => void
  /**
   * Forward an event to the player chrome's own document.
   *
   * The chrome is a separate `WebContentsView` with its own preload, so the
   * app window's `send` does not reach it — every event it receives is posted
   * to `overlay.webContents` from inside this module. A no-op when no chrome
   * is mounted, which is the case for a probe player and for a build with no
   * chrome URL.
   */
  notifyChrome: (channel: string, payload: unknown) => void
  /**
   * Move to another episode of the same title, on the first of `candidates`.
   *
   * One call rather than the host rewriting `context` and `candidates` and
   * then loading, because two things belong to the step and must happen in
   * order. The context is the new episode's before the resume is armed, so
   * `onNavigate` hands back *that* episode's place. And what was learned about
   * the episode being left is forgotten: which sources failed it, which served
   * it the wrong length, which crashed on it. Kept, the last episode's
   * failures carried into the next, so a source that had failed S1E1 was
   * skipped by S1E2's fallback without ever being tried, and S1E2's "No
   * provider could play this" listed S1E1's failures.
   *
   * Not for a provider switch, a reload or a fallback: those stay on the same
   * episode, and what was learned about it still holds.
   */
  goToEpisode: (step: { context: PlayRequest; candidates: PlayCandidate[]; url: string }) => void
  /** Reload the current URL, for a source that loaded but then stalled. */
  reload: () => void
  /**
   * Silence the embed without stopping it.
   *
   * Used while a cast is running. The provider's player has to keep loading —
   * it is the only thing that fetches a stream, so stepping to another episode
   * on the television means loading that episode *here* first and capturing
   * what it fetches. What must not keep happening is the sound, which would
   * otherwise come out of two rooms at once.
   *
   * Muting rather than blanking, for that reason: blanking would throw away
   * the capture the next beam depends on.
   */
  setMuted: (muted: boolean) => void
  /**
   * The embed's own session partition.
   *
   * Exposed so casting can watch what the provider fetches — `castcapture.ts`
   * attaches an `onSendHeaders` observer to it, which is the only way the app
   * can learn the stream's address at all. Read once, immediately after the
   * player is created, because touching `webContents.session` after the view is
   * destroyed throws.
   */
  session: Session

  /**
   * The provider's own playback position, or null if it exposes none.
   *
   * Read from the embed's `<video>`; see `resume.ts` for why the main process
   * can reach it and the renderer cannot.
   */
  position: () => VideoPosition | null
  /**
   * Milliseconds this title has been playing, resetting the counter.
   *
   * Read when leaving an episode — closing, or stepping to another one — so
   * the time is attributed to what was on screen while it accrued.
   */
  takeProgressMs: () => number
  /** Tear down. Safe to call twice. */
  destroy: () => void
  /** The id of the provider currently loaded, for the app's chrome. */
  currentProviderId: () => string | null
  /**
   * Start playback the way a gesture would.
   *
   * Here for the health check rather than for the app — a user presses play
   * themselves. It lives on the player anyway because the player is what owns
   * the view and its frames, and because a check that drives anything *other*
   * than the real player is measuring the wrong thing.
   */
  pressPlay: () => Promise<void>
  /**
   * A player key, from whichever document had the focus (`playerkeys.ts`).
   *
   * Main is the router because the three documents that can have the focus
   * each own a different part of the answer. The shell's controls move the
   * film, the chrome opens its panels, and the window's fullscreen and the
   * way back are main's.
   */
  action: (action: PlayerAction) => void
  /** The own-controls setting changed while playing; tell the shell. */
  refreshConfig: () => void
  /** Whether `contents` is this player's shell: who may ask for its subtitles. */
  owns: (contents: Electron.WebContents) => boolean
}

/**
 * Told when a provider demonstrably worked or demonstrably did not.
 *
 * The player is the only place that knows, because it is the only place that
 * watches the page actually play. Reporting it out rather than writing it here
 * keeps this module free of the store.
 */
export type OutcomeReporter = (providerId: string, outcome: 'stream' | 'failed') => void

/**
 * Why the view is navigating.
 *
 * The host needs to tell them apart: a provider switch stays on the same
 * episode and carries its position across, while an episode step moves to a
 * different one and must look up *that* episode's own position instead.
 */
export type NavigationReason = 'provider' | 'episode' | 'reload' | 'fallback'

/** One reading off the provider's `<video>`. */
export interface VideoPosition {
  seconds: number
  duration: number
  /**
   * The element reached its own end.
   *
   * Worth carrying separately from `seconds >= duration`, because a player that
   * has finished frequently reports a `currentTime` a fraction short of its
   * `duration`, and because some seek back to zero on ending — at which point
   * the position alone says the title was barely started.
   */
  ended: boolean
  /**
   * The element is paused.
   *
   * Only meaningful next to `seconds`. A position that stops moving says
   * nothing on its own; this is what separates "the user pressed pause" from
   * "the stream died mid-episode".
   */
  paused: boolean
  /** The picture's own size, 0 until the first frame. For the play's quality. */
  width?: number
  height?: number
}

export interface InlinePlayerOptions {
  /**
   * Seconds to jump to once playback starts, when the provider has not
   * restored the position itself. Zero means start from the beginning.
   */
  resumeAt?: number
  /**
   * Called immediately before this view navigates anywhere — a provider
   * switch, an episode step, a reload — and answers where the *next* load
   * should resume from.
   *
   * Two jobs, and they have to happen together. The host writes down the
   * position being left while the view is still alive to be read, and hands
   * back the position the new load should seek to. Without it a switch was a
   * one-way trip: `resumeAt` was captured once when the view was created, so
   * changing provider mid-episode started the new one from zero and threw away
   * where the old one had got to. That is the case the resume feature is *most*
   * useful in and the one where it did nothing.
   */
  onNavigate?: (reason: NavigationReason) => number
  /**
   * Wrap a provider URL in the local player shell.
   *
   * Every navigation goes through this, so the provider is always framed and
   * never loaded as a top-level document — see `localserver.ts` for why that
   * distinction is now the difference between playing and a 403. Identity when
   * the shell is unavailable, which keeps the probe runner working without a
   * renderer server.
   */
  frameUrl?: (providerUrl: string) => string
  /**
   * A fresh reading from the provider's video, every few seconds.
   *
   * The position used to be written down only when the view was torn down or
   * navigated away from, which meant a crash, a forced quit or the machine
   * losing power threw away the whole session's progress. Sampling into the
   * store every five seconds (`PERSIST_EVERY_MS`) makes "where was I" survive
   * anything.
   */
  onPosition?: (position: VideoPosition) => void
  /**
   * Every reading, every poll — for what cannot wait five seconds: the end of
   * the episode, which starts auto-next (`upnext.ts`).
   */
  onPositionRead?: (position: VideoPosition) => void
  /**
   * URL of the floating chrome document, served by the local renderer server.
   *
   * Optional because the probe runs without a renderer build and has no use for
   * controls. Absent means no overlay, and the player behaves exactly as it did
   * before there was one.
   */
  chromeUrl?: string
  /** The app window the video is drawn into. */
  window: BrowserWindow
  /** Directory of the built main bundle, for resolving the preload. */
  dirname: string
  url: string
  context: PlayRequest
  candidates: PlayCandidate[]
  bounds: PlayerBounds
  reportOutcome?: OutcomeReporter
  /**
   * Told what a load measured, for the test results (`PlayMeasurement`): when
   * it started streaming and how long that took, then the best picture of
   * its first minute, or a failure the source's servers declared.
   */
  reportResult?: (providerId: string, seen: PlayMeasurement) => void
  /**
   * Open held: out of sight and silent, while the detail view's preview
   * stands in for the player (Resume carried over, `shared/carryover.ts`).
   * Shown when its film plays at the preview's second, or on any key other
   * than play/pause and mute, which go to the preview (`onHeldAction`).
   */
  held?: boolean
  /** A play/pause or mute key while held: for the preview, which is what is on screen. */
  onHeldAction?: (action: CarryAction) => void
  /** The held player is showing now. */
  onReleased?: () => void
  /**
   * Everything the skip buttons need (`skipwatch.ts`), or absent to leave them off.
   *
   * Grouped because they are useless apart, and because `enabled` is the
   * switch that decides whether two third parties are told what is playing:
   * without it the lookup must not happen at all.
   */
  skipIntro?: {
    /** Read on every reading, so turning it off takes effect immediately. */
    enabled: () => boolean
    /** The series' MyAnimeList id, or null; see `SegmentDeps.animeId`. */
    animeId: (tmdbId: number, season: number | null) => Promise<number | null>
    /** Whether an aired episode follows this one, for "Next episode" over the credits. */
    hasNext: (context: PlayRequest) => Promise<boolean>
    /** "Next episode" was pressed. */
    playNext: () => void
  }
  /**
   * The chrome's Back button was pressed.
   *
   * A request, and the host decides what it means. Since the mini player it
   * means "shrink into the corner", not "stop". It is separate from
   * `onClosed`, and the confusion between the two once made that button do
   * nothing at all: `onClosed` fires *after* the view has torn itself down,
   * so wiring Back to it asked the player to report a teardown nobody had
   * started.
   */
  onBack?: () => void
  /** v2: draw the app's own controls and hide the source's (`Settings.ownControls`). */
  ownControls?: () => boolean
  /** v2: the subtitle language to start with (`Settings.subtitleLanguage`). */
  subtitleLanguage?: () => string | null
  /** Fired once this view has torn itself down, from `destroy`. */
  onClosed?: () => void
  /**
   * Called whenever the loaded provider changes — by fallback or by the user
   * picking one from the in-page switcher.
   *
   * Without it the app's chrome keeps naming the provider it opened with while
   * a different one is actually playing, which is exactly the state where the
   * user most wants to know which source they ended up on.
   */
  onProviderChanged?: () => void
  /**
   * Offer to move to another source, or withdraw a standing offer with null.
   *
   * The player raises this instead of switching whenever the current provider
   * is merely *slow*. Deciding for the user was the old behaviour and it was
   * wrong: providers that resolve a stream after ten or fifteen seconds are
   * common, and the automatic switch fired while the page was visibly working.
   *
   * Observed rather than rendered: the offer itself is drawn by the floating
   * chrome, which `announceSuggestion` sends to directly. This hook is what
   * lets a probe or a test see the same decision without a window.
   */
  onSuggest?: (suggestion: PlayerSuggestion | null) => void
  /**
   * The video started or stopped moving, as Chromium's own media events
   * report it, for the mini player's play/pause button.
   */
  onPlayingChange?: (playing: boolean) => void
  /**
   * Whether "Test all sources" currently rates this provider as working for
   * the title being played. An offer to leave such a source never counts down
   * by itself — see `mayAutoSwitch`. Asked at the moment of the offer, so a
   * test that finishes while the player is open counts.
   */
  testedWorking?: (providerId: string) => boolean
}

/**
 * How much of a held player stays inside the window's left edge. Not none:
 * Chromium hides a view with nothing inside the window, and a hidden view is
 * what the held player must not be (see "Held" in `createInlinePlayer`).
 */
const HELD_SLIVER = 1

/**
 * Pause every video in a frame, for the mini player's button.
 *
 * Every one, not just the film: an advert left running is exactly what a
 * pause should also stop.
 */
const PAUSE_SCRIPT = `(() => {
  for (const video of document.querySelectorAll('video')) video.pause()
})()`

/**
 * Resume the film, and only the film: the biggest video with a real
 * duration, the same choice `READ_POSITION_SCRIPT` makes. Resuming every
 * video would restart an advert's clip along with it. `play()` rejects when
 * the page refuses. The rejection is swallowed, because the answer that
 * counts arrives as `media-started-playing`, or does not.
 */
const RESUME_SCRIPT = `(() => {
  let best = null
  let bestArea = 0
  for (const video of document.querySelectorAll('video')) {
    const duration = Number(video.duration)
    if (!Number.isFinite(duration) || duration <= 0) continue
    const rect = video.getBoundingClientRect()
    const area = rect.width * rect.height
    if (area > bestArea) {
      best = video
      bestArea = area
    }
  }
  best?.play().catch(() => {})
})()`

/**
 * Find the video that *is* the film, inside whatever frame holds it.
 *
 * Providers wrap the player in nested iframes and pages carry decorative video
 * elements for ads and animated backgrounds, so the biggest one with a real
 * duration is the one worth reading. Returns JSON, because values crossing the
 * `executeJavaScript` boundary have to be structured-cloneable and a plain
 * string always is.
 */
const READ_POSITION_SCRIPT = `(() => {
  let best = null
  for (const video of document.querySelectorAll('video')) {
    const duration = Number(video.duration)
    if (!Number.isFinite(duration) || duration <= 0) continue
    const rect = video.getBoundingClientRect()
    const area = rect.width * rect.height
    if (!best || area > best.area) {
      best = {
        area,
        seconds: Number(video.currentTime) || 0,
        duration,
        ended: !!video.ended,
        paused: !!video.paused,
        width: Number(video.videoWidth) || 0,
        height: Number(video.videoHeight) || 0,
      }
    }
  }
  return best
    ? JSON.stringify({
        seconds: best.seconds,
        duration: best.duration,
        ended: best.ended,
        paused: best.paused,
        width: best.width,
        height: best.height,
      })
    : null
})()`

/** The same selection, then a seek. */
function seekScript(seconds: number): string {
  return `(() => {
  let best = null
  for (const video of document.querySelectorAll('video')) {
    const duration = Number(video.duration)
    if (!Number.isFinite(duration) || duration <= 0) continue
    const rect = video.getBoundingClientRect()
    const area = rect.width * rect.height
    if (!best || area > best.area) best = { area, video }
  }
  if (!best) return null
  best.video.currentTime = ${seconds}
  return JSON.stringify({ seconds: Number(best.video.currentTime) || 0 })
})()`
}

export function createInlinePlayer(options: InlinePlayerOptions): InlinePlayer {
  const { window: win, dirname, url, context, candidates, bounds } = options
  const reportOutcome = options.reportOutcome ?? ((): void => {})

  /**
   * Its own session partition, for two reasons.
   *
   * `applyProviderReferer` installs an `onBeforeSendHeaders` handler and
   * Electron allows exactly one per session — registering it on the app's
   * session would silently replace the app-wide identity handler. And a
   * partition keeps provider cookies out of the store the rest of the app uses.
   */
  const partition = `player-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const view = new WebContentsView({
    webPreferences: {
      preload: join(dirname, '../preload/player.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
      autoplayPolicy: 'no-user-gesture-required',
      partition,
    },
  })

  /**
   * The URL to actually navigate to, for a given provider URL.
   *
   * Kept as one function so no navigation path can forget the shell. The
   * *candidate* URLs stay unwrapped everywhere else — the outcome log, the
   * source picker and the resume key all key off the provider's own URL, and
   * wrapping them would change what those mean.
   */
  const framed = (providerUrl: string): string => options.frameUrl?.(providerUrl) ?? providerUrl

  const contents = view.webContents
  contents.setBackgroundThrottling(false)
  refusePopupsAndDownloads(contents)
  // Black rather than white: an embed page paints its own background late, and
  // a white flash between the app and the video is the most jarring thing a
  // player can do.
  view.setBackgroundColor('#000000')

  let closed = false
  /** Shrunk into the app's corner; see `setMini`. */
  let mini = false
  /** Held while the detail view's preview stands in; see "Held" below. Null for an ordinary start. */
  const carry = options.held ? new CarryOver(Date.now()) : null
  const held = (): boolean => carry !== null && !carry.done
  /** The slot the renderer last asked for; the view is there unless held. */
  let slot: PlayerBounds = bounds

  const player: InlinePlayer = {
    carryTo: () => {},
    carryEnd: () => {},
    held: () => false,
    session: contents.session,
    context,
    candidates,
    candidateIndex: 0,
    exhausted: [],
    switchTo: () => false,
    keepWaiting: () => {},
    acceptSuggestion: () => false,
    // Replaced below, once the view exists to press into.
    pressPlay: async () => {},
    setBounds: () => {},
    setMini: () => {},
    setPaused: () => {},
    // Replaced once the overlay exists; until then there is nothing to tell.
    notifyChrome: () => {},
    goToEpisode: () => {},
    reload: () => {},
    setMuted: () => {},
    position: () => null,
    takeProgressMs: () => 0,
    destroy: () => {},
    currentProviderId: () => null,
    // Replaced below, once the views they route to exist.
    action: () => {},
    refreshConfig: () => {},
    owns: () => false,
  }

  const currentCandidate = (): PlayCandidate | undefined => player.candidates[player.candidateIndex]

  /**
   * Whether the view is still there to be talked to.
   *
   * Every fallback path runs from a timer or an async event, and the user can
   * close the player at any point in between. Touching a destroyed
   * `webContents` — even reading `.session` — throws `TypeError: Object has
   * been destroyed`, and because these callbacks run outside any promise chain
   * that becomes an uncaught exception in the main process, which Electron
   * shows as a modal error dialog over the whole app.
   */
  const alive = (): boolean => !closed && !contents.isDestroyed()

  // Present as the provider's own site. Scoped to this view's partition, so
  // it applies to the embed and nothing else the app does.
  const applyIdentityFor = (candidate: PlayCandidate | undefined): void => {
    if (!candidate || !alive()) return
    applyProviderReferer(contents.session, candidate.provider.rootUrl)
  }
  applyIdentityFor(currentCandidate())

  blockAdverts(contents.session, () => currentCandidate()?.provider.rootUrl ?? null)

  // Read from the player rather than the captured argument: navigating to
  // another episode replaces `player.context`, and the controls must reflect
  // where the view actually is.
  const sendContext = (): void => {
    if (!alive()) return
    const candidate = currentCandidate()
    const context = {
      tmdbId: player.context.tmdbId,
      imdbId: player.context.imdbId,
      type: player.context.type,
      title: player.context.title,
      season: player.context.season,
      episode: player.context.episode,
      providerId: candidate?.provider.id ?? null,
      providerName: candidate?.provider.name ?? null,
      providers: player.candidates.map((c) => ({ id: c.provider.id, name: c.provider.name })),
    }
    contents.send(EV.playerContext, context)
    // The floating chrome is a different document and needs the same facts —
    // it is the thing drawing the title, the position and the source list now.
    if (overlay !== null && !overlay.webContents.isDestroyed()) {
      overlay.webContents.send(EV.playerContext, context)
    }
  }

  /** The offer on screen, if any, so accepting it knows what it offered. */
  let pendingSuggestion: PlayerSuggestion | null = null

  /**
   * Raise or withdraw the "that source failed, try another" offer.
   *
   * It goes to the floating chrome and nowhere else. It used to go to the app
   * window, which could only render it by reserving a band of layout above the
   * video — and that reservation is what pushed the picture down every time a
   * provider failed. The chrome is the layer that can draw over the video, so
   * the offer lives there and the picture keeps its size.
   */
  const announceSuggestion = (suggestion: PlayerSuggestion | null): void => {
    pendingSuggestion = suggestion
    options.onSuggest?.(suggestion)
    if (overlay !== null && !overlay.webContents.isDestroyed()) {
      overlay.webContents.send(EV.playerSuggestion, suggestion)
    }
  }

  /**
   * Tell the app window when the pointer is up near the chrome bar.
   *
   * ## Why this listens to the view instead of the page
   *
   * The bar hides itself while you are watching and has to come back when you
   * reach for it, and *neither renderer can see the pointer do that*. The app
   * window cannot, because this view is a native layer over it that swallows
   * every mouse event inside its rectangle. The view's own preload could not
   * either: it runs in the top document, while an embed plays the video inside
   * a nested cross-origin iframe, and mouse events in that iframe never reach
   * the parent.
   *
   * That second half is why the first attempt looked correct and did nothing.
   * Moving the mouse over the video produced no report from anybody, so the
   * last value stood — and since the only way to reach the video is through the
   * top of the window, the value it got stuck on was "near the top". The bar
   * stayed open forever, which is the bug this replaces.
   *
   * `input-event` is the browser's own stream for this view, delivered before
   * the page sees it, in coordinates relative to the window's content area.
   *
   * ## And it is not enough on its own
   *
   * This was once described here as a stream no frame could hide an event
   * from. That is false. Chromium hit-tests the first move and then routes
   * pointer events straight to the target widget, and on a playing embed the
   * target is the provider's cross-origin iframe — which has its own widget
   * and does not report here. Measured: driving the pointer from the middle of
   * the picture to the top edge produced one report, for the position where it
   * entered, and nothing afterwards. So the bar was never summoned at all, and
   * nothing in any log said why.
   *
   * What remains true is that this covers the parts of the view that are *not*
   * the embed — the letterbox bars, the shell before the frame loads. That is
   * worth keeping, so it stays; it is simply no longer the mechanism the bar
   * depends on. `PlayerChrome.svelte` keeps a live strip along the top edge
   * and that is what actually makes the chrome reachable.
   *
   * `screen.getCursorScreenPoint()` was tried first and is not usable here:
   * measured on this machine it stops updating once the view is on top, so it
   * kept reporting the position the pointer held before playback began.
   *
   * The zone is 90px against a 52px bar, so the band just below the bar still
   * counts as reaching for it — a pointer aimed at a button rarely lands on the
   * first try, and a bar that closes as you approach is worse than one that
   * lingers.
   *
   * The decision itself is in `pointerzone.ts`, and so are its tests. What is
   * left here is the wiring: the raw stream in, an IPC message out.
   */
  const pointerZone = createPointerZoneWatcher({ topZonePx: 90, repeatMs: 300 })

  const forward = (report: boolean | null): void => {
    if (report === null) return
    if (!win.isDestroyed()) win.webContents.send(EV.playerPointerTop, report)
    /*
      And to the overlay, which cannot work this out for itself.

      The chrome hides by shrinking to nothing, and a view with no height
      receives no mouse events — so once hidden it can never see the pointer
      come back. The signal has to arrive from the view that still covers the
      picture.
    */
    if (overlay !== null && !overlay.webContents.isDestroyed()) {
      overlay.webContents.send(EV.playerPointerTop, report)
    }
  }

  /**
   * `WTA_POINTER_LOG=1` prints every pointer report.
   *
   * Kept because the failure mode here is silence: if these events stop
   * arriving the bar simply never appears, with nothing in any log to say so,
   * and the obvious explanations (the overlay, the CSS, the IPC) are all
   * downstream of the question this answers.
   */
  const pointerLog = process.env.WTA_POINTER_LOG === '1'

  contents.on('input-event', (_event, input) => {
    const now = Date.now()
    if (input.type === 'mouseMove') {
      // `x`/`y` are only on the mouse variants of the union, and the event is
      // typed as the union.
      const { x, y } = input as unknown as { x: number; y: number }
      const report = pointerZone.move(x, y, now)
      if (pointerLog) console.log(`[pointer] ${x},${y} -> ${String(report)}`)
      forward(report)
      return
    }
    if (input.type === 'mouseLeave') forward(pointerZone.leave(now))
  })

  contents.on('did-finish-load', sendContext)
  contents.on('did-navigate-in-page', sendContext)

  keepProviderInPlace(contents, () => currentCandidate()?.url ?? null)

  /* ── v2: the film relay, and what the shell is told ────────────────────── */

  /**
   * The shell's origin: the one parent the outermost provider frame's relay
   * will take commands from. Null when there is no shell (`frameUrl` unset,
   * a dev build without the local server), and then there are no own
   * controls either.
   */
  const shellOrigin = ((): string | null => {
    try {
      const url = options.frameUrl?.('https://example.invalid/')
      return url ? new URL(url).origin : null
    } catch {
      return null
    }
  })()
  const relayScript = shellOrigin === null ? null : filmRelayScript(shellOrigin)

  if (relayScript !== null) installFilmRelay(contents, relayScript)

  /** A source change to announce once the next shell is up; see `advance`. */
  let pendingChange: { providerId: string; providerName: string; reason: string } | null = null
  /** Whether the bar is up, as the chrome last said; the shell's controls follow it. */
  let barState: BarState = { visible: true, away: false }
  /** The episode strip is open, as the chrome last said; see `player.action`. */
  let episodesOpen = false
  /** The source list is open, as the chrome last said; see `player.action`. */
  let sourcesOpen = false

  const sendConfig = (): void => {
    if (!alive()) return
    contents.send(EV.playerOverlayConfig, {
      ownControls: options.ownControls?.() ?? false,
      fullscreen: !win.isDestroyed() && win.isFullScreen(),
      mini,
      subtitleLanguage: options.subtitleLanguage?.() ?? null,
      held: carry !== null && !carry.done ? { muted: carry.last()?.muted ?? false } : null,
    })
  }
  // However fullscreen was entered or left: F, Escape, the window manager, the menu.
  win.on('enter-full-screen', sendConfig)
  win.on('leave-full-screen', sendConfig)

  /**
   * On the shell's DOM being ready, not on `did-finish-load`: the latter waits
   * for the provider's iframe to finish loading, adverts and all, and the
   * controls would sit unconfigured meanwhile.
   */
  contents.on('dom-ready', () => {
    sendConfig()
    contents.send(EV.playerBarState, barState)
    if (pendingChange !== null) {
      contents.send(EV.playerProviderChanged, pendingChange)
      pendingChange = null
    }
  })
  player.refreshConfig = sendConfig
  player.owns = (candidate) => candidate === contents

  /**
   * The success signal, and the only honest one.
   *
   * Every other event here reports a *failure* — a bad status, a failed API
   * call, a dead load. None of them can say a provider worked, because a page
   * that loads cleanly and never plays anything looks identical to one that
   * plays. `media-started-playing` fires when Chromium begins decoding, in any
   * frame, however the bytes arrived; it is the same evidence the provider
   * probe uses, and it cannot be produced by a page that is not playing.
   *
   * This is what makes "Automatic" learn instead of guess.
   */
  contents.on('media-started-playing', () => {
    // The page being left, playing again before the new one took over.
    if (!committed) return
    const candidate = currentCandidate()
    if (candidate && !streamReported) {
      streamReported = true
      reportOutcome(candidate.provider.id, 'stream')
    }
    if (candidate) noteStreamed(candidate.provider.id)
    // It worked. Nothing pending against this provider is valid any more, and
    // any offer to leave it must be withdrawn — an offer still on screen after
    // the video started is worse than never having made one.
    playing = true
    if (playingSince === null) playingSince = Date.now()
    // Sooner than the next poll; the poll carries on from there.
    setTimeout(() => {
      const asked = loadAsked()
      void readPosition().then((found) => {
        if (found && stillOnScreen(asked)) stepResume(found)
      })
    }, SEEK_SETTLE_MS)
    // Nothing further can be recorded against this load: it demonstrably works.
    failureRecorded = true
    clearPendingVerdicts()
    announceSuggestion(null)
  })

  /**
   * The three timers and the flags they read.
   *
   * `playing` is the only fact that matters — every timer below exists to ask
   * "has anything played yet", and every one of them is void the moment
   * something has. `waitingOut` is the user answering "keep waiting" for the
   * provider at that index, which must survive the page's own reloads without
   * surviving a switch to a different source.
   */
  let playing = false
  let waitingOut = -1

  /**
   * How long this episode has actually been playing.
   *
   * Opening a player used to be what counted as watching, which marked
   * anything watched the moment you pressed play — so browsing through a few
   * titles ticked them all off. What is needed instead is evidence that a
   * substantial part of it was seen, and the only evidence available is time.
   *
   * The embed is a cross-origin iframe inside a native view, so its
   * `currentTime` is unreachable — no script of ours runs in that document.
   * What Chromium does tell us is when decoding starts and stops, in any
   * frame. Summing the intervals between those gives elapsed *playing* time,
   * which is not the same as position in the file — a seek forward does not
   * count, a rewatch of the first half twice does — but it is honest about the
   * thing being asked: how much of this did you sit through.
   */
  let playedMs = 0
  let playingSince: number | null = null

  const stopCounting = (): void => {
    if (playingSince === null) return
    playedMs += Date.now() - playingSince
    playingSince = null
  }

  // Fires on a real pause, on the end of the media, and when the page tears the
  // element down — every way playing can stop.
  contents.on('media-paused', stopCounting)

  /**
   * The provider's own playback position, polled.
   *
   * There is no event for "the position moved", so this asks. Every frame is
   * tried because providers nest the player in iframes and which one holds the
   * video differs per provider and sometimes per load.
   *
   * Two and a half seconds: the position is saved every second poll (five
   * seconds, see `PERSIST_EVERY_MS`), and the end of an episode, which starts
   * auto-next, is noticed within a poll of the last frame.
   * It was four until auto-next needed the end sooner; faster than this runs
   * script in every frame of an untrusted page for nothing anyone would notice.
   */
  const POSITION_POLL_MS = 2_500

  let lastPosition: VideoPosition | null = null

  /**
   * How long to wait for one frame to answer.
   *
   * Some frames never do. An ad frame, or one mid-navigation, can leave
   * `executeJavaScript` pending forever — it neither resolves nor rejects. The
   * first version asked each frame in turn and awaited the answer, so one such
   * frame wedged the whole poll: it logged a single result and then nothing
   * again for the rest of the session, and every position was lost.
   */
  const FRAME_REPLY_TIMEOUT_MS = 1_500

  /**
   * Ask one frame, surviving every way it can refuse to answer.
   *
   * Three of them, and each had to be handled separately:
   *
   * - It rejects. Ordinary — the frame is mid-navigation.
   * - It never settles. An ad frame can leave the call pending forever, hence
   *   the race.
   * - **It throws synchronously.** `executeJavaScript` on a frame whose render
   *   frame has already been disposed does not return a rejected promise, it
   *   throws where it is called. Inside a `.map()` that escapes the mapping
   *   entirely, so `Promise.all` is never constructed and the whole poll
   *   rejects. With no handler on the timer, that killed polling for the rest
   *   of the session after the first disposed frame: one reading was logged and
   *   then nothing, and every resume position was lost.
   */
  const askFrame = (frame: Electron.WebFrameMain): Promise<unknown> => {
    let call: Promise<unknown>
    try {
      call = frame.executeJavaScript(READ_POSITION_SCRIPT, false)
    } catch {
      return Promise.resolve(null)
    }
    return Promise.race([
      call.catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), FRAME_REPLY_TIMEOUT_MS)),
    ])
  }

  const readPosition = async (): Promise<VideoPosition | null> => {
    if (!alive()) return null

    let frames: Electron.WebFrameMain[]
    try {
      frames = contents.mainFrame.framesInSubtree
    } catch {
      // The whole view went away between the timer firing and this line.
      return null
    }

    // Asked together rather than in turn, so a frame that never replies costs
    // one timeout instead of blocking every frame behind it.
    const replies = await Promise.all(frames.map(askFrame))

    for (const raw of replies) {
      if (typeof raw !== 'string') continue
      try {
        const parsed = JSON.parse(raw) as VideoPosition
        if (Number.isFinite(parsed.seconds) && parsed.duration > 0) return parsed
      } catch {
        // Not our shape. A provider that never answers simply has no position,
        // and the elapsed-time fallback covers it.
      }
    }
    return null
  }

  /**
   * Providers already caught serving something else, for this view.
   *
   * Judged once per provider rather than on every poll: the duration does not
   * change, so re-deciding it every four seconds would write the same verdict
   * repeatedly into the outcome log and weight one title far more heavily than
   * any other evidence.
   */
  const runtimeJudged = new Set<string>()

  /**
   * Notice when the provider is playing something other than what was asked
   * for.
   *
   * The outcome is recorded but playback is deliberately *not* interrupted.
   * This is a heuristic on an approximate figure, and yanking the user out of a
   * programme that may well be the right one is a worse failure than letting a
   * wrong one run while the provider quietly loses its ranking.
   */
  const judgeRuntime = (position: VideoPosition): void => {
    const candidate = currentCandidate()
    if (candidate === undefined) return
    if (runtimeJudged.has(candidate.provider.id)) return

    const result = checkRuntime({
      deliveredSeconds: position.duration,
      expectedMinutes: player.context.runtimeMinutes,
    })
    if (result.verdict === 'unknown') return

    runtimeJudged.add(candidate.provider.id)
    if (result.verdict === 'plausible') return

    console.log(
      `[runtime] ${candidate.provider.id} served the wrong length for ` +
        `"${player.context.title}": ${result.reason}`,
    )
    options.reportOutcome?.(candidate.provider.id, 'failed')
  }

  /**
   * Has the picture frozen?
   *
   * Armed by `beginLoad` and read on every poll. The decision itself is in
   * `playbackstall.ts`; what lives here is the part that needs the view.
   */
  let stallWatch: StallWatch = beginStallWatch(Date.now())

  /**
   * Notice a stream that died after it started working.
   *
   * Only runs once something has played, which is what makes it worth having:
   * every other detector in this file gives up at exactly that moment, so a
   * segment that 404s twenty minutes in is currently a frozen picture and no
   * response of any kind.
   *
   * It *offers* rather than switches, for the same reason the other ambiguous
   * signals do — and here more so, because the user is mid-episode and being
   * moved somewhere else without being asked would be worse than the freeze.
   */
  const watchForStall = (found: VideoPosition | null): void => {
    if (!alive() || !playing) return

    const now = Date.now()
    const observation = observeStall(stallWatch, found, now)
    const frozenFor = frozenSeconds(observation.watch, now)
    stallWatch = observation.watch
    if (!observation.stalled) return

    const name = currentCandidate()?.provider.name ?? 'This source'
    console.warn(`[player] ${name} froze ${frozenFor}s into a stall; offering to switch`)

    /**
     * It is not playing any more, and saying so is what makes the rest work.
     *
     * `suggest` refuses outright while `playing`, by design — a late API error
     * must not interrupt a working video. A frozen one is not a working video,
     * so the honest fix is to correct the flag rather than to add a bypass
     * around the guard. `stopCounting` follows for the same reason: a frozen
     * picture should stop counting as time watched.
     */
    playing = false
    stopCounting()
    /**
     * Deliberately re-opened. `media-started-playing` closes it with "nothing
     * further can be recorded against this load: it demonstrably works", which
     * was true until the stream died. A provider that plays for a minute and
     * then stops has earned the `failed` alongside its `stream`, and the
     * ranking should see both.
     */
    failureRecorded = false
    suggest(`${name} stopped part-way through`, 'stall')
  }

  /* ── Skip buttons ─────────────────────────────────────────────────────── */

  /**
   * Skip intro, skip recap, and next episode over the credits: `skipwatch.ts`
   * decides, from every reading; this view only draws the button and seeks.
   */
  const skipWatch = new SkipWatch({
    enabled: () => options.skipIntro?.enabled() ?? false,
    expectedMinutes: () => player.context.runtimeMinutes,
    lookup: (streamSeconds) => {
      const context = player.context
      return findSegments(
        {
          tmdbId: context.tmdbId,
          imdbId: context.imdbId,
          season: context.season,
          episode: context.episode,
          streamSeconds,
        },
        { animeId: options.skipIntro?.animeId ?? (async () => null) },
      )
    },
    hasNext: async () => options.skipIntro?.hasNext(player.context) ?? false,
    announce: (offer) => {
      if (skipView === null || skipView.webContents.isDestroyed()) return
      skipView.webContents.send(EV.playerSkipOffer, offer)
    },
    log: (line) => console.log(line),
  })

  /** Raise or withdraw the button for one position reading. */
  const offerSkip = (found: VideoPosition | null): void => {
    if (!alive()) return
    skipWatch.reading(found && { seconds: found.seconds, duration: found.duration })
  }

  const positionTimer = setInterval(() => {
    const asked = loadAsked()
    // The catch is load-bearing: an unhandled rejection here stops nothing in
    // Node, but it means `lastPosition` silently stops updating. Better to lose
    // one reading than the rest of the session's.
    void readPosition()
      .then((found) => {
        // Asked of the page being left, or of a player since closed: its place
        // is not the new load's, nor the next title's. See `loadNumber`.
        if (!stillOnScreen(asked)) return
        // Before the early return, because a reading that is *missing* while
        // playback is under way is the strongest stall evidence there is: the
        // element has gone, which is what a torn-down player looks like.
        watchForStall(found)
        offerSkip(found)
        if (!found) return
        if (carry === null || carry.done) stepResume(found)
        notePicture(found)
        lastPosition = found
        judgeRuntime(found)
        maybePersist(found)
        options.onPositionRead?.(found)
      })
      .catch(() => {})
  }, POSITION_POLL_MS)

  /**
   * Hand a reading to the host, but not on every poll.
   *
   * Every five seconds, which is every second poll: the most anyone loses to
   * a crash, and the pace at which the position reaches the other device
   * through the positions file (`sync/positions.ts`). It was thirty seconds
   * until 1.9.8, when the owner asked for positions to cross devices within
   * seconds. A paused video writes nothing — see `WrittenPositions`.
   */
  const PERSIST_EVERY_MS = 5_000
  let lastPersistedAt = 0

  const maybePersist = (found: VideoPosition): void => {
    if (resume.pending()) return
    const now = Date.now()
    if (now - lastPersistedAt < PERSIST_EVERY_MS) return
    lastPersistedAt = now
    options.onPosition?.(found)
  }

  /**
   * Put the video back where it was left.
   *
   * Deliberately late and deliberately checked. `media-started-playing` only
   * says decoding began; the element's duration and seekable range often
   * arrive a beat later, and a seek before then is silently ignored. So every
   * reading is fed to this load's `ResumeSeek`, which seeks, looks again,
   * retries, waits out an advert, and leaves alone a provider that has put
   * the video there itself. Until 2.0.6 this sought once and never looked.
   */
  const SEEK_SETTLE_MS = 1_500

  /**
   * This load's resume. Per *load*, not per player: every navigation arms a
   * new one (`armResume`), or every later load would start at zero.
   *
   * While it is `pending`, the film's time is where the provider put it, so
   * nothing is saved from it (`maybePersist`, `player.position`).
   */
  let resume = new ResumeSeek(options.resumeAt ?? 0, options.context.runtimeMinutes)

  /**
   * Settle the position being left and arm the one being loaded.
   *
   * Called by every path that navigates. Returning zero — no host, or nothing
   * worth resuming — simply means the next load starts at the beginning.
   */
  const armResume = (reason: NavigationReason): void => {
    resume = new ResumeSeek(options.onNavigate?.(reason) ?? 0, player.context.runtimeMinutes)
  }

  const stepResume = (found: VideoPosition): void => {
    if (!alive()) return
    const to = resume.next({ seconds: found.seconds, duration: found.duration }, Date.now())
    if (to !== null) seekTo(to)
  }

  /**
   * Jump the provider's video to a position.
   *
   * Every frame is asked, because which one holds the player differs per
   * provider and the script picks the largest video with a real duration
   * wherever it runs. Shared by the resume seek and the skip-intro button:
   * they are the same operation with different reasons.
   */
  function seekTo(seconds: number): void {
    if (!alive()) return
    let frames: Electron.WebFrameMain[]
    try {
      frames = contents.mainFrame.framesInSubtree
    } catch {
      // The whole view went away between the caller's check and this line.
      return
    }
    for (const frame of frames) {
      try {
        void frame.executeJavaScript(seekScript(seconds), false).catch(() => {})
      } catch {
        // Disposed between listing the frames and this call; see `askFrame`.
      }
    }
  }
  /**
   * Whether this load has already been written down as a failure.
   *
   * Recording happens where the verdict is *formed* — in `suggest` — rather
   * than only where the player moves on. That distinction used to not matter,
   * because forming a verdict and switching were the same act. Now that a
   * verdict raises a prompt instead, `advance` runs only for dead hosts, and
   * recording there alone left the outcome log empty: the source picker's dots
   * had nothing to colour and the ranking had nothing to learn from.
   */
  let failureRecorded = false
  /**
   * Whether this load has told the outcome log that it streams, reset by
   * `beginLoad`. `media-started-playing` fires again on every resume after a
   * pause, and each report was a record with a new time: a whole-library
   * write and, eight seconds later, a whole-library upload to Drive, for
   * every unpause. The log needs one per load; the phone already sent one.
   */
  let streamReported = false
  let silenceTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * What this load has shown of its stream, reset by `beginLoad`. Read when
   * the silence timer fires, to tell a source waiting for its play button from
   * one that never found anything — see `streamResolved`.
   */
  let evidence: LoadEvidence = { playlistOk: false, videoOk: false, refusedStatus: null, videoElement: false }
  /** The first failure the provider's own backend reported this load, for the offer's wording. */
  let backendFailure: string | null = null
  /** Its status, for the test results. */
  let backendStatus: number | null = null
  /** When the page last finished a request, of any kind. See `judgeSilence`. */
  let lastActivityAt = Date.now()
  /**
   * The silence check found the page idle with nothing wrong — most likely a
   * poster waiting to be clicked. The next request it finishes starts the
   * grace period over, so a click that leads nowhere is still caught.
   */
  let idleSinceCheck = false
  /** Requests sent and not yet answered, by id. See `PageActivity.pendingRequests`. */
  const inFlight = new Set<number>()

  const clearPendingVerdicts = (): void => {
    if (silenceTimer) {
      clearTimeout(silenceTimer)
      silenceTimer = null
    }
  }

  /**
   * The backstop: nothing has played and nothing has complained.
   *
   * This one stays long, and it is a different kind of thing from the signals
   * around it. A failed backend call is the provider *telling* us it cannot
   * serve this, so that prompt is immediate. Silence is not a verdict — it is
   * the absence of one, and the only way to turn it into a verdict is to wait.
   * Cut it short and the prompt fires over a provider that was about to work,
   * which is the behaviour the switching logic was criticised for.
   */
  const SILENCE_GRACE_MS = 25_000

  /* ── What this load measured, for the test results ──────────────────── */

  /** When the current load began; reset by `beginLoad`. */
  let loadStartedAt = Date.now()
  /**
   * The page this load asked for has replaced the one before it.
   *
   * Until it has (`did-navigate`), the page being left is still alive: its
   * video can start again after a stall, and its position can still be read.
   * Until 2.0.9 both counted for the new load, so a switch to a source that
   * then failed could be filed as streaming a fraction of a second after it
   * was asked for (the owner, 2026-09-30: sources that "load in under 1 s"),
   * and the old episode's place written under the new one.
   */
  let committed = true
  /**
   * Which load the view is on: bumped by `beginLoad`, and noted by every
   * reading when it is *asked for* (`loadAsked`).
   *
   * Checking `committed` when an answer arrived was not enough. A frame of a
   * page being left never answers a pending `executeJavaScript` (measured on
   * Electron 42.5.0), so a poll that straddles a navigation resolves only at
   * its frames' 1.5 s timeout, and by then the next page has committed — the
   * local shell commits within milliseconds. The episode being left was then
   * filed as the one stepped to, and settled the new episode's resume as
   * "already past it", so its own saved place was overwritten from zero. And
   * a poll still out when the player closed reported after it was gone,
   * which the host filed under whatever played next.
   */
  let loadNumber = 0
  /** The load a reading asked now is of, or null when it can only be the page being left. */
  const loadAsked = (): number | null => (committed && !closed ? loadNumber : null)
  /** Whether a reading asked as `asked` is still about what is on screen. */
  const stillOnScreen = (asked: number | null): boolean => asked !== null && asked === loadNumber && !closed
  /**
   * What this load has told the test results: a success, improved as the
   * picture does and once more when the player's own list of qualities
   * answers, or a failure the source's servers declared. Once per load,
   * except that a load which plays after a declared failure is a success.
   */
  let measured: {
    providerId: string
    at: number
    streamed: boolean
    ms?: number
    quality?: number
    qualityKind?: QualityKind
    audio?: string[]
  } | null = null
  /**
   * How long into playing the picture still counts toward the play's
   * quality. Adaptive streams start low and climb; a minute is enough for
   * them to reach what the connection allows, and the result then stays put.
   */
  const PICTURE_WINDOW_MS = 60_000
  /**
   * The top of the source's own list, told before this load was filed as
   * streaming; filed with it when it is (`noteStreamed`). Measured live on
   * VidSrc (2026-10-09): the shell saw the film's time move and asked for
   * the list before `media-started-playing` reached here, and the shell asks
   * only once, so dropping the early answer lost the play's offer for good.
   */
  let heldOffer: { quality: number; audio: string[] } | null = null

  const noteStreamed = (providerId: string): void => {
    if (measured?.streamed) return
    const at = Date.now()
    const ms = at - loadStartedAt
    // Past the silence check, the wait included the user: see `PLAY_TIMING_MAX_MS`.
    measured = { providerId, at, streamed: true, ...(ms <= PLAY_TIMING_MAX_MS ? { ms } : {}) }
    const offered = heldOffer === null ? null : withPlayOffer(measured, heldOffer)
    heldOffer = null
    if (offered !== null) measured = offered
    options.reportResult?.(providerId, {
      at,
      streamed: true,
      ...(measured.ms === undefined ? {} : { ms: measured.ms }),
      ...(measured.quality === undefined ? {} : { quality: measured.quality, qualityKind: measured.qualityKind ?? 'floor' }),
      ...(measured.audio === undefined ? {} : { audio: measured.audio }),
    })
  }

  /** The success again, under the same moment, so it replaces the result rather than adding one. */
  const refileStreamed = (success: NonNullable<typeof measured>): void => {
    options.reportResult?.(success.providerId, {
      at: success.at,
      streamed: true,
      ...(success.ms === undefined ? {} : { ms: success.ms }),
      ...(success.quality === undefined ? {} : { quality: success.quality, qualityKind: success.qualityKind ?? 'floor' }),
      ...(success.audio === undefined ? {} : { audio: success.audio }),
    })
  }

  /**
   * The picture, as a floor under the source's best: an adaptive player
   * starts low and climbs, so the best of the first minute is kept. Never
   * over the source's own list (`noteOffered`); see `withQualityReading`.
   */
  const notePicture = (found: VideoPosition): void => {
    if (!measured?.streamed || !found.height || found.duration < PLAY_MIN_FILM_SECONDS) return
    if (Date.now() - measured.at > PICTURE_WINDOW_MS) return
    const quality = qualityClass({ width: found.width ?? null, height: found.height })
    const better = withQualityReading(measured, { quality, kind: 'floor' })
    if (better === null) return
    measured = better
    refileStreamed(better)
  }

  /**
   * The top of the source's own list of qualities, from the shell's controls
   * once the film plays (`WtaPlayerApi.offered`): filed with this play as
   * what the source offers.
   *
   * Before this load is filed as streaming it is held (`heldOffer`): the
   * shell can see the film's time move before the decoder's start reaches
   * here. Before the new page has committed, it can only be the page being
   * left, and is dropped.
   */
  const noteOffered = (offer: { quality: number; audio: string[] }): void => {
    if (!committed || closed) return
    if (!measured?.streamed) {
      heldOffer = offer
      return
    }
    const better = withPlayOffer(measured, offer)
    if (better === null) return
    measured = better
    refileStreamed(better)
  }


  /** The next provider we have not tried, or undefined if there is none. */
  const nextUntried = (): PlayCandidate | undefined => {
    const tried = new Set(player.exhausted.map((e) => e.providerId))
    return player.candidates.find((c) => !tried.has(c.provider.id) && c !== currentCandidate())
  }

  /**
   * Offer to change source — the only way this player changes source by itself.
   *
   * Every automatic switch goes through here and its countdown, which the user
   * can refuse; `mayAutoSwitch` decides whether the countdown runs at all.
   * Failures that used to switch outright (`advance`) come through here too:
   * one of those was a *sub-frame* failing, which moved the user off videos that
   * were playing without asking, and without the bar ever appearing.
   */
  const suggest = (reason: string, kind: OfferKind, cause?: ScanReason): void => {
    if (!alive() || playing) return

    const current = currentCandidate()
    if (!current) return

    /**
     * Write the failure down even if we go no further.
     *
     * Before the suppression checks below, deliberately: a user who chose to
     * keep waiting, or who has nowhere else to go, has still learned that this
     * source did not serve this title — and that is exactly what the picker's
     * red dot and the "Automatic" ranking are built from.
     */
    if (!failureRecorded) {
      failureRecorded = true
      reportOutcome(current.provider.id, 'failed')
    }
    if (cause !== undefined && measured === null) {
      measured = { providerId: current.provider.id, at: Date.now(), streamed: false }
      options.reportResult?.(current.provider.id, { at: measured.at, streamed: false, reason: cause })
    }

    if (waitingOut === player.candidateIndex) return

    const next = nextUntried()
    if (!next) {
      // Nowhere to go. Say so in the page rather than offering a choice of one.
      giveUp(reason)
      return
    }

    announceSuggestion({
      reason,
      providerName: current.provider.name,
      nextProviderId: next.provider.id,
      nextProviderName: next.provider.name,
      autoSwitch: mayAutoSwitch(kind, options.testedWorking?.(current.provider.id) ?? false),
    })
  }

  /**
   * Nothing has played by the end of the grace period: decide what that means.
   *
   * The rule is `judgeSilence`; this is the wiring and the wording.
   */
  const checkSilence = (): void => {
    silenceTimer = null
    const name = currentCandidate()?.provider.name ?? 'This source'
    evidence.videoElement = lastPosition !== null
    const activity = { idleForMs: Date.now() - lastActivityAt, pendingRequests: inFlight.size }
    switch (judgeSilence(evidence, backendFailure !== null, activity)) {
      case 'resolved':
        console.log(`[player] ${name} has its stream ready and is not playing; not offering to switch`)
        return
      case 'waiting':
        idleSinceCheck = true
        console.log(
          `[player] ${name} is idle with nothing wrong (${Math.round(activity.idleForMs / 1000)} s); ` +
            'waiting for the user rather than offering to switch',
        )
        return
      case 'failing':
        suggest(
          evidence.refusedStatus !== null
            ? `${name} refused its own video (${evidence.refusedStatus})`
            : (backendFailure ?? `${name} has not started playing`),
          'silence',
          // Declared by the source's servers, so a result; silence alone is not.
          evidence.refusedStatus !== null
            ? { kind: 'refused', status: evidence.refusedStatus }
            : backendStatus !== null
              ? { kind: 'error', status: backendStatus }
              : undefined,
        )
        return
      case 'loading':
        console.log(`[player] ${name} is still loading (${activity.pendingRequests} requests unanswered)`)
        suggest(`${name} is still loading after ${Math.round(SILENCE_GRACE_MS / 1000)} s`, 'silence')
        return
    }
  }

  /**
   * Restart the clocks for a freshly-issued load.
   *
   * Called at every point that navigates the view. Not driven off
   * `did-start-navigation`, which fires for sub-frames — and these providers
   * load their player in an iframe, so a frame-driven reset would restart the
   * grace period several times per page and the timer would never fire.
   */
  const beginLoad = (): void => {
    playing = false
    failureRecorded = false
    streamReported = false
    clearPendingVerdicts()
    // Every caller is navigating to a *different* URL, so any "keep waiting"
    // the user set is about a page that is no longer loaded. A page reloading
    // itself does not come through here, which is what lets the choice survive
    // the retries these players do while resolving a stream.
    waitingOut = -1
    announceSuggestion(null)

    evidence = { playlistOk: false, videoOk: false, refusedStatus: null, videoElement: false }
    backendFailure = null
    backendStatus = null
    loadStartedAt = Date.now()
    committed = false
    loadNumber += 1
    measured = null
    heldOffer = null
    lastActivityAt = Date.now()
    idleSinceCheck = false
    // Whatever the previous page left open is aborted by the navigation.
    inFlight.clear()

    silenceTimer = setTimeout(checkSilence, SILENCE_GRACE_MS)

    stallWatch = beginStallWatch(Date.now())
    /**
     * A different episode has a different intro, and often none at all, and a
     * different source has a different cut: nothing known carries over.
     */
    skipWatch.reset()

    /**
     * Forget the last reading, because it was about the page being left.
     *
     * Every caller arms the resume *before* this runs, so the host has already
     * read and stored the outgoing position — what is left here is a number
     * that belongs to a stream no longer loaded. Keeping it made the next load
     * inherit it, and a provider with no reachable `<video>` inherited it for
     * good: stepping to episode 2 and closing the player wrote episode 1's
     * position against episode 2.
     */
    lastPosition = null
  }

  /**
   * Move to the next provider that has not already failed.
   *
   * This is the behaviour whose absence made a dead provider look like a dead
   * app: previously the first provider that produced a *well-formed URL* was
   * the only one ever tried, so a 500 from it ended the story. Returns false
   * when there is nothing left to try.
   */
  const advance = (reason: string): boolean => {
    // Nothing to fall back *to* if the view has gone.
    if (!alive()) return true
    const failed = currentCandidate()
    if (failed) {
      player.exhausted.push({ providerId: failed.provider.id, provider: failed.provider.name, reason })
      // Guarded, because `suggest` records the same verdict and both can run
      // for one load — a failed API call offers, and a dead host then advances.
      if (!failureRecorded) {
        failureRecorded = true
        reportOutcome(failed.provider.id, 'failed')
      }
    }

    /**
     * The next provider not yet *tried*, not simply the next in the list.
     *
     * Index order is wrong whenever the user has picked a source explicitly:
     * choosing the last candidate and having it fail would walk off the end and
     * give up, while the providers ahead of it — which were never attempted —
     * sit there untouched.
     */
    const tried = new Set(player.exhausted.map((e) => e.providerId))
    const nextIndex = player.candidates.findIndex((c) => !tried.has(c.provider.id))
    if (nextIndex < 0) return false

    // Before the index moves, same as a deliberate switch: this is still the
    // same episode, so the place it was left has to survive the fallback and
    // the new source has to be told where to pick up. Without this a provider
    // that crashed forty minutes in restarted the next one from zero.
    armResume('fallback')
    player.candidateIndex = nextIndex
    const next = player.candidates[nextIndex]!
    console.warn(
      `[player] ${failed?.provider.name ?? 'provider'} failed (${reason}); ` +
        `falling back to ${next.provider.name}`,
    )
    applyIdentityFor(next)
    // Held for the next shell rather than sent now: the shell on screen is
    // replaced by the `loadURL` below, and a message sent to it now would be
    // dropped with it. For a while no "switched source" toast ever appeared.
    pendingChange = { providerId: next.provider.id, providerName: next.provider.name, reason }
    beginLoad()
    void contents.loadURL(framed(next.url))
    options.onProviderChanged?.()
    return true
  }

  const giveUp = (reason: string): void => {
    if (!alive()) return
    void contents.executeJavaScript(renderFailureOverlay(reason, player.exhausted)).catch(() => {
      // The page may already be gone; there is nothing further to do.
    })
  }

  /**
   * An HTTP error status still "loads" successfully as far as Chromium is
   * concerned — `did-fail-load` never fires for a 500, the error page just
   * renders. That is why the reported 500 surfaced as a broken window instead
   * of a handled failure: nothing was watching the status code.
   */
  contents.on('did-navigate', (_event, navigatedUrl, httpResponseCode, httpStatusText) => {
    committed = true
    if (httpResponseCode < 400) return
    const reason = `HTTP ${httpResponseCode} ${httpStatusText}`.trim()
    console.error(`[player] ${navigatedUrl} returned ${reason}`)
    // The server answered and said no. That is a verdict, not a delay, so it
    // offers straight away rather than switching or waiting.
    suggest(reason, 'failure', { kind: 'error', status: httpResponseCode })
  })

  /**
   * Watch the provider's **own** API calls, not just the page load.
   *
   * This is the failure mode that actually bites. Providers are single-page
   * apps: the document loads with a clean 200 and then asks its own backend to
   * resolve a stream. When that call fails the page sits there showing a play
   * button that will never do anything, and every signal Electron surfaces at
   * the navigation level says the load succeeded.
   *
   * Measured example — MoviesAPI, The Wire S01E01:
   *
   *     200  Document  https://moviesapi.to/tv/tt0306414/1/1
   *     404  Fetch     https://moviesapi.to/api/vidora/v1/tv/tt0306414/1/1
   *
   * A catalogue gap, indistinguishable from a working provider unless the
   * sub-requests are watched. Detecting it is the difference between "this
   * provider does not have it, trying the next" and a black window.
   *
   * Scoped narrowly to keep false positives down: XHR/fetch only, the
   * provider's own origin only, and a grace period before acting so a page
   * that retries and recovers is left alone.
   *
   * It *offers* rather than switches. A failed backend call is strong evidence
   * and nothing more: some of these pages retry the same endpoint and recover.
   *
   * All three through `webrequesthub.ts`, never `webRequest` itself. Casting
   * watches this same session for the stream (`castcapture.ts`), and Electron
   * keeps one listener per event per session: registered directly, casting's
   * `onSendHeaders` replaced this one the moment the player opened, `inFlight`
   * never held anything, and a page stuck waiting on its backend read as idle.
   */
  const stopObserving = [
    observeSendHeaders(contents.session, (details) => {
      // A socket is open by design for as long as the page lives, and a video
      // holds its range request open while paused; neither is a load waiting on
      // an answer. See `PageActivity.pendingRequests`.
      if (details.resourceType === 'webSocket' || details.resourceType === 'media') return
      inFlight.add(details.id)
    }),
    observeErrors(contents.session, (details) => {
      inFlight.delete(details.id)
    }),
    observeCompleted(contents.session, (details) => onRequestCompleted(details)),
  ]

  function onRequestCompleted(details: Electron.OnCompletedListenerDetails): void {
    inFlight.delete(details.id)
    const candidate = currentCandidate()

    let providerOrigin: string | null = null
    if (candidate) {
      try {
        providerOrigin = new URL(candidate.provider.rootUrl).origin
      } catch {
        providerOrigin = null
      }
    }

    noteStreamEvidence(details)
    noteActivity()

    // The rule, and its reasoning, are in `switchoffer.ts` — extracted so the
    // cases that matter can be tested rather than waited for.
    if (
      !candidate ||
      !isProviderFailure({
        statusCode: details.statusCode,
        resourceType: details.resourceType,
        url: details.url,
        providerOrigin,
        playing,
      })
    ) {
      return
    }

    console.warn(`[player] ${details.url} → ${details.statusCode}`)
    // Named in the offer if nothing plays; not an offer of its own. See
    // `isProviderFailure` for why an immediate offer was wrong.
    backendFailure ??= `${candidate.provider.name} API returned ${details.statusCode}`
    backendStatus ??= details.statusCode
  }

  /**
   * The page finished a request. If it had gone idle, it is doing something
   * again — usually because the user clicked its poster — so give it a fresh
   * grace period and judge it afresh at the end of that.
   */
  const noteActivity = (): void => {
    lastActivityAt = Date.now()
    if (!idleSinceCheck || playing || silenceTimer) return
    idleSinceCheck = false
    silenceTimer = setTimeout(checkSilence, SILENCE_GRACE_MS)
  }

  /**
   * Keep `evidence` current from one completed response.
   *
   * The same classification the tests use (`mediaKind`), so the player and
   * "Test all sources" agree on what counts as a stream having arrived.
   */
  const noteStreamEvidence = (details: Electron.OnCompletedListenerDetails): void => {
    const header = (name: string): string => {
      const entry = Object.entries(details.responseHeaders ?? {}).find(([key]) => key.toLowerCase() === name)
      return String(entry?.[1]?.[0] ?? '')
    }
    const totalBytes = totalBytesOf(details.statusCode, header('content-range'), header('content-length'))
    const kind = mediaKind(details.url, details.resourceType, header('content-type'), totalBytes)
    if (kind === null) return
    if (details.statusCode < 400) {
      if (kind === 'playlist') evidence.playlistOk = true
      else evidence.videoOk = true
    } else if (kind !== 'playlist' && details.statusCode !== 429) {
      evidence.refusedStatus ??= details.statusCode
    }
  }

  /**
   * The provider page killed its own renderer.
   *
   * Not hypothetical and not rare: one measured probe run over ten titles
   * produced ninety-nine `Terminating renderer for bad IPC message` kills,
   * each preceded by Chromium rejecting a malformed origin the page tried to
   * navigate a frame to. Left unhandled, the view keeps its bounds and its
   * chrome and shows a dead grey rectangle — `did-fail-load` does not fire,
   * the navigation never failed, and if this happens after playback started
   * every other detector here has already stood down.
   *
   * A reload first, and only then a switch. A crash is frequently a transient
   * fault in a decoder or an out-of-memory in one frame, and reloading keeps
   * the user on the source they chose and comes back to where they were. A
   * *second* crash on the same source is a pattern rather than an accident,
   * and at that point the next provider is the better answer.
   */
  let crashedAt = -1
  contents.on('render-process-gone', (_event, details) => {
    // Our own teardown destroys the contents, so `alive` already covers it.
    // `clean-exit` is the renderer going away on purpose.
    if (!alive() || details.reason === 'clean-exit') return

    const candidate = currentCandidate()
    const name = candidate?.provider.name ?? 'The source'
    console.error(`[player] ${name} renderer gone: ${details.reason} (${details.exitCode})`)

    // Whatever it was doing, it is not doing it now.
    playing = false
    stopCounting()
    failureRecorded = false

    if (crashedAt !== player.candidateIndex) {
      crashedAt = player.candidateIndex
      if (candidate) reportOutcome(candidate.provider.id, 'failed')
      player.reload()
      return
    }

    // Twice on the same source: a pattern rather than an accident. Still an
    // offer, so the user sees the switch coming and can refuse it.
    suggest(`${name} crashed`, 'failure')
  })

  /**
   * A load that failed outright — but only the ones that are the source.
   *
   * `did-fail-load` fires for *every* frame, and these pages are full of ad
   * and tracking iframes, some of which the ad blocker cancels on purpose. This
   * handler used to treat any of them as the provider failing and switched on
   * the spot — no countdown, no check that anything was playing. Reproduced on
   * 2026-09-26: one failing iframe added to a playing VidRock moved the player
   * to ScreenScape instantly. That is the "switched without the bar" that was
   * reported.
   *
   * So only two frames count: our own shell (the main frame), and the
   * provider's document, which is the shell's direct child at the provider's
   * origin. And a failure there offers, like everything else.
   */
  contents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, failedUrl, isMainFrame, frameProcessId, frameRoutingId) => {
      // -3 ERR_ABORTED and the two navigation codes fire during normal redirects.
      if (errorCode === -3 || errorCode === -105 || errorCode === -106) return
      if (!isMainFrame && !isProviderDocument(failedUrl, frameProcessId, frameRoutingId)) return
      console.error(`[player] ${failedUrl} failed: ${errorCode} ${errorDescription}`)
      suggest(loadFailureReason(errorCode, errorDescription, currentCandidate()?.provider.name ?? 'The source'), 'failure')
    },
  )

  /** Whether a frame is the provider's own document: the shell's child, at the provider's origin. */
  const isProviderDocument = (url: string, processId: number, routingId: number): boolean => {
    const candidate = currentCandidate()
    if (!candidate || !isSameOrigin(url, candidate.url)) return false
    const frame = webFrameMain.fromId(processId, routingId)
    return frame !== undefined && frame !== null && frame.parent === contents.mainFrame
  }

  /** The user picking a source explicitly, from the in-player switcher. */
  const switchTo = (providerId: string): boolean => {
    const index = player.candidates.findIndex((c) => c.provider.id === providerId)
    if (index < 0) return false
    // Before the index moves: the host reads the position off the source being
    // left, and the same call says where the new one should pick up.
    armResume('provider')
    player.candidateIndex = index
    const candidate = player.candidates[index]!
    applyIdentityFor(candidate)
    // A deliberate switch clears any "keep waiting" the user set: they set it
    // against the source they were watching, and this is a different one.
    beginLoad()
    void contents.loadURL(framed(candidate.url))
    options.onProviderChanged?.()
    return true
  }

  player.switchTo = switchTo

  /**
   * "Switch now", or the countdown running out.
   *
   * Through `advance`, not `switchTo`, because accepting an offer is a verdict
   * on the source being left: it joins `exhausted`, so the next offer cannot
   * point back at it. Taking the offer used to go through `switchTo` like a
   * pick from the menu, which marked nothing — reproduced on 2026-09-26 as
   * VidLux → CinemaOS at 11 s → VidLux again at 41 s, round and round.
   */
  player.acceptSuggestion = (): boolean => {
    if (!pendingSuggestion) return false
    const { reason } = pendingSuggestion
    announceSuggestion(null)
    if (!advance(reason)) giveUp(reason)
    return true
  }

  /**
   * "Keep waiting."
   *
   * Records the *index*, not a boolean, so it lapses the moment playback moves
   * to a different source — a user who waited out MoviesAPI has said nothing
   * about VidFast. It survives the current page reloading itself, which these
   * players do while resolving a stream, because the index does not change.
   */
  player.keepWaiting = (): void => {
    waitingOut = player.candidateIndex
    clearPendingVerdicts()
    announceSuggestion(null)
  }
  player.currentProviderId = (): string | null => currentCandidate()?.provider.id ?? null

  player.pressPlay = async (): Promise<void> => {
    if (!alive()) return
    const { width, height } = view.getBounds()
    await pressPlayIn(contents, width, height)
  }

  player.setBounds = (next: PlayerBounds): void => {
    if (closed || win.isDestroyed()) return
    slot = next
    // Rounded because Electron wants integer device-independent pixels and the
    // renderer measures fractional CSS pixels; a fractional bound is silently
    // truncated, which drifts the video a pixel off its slot per resize.
    view.setBounds({
      // Held: just left of the window, at its real size (see "Held" below).
      // The overlay and the skip button are laid out from this view, so they
      // go with it.
      x: held() ? HELD_SLIVER - Math.round(next.width) : Math.round(next.x),
      y: Math.round(next.y),
      width: Math.max(1, Math.round(next.width)),
      height: Math.max(1, Math.round(next.height)),
    })
    placeOverlay(overlayArea)
    placeSkip()
  }

  player.setMini = (next: boolean): void => {
    if (closed || win.isDestroyed()) return
    mini = next
    // A fullscreen window with the film in its corner is nobody's intent.
    if (next) leaveFullscreen()
    sendConfig()
    placeOverlay(overlayArea)
    placeSkip()
    player.notifyChrome(EV.playerMini, next)
  }

  player.setPaused = (paused: boolean): void => {
    if (!alive()) return
    const script = paused ? PAUSE_SCRIPT : RESUME_SCRIPT
    // Not awaited: the caller learns the outcome from the media events below,
    // and a frame whose renderer has died never settles its promise at all
    // (see `FRAME_ANSWER_MS` in `pressplay.ts`).
    for (const frame of contents.mainFrame.framesInSubtree) {
      try {
        frame.executeJavaScript(script, true).catch(() => {
          /* frame detached or navigated away */
        })
      } catch {
        /* the frame went between listing and calling */
      }
    }
  }

  // What the play/pause button shows. From the video itself, so a pause the
  // provider's own controls made reads the same as one from the button.
  contents.on('media-started-playing', () => options.onPlayingChange?.(true))
  contents.on('media-paused', () => options.onPlayingChange?.(false))

  player.goToEpisode = (step): void => {
    if (!alive()) return
    player.context = step.context
    player.candidates = step.candidates
    player.candidateIndex = 0
    player.exhausted = []
    runtimeJudged.clear()
    crashedAt = -1
    // Usually the source already loaded, but not when it cannot serve this
    // episode: its own Referer, as a switch does.
    applyIdentityFor(currentCandidate())
    // After the context, so the place handed back is this episode's own.
    armResume('episode')
    beginLoad()
    void contents.loadURL(framed(step.url))
  }

  /**
   * Reload the embed in place.
   *
   * `beginLoad()` first, so the stall watchdogs restart with it: a reload is a
   * fresh attempt at the same source and it deserves the same patience as the
   * first one. Without it the timers left over from the attempt that just
   * failed would fire almost immediately and offer to switch provider before
   * the reloaded page had a chance.
   */
  player.position = (): VideoPosition | null => (resume.pending() ? null : lastPosition)

  player.takeProgressMs = (): number => {
    // Fold in the stretch still running, so leaving mid-playback counts it.
    stopCounting()
    const total = playedMs
    playedMs = 0
    return total
  }

  player.reload = (): void => {
    if (!alive()) return
    // A reload is a fresh attempt at the same thing, so it should come back to
    // where the user was rather than to the top.
    armResume('reload')
    beginLoad()
    contents.reload()
  }

  player.setMuted = (muted: boolean): void => {
    if (!alive()) return
    mutedFromOutside = muted
    // Held, the sound stays off until the player shows; see `release`.
    if (carry === null || carry.done) contents.setAudioMuted(muted)
  }

  player.destroy = (): void => {
    if (closed) return
    closed = true

    clearPendingVerdicts()
    // Both belong here and nowhere else. They were briefly attached to
    // `media-started-playing` instead, which ends with the same two lines as
    // this block — so a text edit matched the wrong one. The effect was silent
    // and total: polling and the elapsed-time counter both stopped the instant
    // playback began, so no position was ever stored and nothing ever reached
    // the watched threshold.
    clearInterval(positionTimer)
    // Held when closed: its poll would go on reading a view that is gone
    // until the carry gave up, half a minute later.
    if (heldTimer !== null) clearInterval(heldTimer)
    heldTimer = null
    stopCounting()
    announceSuggestion(null)

    // The session outlives the view (casting keeps watching it), so this
    // player's observers would otherwise go on counting a page that is gone.
    for (const stop of stopObserving) stop()

    ipcMain.removeListener(EV.playerKey, onPlayerKey)
    ipcMain.removeListener(EV.playerActivity, onActivity)
    ipcMain.removeListener(EV.playerOwned, onOwned)
    ipcMain.removeListener(EV.playerPressPlay, onPressPlay)
    ipcMain.removeListener(EV.playerOffered, onOffered)
    leaveFullscreen()
    if (!win.isDestroyed()) {
      win.removeListener('enter-full-screen', sendConfig)
      win.removeListener('leave-full-screen', sendConfig)
    }

    if (overlay !== null) {
      ipcMain.removeListener(EV.chromeOverlayArea, onOverlayArea)
      ipcMain.removeListener(EV.chromeBack, onBack)
      if (!win.isDestroyed()) win.contentView.removeChildView(overlay)
      /**
       * Detaching is not closing.
       *
       * `removeChildView` takes the overlay out of the window's tree and
       * nothing more — the web contents keeps running, in its own renderer
       * process, for as long as anything holds the view. Measured: opening
       * three players in one session left three live `chrome.html` targets in
       * the debugger, one per player, none of them attached to anything.
       */
      overlay.webContents.close()
      overlay = null
    }
    if (skipView !== null) {
      ipcMain.removeListener(EV.chromeSkipSize, onSkipSize)
      ipcMain.removeListener(EV.chromeSkip, onSkip)
      if (!win.isDestroyed()) win.contentView.removeChildView(skipView)
      // Detaching is not closing; see the note on the overlay above.
      skipView.webContents.close()
      skipView = null
    }
    if (!win.isDestroyed()) win.contentView.removeChildView(view)

    /**
     * Destroy on the next tick, never inline.
     *
     * Tearing down a renderer process blocks the main process event loop while
     * it happens, and callers of this are usually mid-way through handling an
     * IPC message — so an inline destroy stalls the reply and the renderer sees
     * its close request hang. The same hazard, in a different disguise, as the
     * one that froze the provider probe on its second iteration.
     */
    setTimeout(() => {
      if (!contents.isDestroyed()) contents.close()
    }, 0)

    options.onClosed?.()
  }

  win.contentView.addChildView(view)

  /**
   * The floating controls, in a view of their own, added *after* the video.
   *
   * Child views paint in the order they are added, so this is what puts the
   * chrome above the picture — and it is the only arrangement that does. The
   * app window's own page always paints beneath every child view, which is why
   * the controls used to grow a band and displace the video instead of
   * floating over it.
   *
   * Two properties matter and both are easy to lose:
   *
   * - **Transparent.** The view, and every layer in its document, has to opt
   *   in. One opaque ancestor turns the overlay into a grey rectangle over the
   *   video.
   * - **No taller than what it draws.** A view swallows every mouse event
   *   inside its bounds, so an overlay covering the window would make the video
   *   unclickable. The document measures itself and asks for a height.
   */
  let overlay: WebContentsView | null = null
  if (options.chromeUrl !== undefined) {
    overlay = new WebContentsView({
      webPreferences: {
        preload: join(dirname, '../preload/chrome.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        /*
          Unsandboxed, like every other preload here, and not by preference.

          electron-vite emits preloads as ES modules that import a shared
          chunk, and a sandboxed preload cannot load those — it fails silently,
          so `window.wtaChrome` is simply absent and the overlay renders an
          empty document with no error anywhere. Measured exactly that way.
        */
        sandbox: false,
      },
    })
    overlay.setBackgroundColor('#00000000')
    void overlay.webContents.loadURL(options.chromeUrl)
    win.contentView.addChildView(overlay)

    player.notifyChrome = (channel, payload): void => {
      // Destroyed between the event being raised and delivered is ordinary:
      // the user closed the player while a provider scan was still running.
      if (overlay === null || overlay.webContents.isDestroyed()) return
      overlay.webContents.send(channel, payload)
    }
  }

  /**
   * The skip button (intro, recap, next episode), in a view of its own.
   *
   * Added after the chrome so it paints above it, though in practice they
   * never overlap — one is pinned to the top edge and the other to the
   * bottom-right corner. They are two views rather than one because a view
   * swallows every mouse event inside its bounds: a single view spanning both
   * corners would make the entire picture between them unclickable.
   *
   * Same document, same preload; `?role=skip` is what selects the component.
   */
  let skipView: WebContentsView | null = null
  if (options.chromeUrl !== undefined && options.skipIntro !== undefined) {
    skipView = new WebContentsView({
      webPreferences: {
        preload: join(dirname, '../preload/chrome.mjs'),
        contextIsolation: true,
        // Not sandboxed, for the reason recorded on the chrome overlay: a
        // sandboxed preload cannot load the ES module electron-vite emits and
        // fails silently, leaving `window.wtaChrome` simply absent.
        sandbox: false,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    skipView.setBackgroundColor('#00000000')
    void skipView.webContents.loadURL(`${options.chromeUrl}?role=skip`)
    win.contentView.addChildView(skipView)
  }

  /** Size of the button, as the view itself measured it. */
  let skipSize = { width: 0, height: 0 }

  /**
   * Pin the skip view to the bottom-right of the video's slot, above the
   * provider's own controls (`skipButtonBounds`).
   *
   * Zero-sized until the button exists, because a view with bounds is a view
   * taking clicks — and for most of an episode there is no button to take
   * them for.
   */
  const placeSkip = (): void => {
    if (skipView === null || closed || win.isDestroyed()) return
    const slot = view.getBounds()
    if (mini) {
      skipView.setBounds({ x: slot.x, y: slot.y, width: 0, height: 0 })
      return
    }
    skipView.setBounds(skipButtonBounds(slot, skipSize))
  }

  /**
   * Lay the overlay along the top of the video's slot: across all of it, or
   * centred when the chrome asked for a width (see `OverlayArea`).
   */
  const placeOverlay = (area: OverlayArea): void => {
    if (overlay === null || closed || win.isDestroyed()) return
    const slot = view.getBounds()
    // Sized to nothing rather than removed: its document keeps running, so
    // the bar, the source menu and a held offer are all still there on the
    // way back out of the corner.
    if (mini) {
      overlay.setBounds({ x: slot.x, y: slot.y, width: 0, height: 0 })
      return
    }
    const width = area.width === null ? slot.width : Math.min(Math.round(area.width), slot.width)
    overlay.setBounds({
      x: slot.x + Math.round((slot.width - width) / 2),
      y: slot.y,
      width,
      height: Math.max(0, Math.min(Math.round(area.height), slot.height)),
    })
  }

  let overlayArea: OverlayArea = { height: 56, width: null }
  const onOverlayArea = (event: Electron.IpcMainEvent, area: OverlayArea): void => {
    // Scoped by sender: more than one player can exist during a switch, and an
    // area from somebody else's overlay would resize this one.
    if (overlay === null || event.sender !== overlay.webContents) return
    overlayArea = area
    placeOverlay(area)
    episodesOpen = area.episodesOpen === true
    sourcesOpen = area.sourcesOpen === true
    const next: BarState = { visible: area.barVisible ?? true, away: area.away ?? false }
    if (next.visible !== barState.visible || next.away !== barState.away) {
      barState = next
      if (alive()) contents.send(EV.playerBarState, next)
    }
  }
  const onBack = (event: Electron.IpcMainEvent): void => {
    if (overlay === null || event.sender !== overlay.webContents) return
    options.onBack?.()
  }
  const onSkipSize = (
    event: Electron.IpcMainEvent,
    size: { width: number; height: number },
  ): void => {
    // Scoped by sender for the same reason as the overlay area: more than
    // one player exists during a switch, and a size from somebody else's view
    // would move this one.
    if (skipView === null || event.sender !== skipView.webContents) return
    skipSize = size
    placeSkip()
  }
  const onSkip = (event: Electron.IpcMainEvent): void => {
    if (skipView === null || event.sender !== skipView.webContents) return
    // Withdrawn at once by `press`, rather than at the next poll.
    const action = skipWatch.press()
    if (action?.kind === 'seek') seekTo(action.seconds)
    else if (action?.kind === 'next') options.skipIntro?.playNext()
  }
  /**
   * Fullscreen is the window's. The player already fills the window, so a
   * fullscreen window is a fullscreen picture, and every view keeps being
   * placed from the slot the app reports. Left again when the player is, if
   * it was the player that entered it.
   */
  let fullscreenByPlayer = false
  const setFullscreen = (on: boolean): void => {
    if (win.isDestroyed() || win.isFullScreen() === on) return
    fullscreenByPlayer = on
    win.setFullScreen(on)
  }
  function leaveFullscreen(): void {
    if (fullscreenByPlayer) setFullscreen(false)
  }

  /**
   * While the episode strip is open, ←/→ move its highlight, Enter plays the
   * highlighted episode, and Back or Escape close the strip (the owner,
   * 2026-09-27). The film is not moved while the viewer is picking.
   */
  const EPISODE_KEYS: Partial<Record<PlayerAction, EpisodeNav>> = {
    seekBack: 'prev',
    seekForward: 'next',
    episodes: 'play',
    back: 'close',
    escape: 'close',
  }
  /** While the source list is open, Back and Escape close it rather than leave the player. */
  const SOURCE_KEYS: Partial<Record<PlayerAction, EpisodeNav>> = {
    back: 'close',
    escape: 'close',
  }

  player.action = (action: PlayerAction): void => {
    if (!alive()) return
    if (carry !== null && !carry.done) {
      // What is on screen is the preview: these two are for it. Anything else
      // wants the player, so it shows, and the key then does what it does.
      if (action === 'togglePlay' || action === 'mute') {
        options.onHeldAction?.(action)
        return
      }
      releaseHeld()
    }
    const nav = episodesOpen ? EPISODE_KEYS[action] : sourcesOpen ? SOURCE_KEYS[action] : undefined
    if (nav !== undefined && overlay !== null && !overlay.webContents.isDestroyed()) {
      overlay.webContents.send(EV.chromeEpisodeNav, nav)
      return
    }
    switch (action) {
      case 'fullscreen':
        setFullscreen(!win.isFullScreen())
        return
      case 'escape':
        if (!win.isDestroyed() && win.isFullScreen()) {
          setFullscreen(false)
          return
        }
        options.onBack?.()
        return
      case 'back':
        options.onBack?.()
        return
      case 'reload':
        player.reload()
        return
      case 'episodes':
      case 'cast':
      case 'sources':
        if (overlay !== null && !overlay.webContents.isDestroyed()) {
          overlay.webContents.send(EV.chromeOpenPanel, action)
          // The cast remote covers the whole picture, so the keys belong to it:
          // left in the shell, Escape shrinks the player instead of closing the
          // remote. The chrome forwards every player key back here, so nothing
          // else changes with the focus.
          if (action === 'cast') overlay.webContents.focus()
        }
        return
      default:
        // Play, seek, volume: the shell's controls act on the film.
        contents.send(EV.playerTransport, action)
    }
  }

  // Scoped by sender, like the chrome's messages: during a switch two players
  // exist, and a key meant for one must not move the other.
  const onPlayerKey = (event: Electron.IpcMainEvent, action: unknown): void => {
    const fromShell = event.sender === contents
    const fromChrome = overlay !== null && event.sender === overlay.webContents
    if ((fromShell || fromChrome) && isPlayerAction(action)) player.action(action)
  }
  const onActivity = (event: Electron.IpcMainEvent, hold: unknown): void => {
    if (event.sender !== contents) return
    if (overlay !== null && !overlay.webContents.isDestroyed()) {
      overlay.webContents.send(EV.chromeActivity, hold === true)
    }
  }
  /** Whether the shell's controls have the film: the chrome's bar lays itself out by it. */
  const onOwned = (event: Electron.IpcMainEvent, owned: unknown): void => {
    if (event.sender !== contents) return
    if (overlay !== null && !overlay.webContents.isDestroyed()) {
      overlay.webContents.send(EV.chromeOwned, owned === true)
    }
  }
  /**
   * The shell's cover is over the source, so a mouse click at the centre
   * would land on the cover. What reaches the source's poster is a DOM click
   * in its frames, which works on hidden elements too.
   */
  const onPressPlay = (event: Electron.IpcMainEvent): void => {
    if (event.sender !== contents || !alive()) return
    void clickPlayInFrames(contents).catch(() => {})
  }
  /** The top of the source's own list of qualities; see `noteOffered`. Checked here: a renderer's message is never trusted by shape. */
  const onOffered = (event: Electron.IpcMainEvent, quality: unknown, audio: unknown): void => {
    if (event.sender !== contents || !alive()) return
    if (typeof quality === 'number' && QUALITY_CLASSES.includes(quality)) noteOffered({ quality, audio: isAudioList(audio) ? audio : [] })
  }
  ipcMain.on(EV.playerKey, onPlayerKey)
  ipcMain.on(EV.playerActivity, onActivity)
  ipcMain.on(EV.playerOwned, onOwned)
  ipcMain.on(EV.playerPressPlay, onPressPlay)
  ipcMain.on(EV.playerOffered, onOffered)

  if (overlay !== null) {
    ipcMain.on(EV.chromeOverlayArea, onOverlayArea)
    ipcMain.on(EV.chromeBack, onBack)
  }
  if (skipView !== null) {
    ipcMain.on(EV.chromeSkipSize, onSkipSize)
    ipcMain.on(EV.chromeSkip, onSkip)
  }
  /* ── Held: the preview stands in until the film is where it is ────────── */

  /*
   * Out of sight means beside the window, not hidden. A hidden view's page
   * lays out at 0×0 and gets no frames: the film relay, which takes the
   * largest video for the film, found none and told our overlay nothing, so
   * its curtain was still up over the film for ~0.5 s after the swap; and the
   * source had no player size to choose a stream for (measured 2026-09-29).
   * Beside the window it is laid out and painted as it will be shown, and is
   * shown by moving it into its slot.
   */

  /** What `player.setMuted` (casting) asked for, applied once the player shows. */
  let mutedFromOutside = false
  let heldTimer: ReturnType<typeof setInterval> | null = null
  /** How often a held player's film is read: often, since the viewer is waiting on it. */
  const HELD_POLL_MS = 400

  /**
   * Show the held player: the views, the sound (unless casting muted it), and
   * the preview's own sound and pause. Once; a second call does nothing.
   */
  function releaseHeld(): void {
    if (carry === null || !heldTimer) return
    clearInterval(heldTimer)
    heldTimer = null
    // Shown before its film was ever read (a click on the preview, the
    // give-up): nothing has put the film at the preview's place, so the
    // ordinary resume seek does, there, as it would have without the carry.
    const target = carry.target(Date.now())
    carry.release()
    if (!alive() || win.isDestroyed()) return
    if (lastPosition === null && target !== null) resume = new ResumeSeek(target, player.context.runtimeMinutes)
    player.setBounds(slot)
    contents.setAudioMuted(mutedFromOutside)
    sendConfig()
    if (carry.last()?.paused) player.setPaused(true)
    console.log(`[carry] player shown at ${lastPosition ? Math.round(lastPosition.seconds) : '?'} s (${carry.reason})`)
    options.onReleased?.()
  }

  if (carry !== null) {
    contents.setAudioMuted(true)
    // The carry does the seeking, to where the preview is by then.
    resume = new ResumeSeek(0, player.context.runtimeMinutes)
    heldTimer = setInterval(() => {
      const asked = loadAsked()
      void readPosition().then((found) => {
        if (carry.done || !stillOnScreen(asked)) return
        if (found) lastPosition = found
        const film = found && { seconds: found.seconds, duration: found.duration, playing: !found.paused }
        const move = carry.step(film, Date.now())
        if (move.kind === 'seek') seekTo(move.to)
        if (move.kind === 'release') releaseHeld()
      })
    }, HELD_POLL_MS)
  }

  player.carryTo = (report: CarryReport): void => {
    if (carry === null || carry.done) return
    const mutedBefore = carry.last()?.muted
    carry.update({ ...report, at: Date.now() })
    if (report.muted !== mutedBefore) sendConfig()
  }
  player.carryEnd = releaseHeld
  player.held = held

  player.setBounds(bounds)
  beginLoad()
  void contents.loadURL(framed(url))

  return player
}

/**
 * Injected into a player view that failed to load. Inline rather than a
 * separate asset because it has to run inside the provider's page, which we do
 * not control and cannot add files to.
 */
function renderFailureOverlay(
  reason: string,
  exhausted: Array<{ provider: string; reason: string }> = [],
): string {
  const safeReason = JSON.stringify(reason)
  // Name every provider that was tried and how each failed. "It didn't work"
  // is not actionable; "all four of these returned 500" tells the user the
  // problem is upstream and not their configuration.
  const safeTried = JSON.stringify(exhausted.map((e) => `${e.provider} — ${e.reason}`).join('\n'))
  return `(() => {
    if (!document.body || document.getElementById('wta-error')) return;
    const el = document.createElement('div');
    el.id = 'wta-error';
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:14px;background:#0b0b0f;color:#f4f4f6;' +
      'font-family:system-ui,sans-serif;text-align:center;padding:24px';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:19px;font-weight:600';
    title.textContent = 'No provider could play this';
    const detail = document.createElement('div');
    detail.style.cssText = 'font-size:13px;color:#a8a8b8';
    detail.textContent = ${safeReason};
    const tried = document.createElement('pre');
    tried.style.cssText = 'font-size:12px;color:#6e6e80;margin:0;white-space:pre-wrap;' +
      'font-family:ui-monospace,monospace;max-width:520px';
    tried.textContent = ${safeTried};
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:13px;color:#6e6e80';
    hint.textContent = 'Enable more providers, or try again later.';
    const retry = document.createElement('button');
    retry.style.cssText = 'padding:8px 22px;background:#6366f1;color:#fff;border:none;' +
      'border-radius:6px;cursor:pointer;font-size:13px;font-weight:600';
    retry.textContent = 'Retry';
    retry.onclick = () => location.reload();
    el.append(title, detail);
    if (${safeTried}) el.append(tried);
    el.append(hint, retry);
    document.body.appendChild(el);
  })()`
}
