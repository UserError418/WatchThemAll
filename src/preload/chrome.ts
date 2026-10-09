/**
 * Preload for the player's floating chrome.
 *
 * Unlike `player.ts`, which runs inside a hostile third-party embed and exposes
 * nothing, this one runs in *our* document and does use `contextBridge`. The
 * surface is small and every entry is something the app's own chrome could
 * already do — this view replaced that chrome, it did not gain privileges.
 *
 * It reuses the player's existing events rather than inventing parallel ones:
 * `playerNavigate` and `playerSwitchProvider` are already handled in the app,
 * and a second pair of channels meaning the same thing is how two paths start
 * behaving differently.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { CH, EV } from '@shared/ipc'
import type {
  EpisodeNav,
  OverlayArea,
  PlayerContext,
  PlayerSuggestion,
  SkipOffer,
  ProviderScan,
  ProviderScanProgress,
  ResultsChanged,
  TitleProviderState,
  TitleRef,
  WtaChromeApi,
} from '@shared/ipc'
import type { Season } from '@shared/types'
import { isPlayerAction, type PlayerAction } from '@shared/playerkeys'

const api: WtaChromeApi = {
  /**
   * Casting, over the same channels the app window uses.
   *
   * The chrome is a separate document from the app's page, so it needs its own
   * bridge — but it is the same contract and the same handlers in main, which
   * is what keeps the desktop and the phone from drifting into two different
   * cast features behind one button.
   */
  cast: {
    available: () => ipcRenderer.invoke(CH.castAvailable),
    startDiscovery: () => ipcRenderer.invoke(CH.castStartDiscovery),
    stopDiscovery: () => ipcRenderer.invoke(CH.castStopDiscovery),
    devices: () => ipcRenderer.invoke(CH.castDevices),
    connect: (deviceId: string) => ipcRenderer.invoke(CH.castConnect, deviceId),
    disconnect: () => ipcRenderer.invoke(CH.castDisconnect),
    beam: () => ipcRenderer.invoke(CH.castBeam),
    status: () => ipcRenderer.invoke(CH.castStatus),
    control: (action: 'play' | 'pause' | 'stop' | 'seek', seconds?: number) =>
      ipcRenderer.invoke(CH.castControl, action, seconds),
    setVolume: (level: number) => ipcRenderer.invoke(CH.castSetVolume, level),
    setMuted: (muted: boolean) => ipcRenderer.invoke(CH.castSetMuted, muted),
  },

  /**
   * Ask main to resize the overlay view to exactly this area, in CSS pixels.
   *
   * The load-bearing one. A `WebContentsView` swallows every mouse event inside
   * its bounds, so an overlay sized to the whole window would make the video
   * unclickable. The document measures itself and main follows.
   */
  setOverlayArea: ({ height, width, barVisible, away, episodesOpen, sourcesOpen }: OverlayArea): void => {
    ipcRenderer.send(EV.chromeOverlayArea, {
      height: Math.max(0, Math.round(height)),
      width: width === null ? null : Math.max(0, Math.round(width)),
      // Whether the bar shows, for the shell's controls to follow (v2).
      barVisible: barVisible !== false,
      away: away === true,
      // Whether the arrows and Enter belong to the episode strip (v2).
      episodesOpen: episodesOpen === true,
      // Whether Back and Escape close the source list (v2).
      sourcesOpen: sourcesOpen === true,
    })
  },

  /** Leave the player. */
  back: (): void => {
    ipcRenderer.send(EV.chromeBack)
  },

  /** Load another episode of the same title. */
  goTo: (season: number, episode: number): void => {
    ipcRenderer.send(EV.playerNavigate, { season, episode })
  },

  /** Play the same thing from a different source. */
  switchProvider: (providerId: string): void => {
    ipcRenderer.send(EV.playerSwitchProvider, { providerId })
  },

  /** Reload the current source, for one that loaded and then stalled. */
  reload: (): Promise<void> => ipcRenderer.invoke(CH.playReload) as Promise<void>,

  /** Whether the pointer is up near the top of the picture.
   *
   * Comes from the player's view rather than from this document: the chrome
   * hides by shrinking to nothing, and a view with no height sees no mouse.
   */
  onPointerTop: (callback: (nearTop: boolean) => void): (() => void) => {
    const listener = (_event: unknown, nearTop: boolean): void => callback(nearTop)
    ipcRenderer.on(EV.playerPointerTop, listener)
    return () => ipcRenderer.removeListener(EV.playerPointerTop, listener)
  },

  /** The pointer moved over the picture, as the shell saw it (v2). */
  onActivity: (callback: (hold: boolean) => void): (() => void) => {
    const listener = (_event: unknown, hold: unknown): void => callback(hold === true)
    ipcRenderer.on(EV.chromeActivity, listener)
    return () => ipcRenderer.removeListener(EV.chromeActivity, listener)
  },

  /** Enter or C, pressed wherever the focus was, or the shell's Sources and Episodes buttons. */
  onOpenPanel: (callback: (panel: 'episodes' | 'cast' | 'sources') => void): (() => void) => {
    const listener = (_event: unknown, panel: unknown): void => {
      if (panel === 'episodes' || panel === 'cast' || panel === 'sources') callback(panel)
    }
    ipcRenderer.on(EV.chromeOpenPanel, listener)
    return () => ipcRenderer.removeListener(EV.chromeOpenPanel, listener)
  },

  /** The phone's tap-to-hide; the desktop's bar hides when the pointer leaves, so this never fires. */
  onDismiss: (): (() => void) => () => {},

  /** Whether our own controls have the film (v2): the bar lays itself out by it. */
  onOwned: (callback: (owned: boolean) => void): (() => void) => {
    const listener = (_event: unknown, owned: unknown): void => callback(owned === true)
    ipcRenderer.on(EV.chromeOwned, listener)
    return () => ipcRenderer.removeListener(EV.chromeOwned, listener)
  },

  onEpisodeNav: (callback: (nav: EpisodeNav) => void): (() => void) => {
    const listener = (_event: unknown, nav: unknown): void => {
      if (nav === 'prev' || nav === 'next' || nav === 'play' || nav === 'close') callback(nav)
    }
    ipcRenderer.on(EV.chromeEpisodeNav, listener)
    return () => ipcRenderer.removeListener(EV.chromeEpisodeNav, listener)
  },

  /** A player key pressed here; main routes it (`playerkeys.ts`). */
  action: (action: PlayerAction): void => {
    if (isPlayerAction(action)) ipcRenderer.send(EV.playerKey, action)
  },

  /** Episodes for one season, with stills and runtimes, from TMDB via main. */
  season: (tmdbId: number, season: number): Promise<Season | null> =>
    ipcRenderer.invoke(CH.tmdbSeason, tmdbId, season) as Promise<Season | null>,

  /**
   * What has actually played for this title, per provider.
   *
   * Read on every open rather than cached, because the player is *writing* to
   * this log while the user is looking at it — the source they tried a minute
   * ago is exactly the row whose colour they came to check.
   */
  outcomes: (media: TitleRef, episode?: { season: number; episode: number } | null): Promise<TitleProviderState> =>
    ipcRenderer.invoke(CH.providersOutcomes, media, episode ?? null) as Promise<TitleProviderState>,
  scan: (media: TitleRef, episode?: { season: number; episode: number } | null) =>
    ipcRenderer.invoke(CH.providersScan, media, episode ?? null) as Promise<ProviderScan>,
  cancelScan: (): Promise<void> => ipcRenderer.invoke(CH.providersScanCancel) as Promise<void>,
  onProviderScan: (cb: (progress: ProviderScanProgress) => void): (() => void) => {
    const listener = (_e: unknown, progress: ProviderScanProgress): void => cb(progress)
    ipcRenderer.on(EV.providerScan, listener)
    return () => ipcRenderer.removeListener(EV.providerScan, listener)
  },
  onResultsChanged: (cb: (change: ResultsChanged) => void): (() => void) => {
    const listener = (_e: unknown, change: ResultsChanged): void => cb(change)
    ipcRenderer.on(EV.resultsChanged, listener)
    return () => ipcRenderer.removeListener(EV.resultsChanged, listener)
  },

  /** Stop the countdown and stay on the current source. */
  dismissSuggestion: (): Promise<void> =>
    ipcRenderer.invoke(CH.playDismissSuggestion) as Promise<void>,

  /** Take the offer: move on, and count the source being left as tried. */
  acceptSuggestion: (): Promise<boolean> =>
    ipcRenderer.invoke(CH.playAcceptSuggestion) as Promise<boolean>,

  /**
   * The standing "this source failed, try another" offer, or null.
   *
   * Drawn here rather than in the app window because the app window cannot
   * draw over the video at all — a banner there has to *reserve* a band, and
   * reserving one is what squashed the picture every time a provider failed.
   */
  onSuggestion: (callback: (suggestion: PlayerSuggestion | null) => void): (() => void) => {
    const listener = (_event: unknown, suggestion: PlayerSuggestion | null): void =>
      callback(suggestion)
    ipcRenderer.on(EV.playerSuggestion, listener)
    return () => ipcRenderer.removeListener(EV.playerSuggestion, listener)
  },
  onMini: (callback: (mini: boolean) => void): (() => void) => {
    const listener = (_event: unknown, mini: boolean): void => callback(mini)
    ipcRenderer.on(EV.playerMini, listener)
    return () => ipcRenderer.removeListener(EV.playerMini, listener)
  },

  /**
   * The skip button was pressed.
   *
   * No seconds and no episode: the main process is the only thing that knows
   * what the button stands for, and acts on the offer it is showing.
   */
  skip: (): void => {
    ipcRenderer.send(EV.chromeSkip)
  },

  /**
   * Report the button's measured size.
   *
   * The same obligation as `setOverlayArea` and for the same reason: this
   * view swallows every mouse event inside its bounds, so it is sized to the
   * button and not one pixel more.
   */
  setSkipSize: (width: number, height: number): void => {
    ipcRenderer.send(EV.chromeSkipSize, {
      width: Math.max(0, Math.round(width)),
      height: Math.max(0, Math.round(height)),
    })
  },

  onSkipOffer: (callback: (offer: SkipOffer | null) => void): (() => void) => {
    const listener = (_event: unknown, offer: SkipOffer | null): void => callback(offer)
    ipcRenderer.on(EV.playerSkipOffer, listener)
    return () => ipcRenderer.removeListener(EV.playerSkipOffer, listener)
  },

  /** What is playing, and which sources could play it. Re-sent on every change. */
  onContext: (callback: (context: PlayerContext) => void): (() => void) => {
    const listener = (_event: unknown, context: PlayerContext): void => callback(context)
    ipcRenderer.on(EV.playerContext, listener)
    return () => ipcRenderer.removeListener(EV.playerContext, listener)
  },
}

contextBridge.exposeInMainWorld('wtaChrome', api)
