/**
 * Preload for the player view's shell.
 *
 * The player view's main frame is our own `/__player` page. The provider
 * plays in a cross-origin iframe inside it, and a preload runs only in the
 * main frame, so nothing here reaches the provider. (This file used to run in
 * the provider's page itself, before the provider was framed. Back then it
 * exposed nothing and injected its controls into the page.)
 *
 * Its one job now is to connect v2's controls (`PlayerOverlay.svelte`) with
 * main: `window.wtaPlayer`, typed as `WtaPlayerApi`. The overlay commands the
 * film itself through the film relay (`filmrelay.ts`), not through here.
 *
 * The last config, context and bar state are kept, and each is handed to a
 * subscriber the moment it subscribes. Main sends them when the shell's DOM is
 * ready, and the overlay's bundle may or may not have subscribed by then. A
 * cache makes the order not matter.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { CH, EV, PREVIEW_MUTED, PREVIEW_STATE } from '@shared/ipc'
import type { BarState, PlayerContext, PlayerOverlayConfig, WtaPlayerApi } from '@shared/ipc'
import { isPlayerAction, isTransportAction, type TransportAction } from '@shared/playerkeys'

/** A channel whose latest value a late subscriber still receives. */
function remembered<T>(channel: string): (cb: (value: T) => void) => () => void {
  let last: { value: T } | null = null
  const subscribers = new Set<(value: T) => void>()
  ipcRenderer.on(channel, (_event, value: T) => {
    last = { value }
    for (const cb of subscribers) cb(value)
  })
  return (cb) => {
    subscribers.add(cb)
    if (last !== null) cb(last.value)
    return () => subscribers.delete(cb)
  }
}

/** A channel of events: only what arrives after subscribing. */
function events<T>(channel: string, accept: (value: unknown) => value is T): (cb: (value: T) => void) => () => void {
  return (cb) => {
    const listener = (_event: unknown, value: unknown): void => {
      if (accept(value)) cb(value)
    }
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

const isChange = (value: unknown): value is { providerName: string; reason: string } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Record<string, unknown>).providerName === 'string' &&
  typeof (value as Record<string, unknown>).reason === 'string'

const api: WtaPlayerApi = {
  onConfig: remembered<PlayerOverlayConfig>(EV.playerOverlayConfig),
  onContext: remembered<PlayerContext>(EV.playerContext),
  onBarState: remembered<BarState>(EV.playerBarState),
  onTransport: events<TransportAction>(EV.playerTransport, isTransportAction),
  onProviderChanged: events(EV.playerProviderChanged, isChange),
  action: (action) => {
    // Checked here as well as in main: the page is ours, but a renderer's
    // messages are never trusted by shape alone.
    if (isPlayerAction(action)) ipcRenderer.send(EV.playerKey, action)
  },
  activity: (hold) => ipcRenderer.send(EV.playerActivity, hold === true),
  pressPlay: () => ipcRenderer.send(EV.playerPressPlay),
  owned: (owned) => ipcRenderer.send(EV.playerOwned, owned === true),
  // Only meaningful in a `<webview>` (the detail view's preview), where the
  // host is the app's page; see `PREVIEW_STATE`.
  preview: {
    report: (state) => ipcRenderer.sendToHost(PREVIEW_STATE, state),
    onMuted: (callback) => {
      const listener = (_event: unknown, muted: unknown): void => {
        if (typeof muted === 'boolean') callback(muted)
      }
      ipcRenderer.on(PREVIEW_MUTED, listener)
      return () => ipcRenderer.removeListener(PREVIEW_MUTED, listener)
    },
  },
  subtitles: {
    languages: () => ipcRenderer.invoke(CH.subtitleLanguages),
    load: (code, filmSeconds) => ipcRenderer.invoke(CH.subtitleLoad, code, filmSeconds),
    remember: (code) => ipcRenderer.invoke(CH.subtitleRemember, code),
  },
}

contextBridge.exposeInMainWorld('wtaPlayer', api)
