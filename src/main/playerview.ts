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

import { WebContentsView, BrowserWindow, ipcMain, type Session } from 'electron'
import { join } from 'node:path'
import { EV } from '@shared/ipc'
import type { PlayRequest, PlayerSuggestion } from '@shared/ipc'
import { applyProviderReferer } from './identity'
import { decide } from './adblock'
import { pressPlay as pressPlayIn } from './pressplay'
import { beginStallWatch, frozenSeconds, observeStall, type StallWatch } from './playbackstall'
import { checkRuntime } from './runtimecheck'
import { findIntro } from './skiplookup'
import { isWithinOffer, skipTarget, type SkipSegment } from './skiptimes'
import type { PlayCandidate } from './providers'
import { shouldSeek } from './resume'
import { createPointerZoneWatcher } from './pointerzone'
import { isProviderFailure } from './switchoffer'

/** Where the video sits, in the app window's content coordinates. */
export interface PlayerBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface InlinePlayer {
  /** Mutable: rewritten when the player navigates to another episode. */
  context: PlayRequest
  /** Every provider that can serve this title, best first. */
  candidates: PlayCandidate[]
  /** Index into `candidates` of the provider currently loaded. */
  candidateIndex: number
  /** Providers already tried and failed, with why — shown if all of them do. */
  exhausted: Array<{ provider: string; reason: string }>
  /** Switch to a named provider. Returns false if it cannot serve this title. */
  switchTo: (providerId: string) => boolean
  /** "Keep waiting": stop offering to leave the provider currently loading. */
  keepWaiting: () => void
  /** Move the video. Called by the renderer whenever its slot moves or resizes. */
  setBounds: (bounds: PlayerBounds) => void
  /** Load a different URL into the same view, e.g. another episode. */
  load: (url: string) => void
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
   * store instead costs one coalesced write a minute and makes "where was I"
   * survive anything.
   */
  onPosition?: (position: VideoPosition) => void
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
   * Everything the skip-intro offer needs, or absent to leave it off.
   *
   * Grouped rather than spread across four optional fields because they are
   * useless apart: without the data directory there is nowhere to cache the
   * anime id mapping, and without `enabled` the lookup must not happen at all
   * — it is the switch that decides whether two third parties are told what
   * is playing.
   */
  skipIntro?: {
    /** Read on every episode, so turning it off takes effect immediately. */
    enabled: () => boolean
    /** Where the anime id mapping is cached. Never inside the app bundle. */
    dataDir: string
    /** Gate on the 5.8 MB anime id download; see `IntroDeps.isAnimated`. */
    isAnimated: (tmdbId: number) => Promise<boolean>
  }
  /**
   * The user asked to leave the player — the chrome's back button.
   *
   * Separate from `onClosed`, and the confusion between the two is why that
   * button did nothing at all: `onClosed` fires *after* the view has torn
   * itself down, so wiring "go back" to it asked the player to report a
   * teardown that nobody had started. This one is a request; the host decides
   * what leaving means and calls `destroy`.
   */
  onRequestClose?: () => void
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
   */
  /**
   * Observed rather than rendered: the offer itself is drawn by the floating
   * chrome, which `announceSuggestion` sends to directly. This hook is what
   * lets a probe or a test see the same decision without a window.
   */
  onSuggest?: (suggestion: PlayerSuggestion | null) => void
}

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
      }
    }
  }
  return best
    ? JSON.stringify({
        seconds: best.seconds,
        duration: best.duration,
        ended: best.ended,
        paused: best.paused,
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
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Black rather than white: an embed page paints its own background late, and
  // a white flash between the app and the video is the most jarring thing a
  // player can do.
  view.setBackgroundColor('#000000')

  let closed = false

  const player: InlinePlayer = {
    session: contents.session,
    context,
    candidates,
    candidateIndex: 0,
    exhausted: [],
    switchTo: () => false,
    keepWaiting: () => {},
    // Replaced below, once the view exists to press into.
    pressPlay: async () => {},
    setBounds: () => {},
    load: () => {},
    reload: () => {},
    setMuted: () => {},
    position: () => null,
    takeProgressMs: () => 0,
    destroy: () => {},
    currentProviderId: () => null,
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

  /**
   * Cancel the advertising, on this partition only.
   *
   * `onBeforeRequest` allows one handler per session, which is exactly why the
   * player has its own partition — registering this on the app's session would
   * replace whatever else wanted it, and would also apply the rules to the
   * app's own TMDB traffic.
   *
   * The page origin is re-read from the player on every request rather than
   * captured: switching provider mid-episode replaces the candidate, and rules
   * that still trusted the previous provider's domain would either block the
   * new stream or wave through the new page's ads.
   *
   * Set `WTA_ADBLOCK_LOG=1` to see every decision. That is the switch to reach
   * for when a provider stops playing after a rule changes — each line names
   * the rule, so "which rule killed the video" is a grep rather than a bisect.
   */
  const logBlocking = process.env.WTA_ADBLOCK_LOG === '1'
  // An off switch, because the first question when a provider stops playing is
  // "is it the blocker?" and the only honest way to answer it is to run the
  // same thing twice.
  const blockingEnabled = process.env.WTA_ADBLOCK !== '0'
  contents.session.webRequest.onBeforeRequest((details, callback) => {
    if (!blockingEnabled) {
      callback({ cancel: false })
      return
    }
    const decision = decide({
      url: details.url,
      resourceType: details.resourceType,
      pageOrigin: currentCandidate()?.provider.rootUrl ?? null,
    })
    if (logBlocking) {
      console.log(
        `[adblock] ${decision.blocked ? 'BLOCK' : 'allow'} ${decision.rule} ` +
          `${details.resourceType} ${details.url.slice(0, 160)}`,
      )
    }
    callback({ cancel: decision.blocked })
  })

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
   */
  /**
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
    const candidate = currentCandidate()
    if (candidate) reportOutcome(candidate.provider.id, 'stream')
    // It worked. Nothing pending against this provider is valid any more, and
    // any offer to leave it must be withdrawn — an offer still on screen after
    // the video started is worse than never having made one.
    playing = true
    if (playingSince === null) playingSince = Date.now()
    if (!seekDone) setTimeout(() => restorePosition(), SEEK_SETTLE_MS)
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
   * Four seconds is chosen against what is lost when the app dies without
   * closing cleanly: at worst the user goes back four seconds. Polling faster
   * would buy nothing anyone could notice and runs script in every frame of an
   * untrusted page for it.
   */
  const POSITION_POLL_MS = 4_000

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
    suggest(`${name} stopped part-way through`)
  }

  /* ── Skip intro ───────────────────────────────────────────────────────── */

  /**
   * Where this episode's intro is, once somebody has told us.
   *
   * `undefined` means the databases have not been asked yet, `null` means
   * they were and there is nothing worth offering. The distinction is what
   * stops the lookup running again every four seconds for an episode that
   * simply has no data — which would be most of them.
   */
  let intro: SkipSegment | null | undefined = undefined
  let skipOffered = false

  /** Tell the skip view what to draw, and only when it changes. */
  const announceSkip = (offer: { targetSeconds: number } | null): void => {
    if (skipView === null || skipView.webContents.isDestroyed()) return
    if (offer === null && !skipOffered) return
    skipOffered = offer !== null
    skipView.webContents.send(EV.playerSkipOffer, offer)
  }

  /**
   * Ask the intro databases, once, as soon as the stream has a duration.
   *
   * Deferred to the first real reading rather than done when the episode
   * loads, for two reasons that point the same way. The duration is what
   * every check in `vetSegment` rests on — without it there is nothing to
   * check an answer against — and waiting means a title somebody opened and
   * abandoned is never looked up at all, so two third parties learn about
   * strictly less than the user actually watched.
   */
  const lookUpIntro = (streamSeconds: number): void => {
    const config = options.skipIntro
    if (intro !== undefined || config === undefined || !config.enabled()) return

    // Claimed before the await, so a second poll four seconds later does not
    // start the same lookup again while the first is still in flight.
    intro = null

    const context = player.context
    void findIntro(
      {
        tmdbId: context.tmdbId,
        imdbId: context.imdbId,
        season: context.season,
        episode: context.episode,
        streamSeconds,
        expectedMinutes: context.runtimeMinutes,
      },
      {
        dataDir: config.dataDir,
        isAnimated: config.isAnimated,
        onJudged: (segment, ok, reason) =>
          console.log(`[skip] ${segment.source} ${ok ? 'accepted' : 'rejected'}: ${reason}`),
      },
    )
      .then((found) => {
        // The user may have stepped to another episode while this was in the
        // air; `beginLoad` resets the state, and an answer about the previous
        // episode must not land on top of it.
        if (!alive() || intro !== null || player.context !== context) return
        intro = found
      })
      .catch(() => {
        // Already null. No data and a failed lookup are the same to the user.
      })
  }

  /** Raise or withdraw the button for one position reading. */
  const offerSkip = (found: VideoPosition | null): void => {
    if (!alive()) return
    if (found === null) {
      announceSkip(null)
      return
    }
    lookUpIntro(found.duration)
    if (!intro) {
      announceSkip(null)
      return
    }
    announceSkip(isWithinOffer(intro, found.seconds) ? { targetSeconds: skipTarget(intro) } : null)
  }

  const positionTimer = setInterval(() => {
    // The catch is load-bearing: an unhandled rejection here stops nothing in
    // Node, but it means `lastPosition` silently stops updating. Better to lose
    // one reading than the rest of the session's.
    void readPosition()
      .then((found) => {
        // Before the early return, because a reading that is *missing* while
        // playback is under way is the strongest stall evidence there is: the
        // element has gone, which is what a torn-down player looks like.
        watchForStall(found)
        offerSkip(found)
        if (!found) return
        lastPosition = found
        judgeRuntime(found)
        maybePersist(found)
      })
      .catch(() => {})
  }, POSITION_POLL_MS)

  /**
   * Hand a reading to the host, but not on every poll.
   *
   * The poll is every four seconds because the resume seek and the stall
   * watchdog want a recent number; the *store* does not need that resolution,
   * and writing at that rate would serialise the whole document fifteen times a
   * minute. Thirty seconds is the most anyone loses to a hard crash.
   */
  const PERSIST_EVERY_MS = 30_000
  let lastPersistedAt = 0

  const maybePersist = (found: VideoPosition): void => {
    const now = Date.now()
    if (now - lastPersistedAt < PERSIST_EVERY_MS) return
    lastPersistedAt = now
    options.onPosition?.(found)
  }

  /**
   * Put the video back where it was left.
   *
   * Deliberately late and deliberately conditional. `media-started-playing`
   * only says decoding began; the element's duration and seekable range often
   * arrive a beat later, and seeking before then is silently ignored. And if
   * the provider restores its own position, `shouldSeek` sees that and leaves
   * it alone rather than fighting a feature the site already has.
   */
  const SEEK_SETTLE_MS = 1_500
  const SEEK_ATTEMPTS = 4

  /**
   * Where the current load should resume to, and whether that is settled.
   *
   * Per *load*, not per player. These used to be read straight off
   * `options.resumeAt`, which is fixed at construction — so the seek happened
   * at most once in a view's lifetime and every later navigation started at
   * zero.
   */
  let resumeAt = options.resumeAt ?? 0
  let seekDone = resumeAt <= 0

  /**
   * Settle the position being left and arm the one being loaded.
   *
   * Called by every path that navigates. Returning zero — no host, or nothing
   * worth resuming — simply means the next load starts at the beginning.
   */
  const armResume = (reason: NavigationReason): void => {
    resumeAt = options.onNavigate?.(reason) ?? 0
    seekDone = resumeAt <= 0
  }

  const restorePosition = (attempt = 1): void => {
    if (seekDone || !alive()) return

    void readPosition().then((found) => {
      if (seekDone || !alive()) return

      if (!found) {
        if (attempt < SEEK_ATTEMPTS) setTimeout(() => restorePosition(attempt + 1), SEEK_SETTLE_MS)
        return
      }

      const target = resumeAt
      if (!shouldSeek(target, found.seconds, found.duration)) {
        // Either the provider handled it or the memory is not worth acting on.
        seekDone = true
        return
      }

      seekDone = true
      seekTo(target)
    })
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
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  let silenceTimer: ReturnType<typeof setTimeout> | null = null

  const clearPendingVerdicts = (): void => {
    if (stallTimer) {
      clearTimeout(stallTimer)
      stallTimer = null
    }
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

  /**
   * A failed provider API call asks **immediately**.
   *
   * The grace period here was inherited from when this timer *switched* the
   * provider, where waiting was the only protection against throwing away a
   * source that was merely slow. Offering costs nothing by comparison: the
   * video keeps loading behind the prompt, and "Keep waiting" puts the user
   * exactly where they would have been. So the moment the provider's own
   * backend says it cannot serve this, say so.
   *
   * A short debounce remains, and only that: these pages fire several
   * sub-requests at once and a burst of three failures should raise one prompt,
   * not three.
   */
  const API_ERROR_DEBOUNCE_MS = 250

  /** The next provider we have not tried, or undefined if there is none. */
  const nextUntried = (): PlayCandidate | undefined => {
    const tried = new Set(player.exhausted.map((e) => e.provider))
    return player.candidates.find((c) => !tried.has(c.provider.name) && c !== currentCandidate())
  }

  /**
   * Ask, rather than act.
   *
   * Used for every *ambiguous* symptom — a provider API returning 500, or a
   * page that has simply not played anything yet. Both look identical to a
   * provider that is slow, and only the user can see which one they are
   * looking at. Unambiguous failures still call `advance` directly.
   */
  const suggest = (reason: string): void => {
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
    })
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
    clearPendingVerdicts()
    // Every caller is navigating to a *different* URL, so any "keep waiting"
    // the user set is about a page that is no longer loaded. A page reloading
    // itself does not come through here, which is what lets the choice survive
    // the retries these players do while resolving a stream.
    waitingOut = -1
    announceSuggestion(null)

    silenceTimer = setTimeout(() => {
      silenceTimer = null
      const current = currentCandidate()
      suggest(`${current?.provider.name ?? 'This source'} has not started playing`)
    }, SILENCE_GRACE_MS)

    stallWatch = beginStallWatch(Date.now())
    /**
     * A different episode has a different intro, and often none at all. Reset
     * to "not asked" rather than to null, or stepping to the next episode
     * would inherit the previous one's answer — or its absence.
     */
    intro = undefined
    announceSkip(null)

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
      player.exhausted.push({ provider: failed.provider.name, reason })
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
    const tried = new Set(player.exhausted.map((e) => e.provider))
    const nextIndex = player.candidates.findIndex((c) => !tried.has(c.provider.name))
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
    contents.send(EV.playerProviderChanged, {
      providerId: next.provider.id,
      providerName: next.provider.name,
      reason,
    })
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
    if (httpResponseCode < 400) return
    const reason = `HTTP ${httpResponseCode} ${httpStatusText}`.trim()
    console.error(`[player] ${navigatedUrl} returned ${reason}`)
    // The server answered and said no. That is a verdict, not a delay, so it
    // offers straight away rather than switching or waiting.
    suggest(reason)
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
   */
  contents.session.webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
    const candidate = currentCandidate()

    let providerOrigin: string | null = null
    if (candidate) {
      try {
        providerOrigin = new URL(candidate.provider.rootUrl).origin
      } catch {
        providerOrigin = null
      }
    }

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
        offerPending: stallTimer !== null,
      })
    ) {
      return
    }

    const reason = `${candidate.provider.name} API returned ${details.statusCode}`
    console.warn(`[player] ${details.url} → ${details.statusCode}`)

    /**
     * Remember which provider this verdict is about.
     *
     * The obvious guard — cancel the timer on navigation — does not work:
     * `did-start-navigation` fires for sub-frames, and these providers load
     * their player in an iframe, so the page reliably cancelled the timer
     * before it could fire. Comparing the provider instead is immune to how
     * many frames the page navigates.
     */
    const decidedFor = player.candidateIndex

    stallTimer = setTimeout(() => {
      stallTimer = null
      // Already moved on, by fallback or by the user picking a source.
      if (player.candidateIndex !== decidedFor) return
      suggest(reason)
    }, API_ERROR_DEBOUNCE_MS)
  })

  /**
   * Still automatic, unlike the two ambiguous signals above.
   *
   * A refused connection or an unresolvable host is not a provider being slow;
   * there is no page, and no amount of waiting produces one. Asking the user
   * whether to wait for a host that does not exist is a worse experience than
   * silently trying the next source.
   */
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

    // Twice on the same source. Unambiguous, so this one acts rather than asks.
    if (!advance(`${name} crashed`)) giveUp(`${name} crashed`)
  })

  contents.on('did-fail-load', (_event, errorCode, errorDescription, failedUrl) => {
    // -3 ERR_ABORTED and the two navigation codes fire during normal redirects.
    if (errorCode === -3 || errorCode === -105 || errorCode === -106) return
    console.error(`[player] ${failedUrl} failed: ${errorCode} ${errorDescription}`)
    if (!advance(errorDescription)) giveUp(errorDescription)
  })

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
    // Rounded because Electron wants integer device-independent pixels and the
    // renderer measures fractional CSS pixels; a fractional bound is silently
    // truncated, which drifts the video a pixel off its slot per resize.
    view.setBounds({
      x: Math.round(next.x),
      y: Math.round(next.y),
      width: Math.max(1, Math.round(next.width)),
      height: Math.max(1, Math.round(next.height)),
    })
    placeOverlay(overlayHeight)
    placeSkip()
  }

  player.load = (nextUrl: string): void => {
    if (!alive()) return
    // `load` is how the host moves to another episode; the host has already
    // rewritten `player.context` by the time this runs, so the target it hands
    // back is the new episode's own stored position.
    armResume('episode')
    beginLoad()
    void contents.loadURL(framed(nextUrl))
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
  player.position = (): VideoPosition | null => lastPosition

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
    contents.setAudioMuted(muted)
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
    stopCounting()
    announceSuggestion(null)

    if (overlay !== null) {
      ipcMain.removeListener(EV.chromeOverlayHeight, onOverlayHeight)
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
      ipcMain.removeListener(EV.chromeSkipTo, onSkipTo)
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
  }

  /**
   * The skip-intro button, in a view of its own.
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

  /** Distance from the picture's bottom-right corner, in device pixels. */
  const SKIP_MARGIN = 28

  /** Size of the button, as the view itself measured it. */
  let skipSize = { width: 0, height: 0 }

  /**
   * Pin the skip view to the bottom-right of the video's slot.
   *
   * Zero-sized until the button exists, because a view with bounds is a view
   * taking clicks — and for most of an episode there is no button to take
   * them for.
   */
  const placeSkip = (): void => {
    if (skipView === null || closed || win.isDestroyed()) return
    const slot = view.getBounds()
    const width = Math.min(skipSize.width, Math.max(0, slot.width - SKIP_MARGIN * 2))
    const height = Math.min(skipSize.height, Math.max(0, slot.height - SKIP_MARGIN * 2))
    skipView.setBounds({
      x: slot.x + slot.width - width - SKIP_MARGIN,
      y: slot.y + slot.height - height - SKIP_MARGIN,
      width,
      height,
    })
  }

  /** Lay the overlay across the top of the video's slot, `height` tall. */
  const placeOverlay = (height: number): void => {
    if (overlay === null || closed || win.isDestroyed()) return
    const slot = view.getBounds()
    overlay.setBounds({
      x: slot.x,
      y: slot.y,
      width: slot.width,
      height: Math.max(0, Math.min(Math.round(height), slot.height)),
    })
  }

  let overlayHeight = 56
  const onOverlayHeight = (event: Electron.IpcMainEvent, height: number): void => {
    // Scoped by sender: more than one player can exist during a switch, and a
    // height from somebody else's overlay would resize this one.
    if (overlay === null || event.sender !== overlay.webContents) return
    overlayHeight = height
    placeOverlay(height)
  }
  const onBack = (event: Electron.IpcMainEvent): void => {
    if (overlay === null || event.sender !== overlay.webContents) return
    options.onRequestClose?.()
  }
  const onSkipSize = (
    event: Electron.IpcMainEvent,
    size: { width: number; height: number },
  ): void => {
    // Scoped by sender for the same reason as the overlay height: more than
    // one player exists during a switch, and a size from somebody else's view
    // would move this one.
    if (skipView === null || event.sender !== skipView.webContents) return
    skipSize = size
    placeSkip()
  }
  const onSkipTo = (event: Electron.IpcMainEvent, seconds: number): void => {
    if (skipView === null || event.sender !== skipView.webContents) return
    if (!Number.isFinite(seconds) || seconds < 0) return
    seekTo(seconds)
    // Withdrawn immediately rather than at the next poll four seconds later.
    announceSkip(null)
  }
  if (overlay !== null) {
    ipcMain.on(EV.chromeOverlayHeight, onOverlayHeight)
    ipcMain.on(EV.chromeBack, onBack)
  }
  if (skipView !== null) {
    ipcMain.on(EV.chromeSkipSize, onSkipSize)
    ipcMain.on(EV.chromeSkipTo, onSkipTo)
  }
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
