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
  PlayerContext,
  PlayerSuggestion,
  SkipOffer,
  TitleProviderState,
  TitleRef,
  WtaChromeApi,
} from '@shared/ipc'
import type { Season } from '@shared/types'

const api: WtaChromeApi = {
  /**
   * Ask main to resize the overlay view to exactly this many CSS pixels tall.
   *
   * The load-bearing one. A `WebContentsView` swallows every mouse event inside
   * its bounds, so an overlay sized to the whole window would make the video
   * unclickable. The document measures itself and main follows.
   */
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

  setOverlayHeight: (height: number): void => {
    ipcRenderer.send(EV.chromeOverlayHeight, Math.max(0, Math.round(height)))
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
  outcomes: (media: TitleRef): Promise<TitleProviderState> =>
    ipcRenderer.invoke(CH.providersOutcomes, media) as Promise<TitleProviderState>,

  /** Stop the countdown and stay on the current source. */
  dismissSuggestion: (): Promise<void> =>
    ipcRenderer.invoke(CH.playDismissSuggestion) as Promise<void>,

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

  /**
   * Jump past the intro.
   *
   * Seconds rather than "skip the intro", so the main process stays the only
   * thing that knows where the intro is — this view is told where to land and
   * nothing about how that was decided.
   */
  skipTo: (seconds: number): void => {
    ipcRenderer.send(EV.chromeSkipTo, seconds)
  },

  /**
   * Report the button's measured size.
   *
   * The same obligation as `setOverlayHeight` and for the same reason: this
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
