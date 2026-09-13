/**
 * The preload bridge — the only path from renderer to main.
 *
 * Every method is enumerated and typed against `WtaApi`. The renderer cannot
 * name a channel that is not listed here, and TypeScript fails the build if
 * this object stops matching the contract.
 *
 * Each `on.*` subscription returns its own unsubscribe function. The original
 * registered `ipcRenderer.on` listeners with no way to remove them, so every
 * re-mount added another.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { CH, EV } from '@shared/ipc'
import type {
  DiscoverRequest,
  GenreRowRequest,
  MalDecisions,
  PlayRequest,
  RowRequest,
  TailoredRequest,
  TitleRef,
  WtaApi,
} from '@shared/ipc'
import type { MediaSummary, MediaType, StoreShape } from '@shared/types'

function subscribe(channel: string, cb: (...args: never[]) => void): () => void {
  const listener = (_event: unknown, ...args: unknown[]) =>
    (cb as (...a: unknown[]) => void)(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: WtaApi = {
  store: {
    read: () => ipcRenderer.invoke(CH.storeRead),
    write: (patch: Partial<StoreShape>) => ipcRenderer.invoke(CH.storeWrite, patch),
  },
  tmdb: {
    row: (req: RowRequest | GenreRowRequest | DiscoverRequest) => ipcRenderer.invoke(CH.tmdbRow, req),
    tailored: (req: TailoredRequest) => ipcRenderer.invoke(CH.tmdbTailored, req),
    search: (query: string, page: number) => ipcRenderer.invoke(CH.tmdbSearch, query, page),
    detail: (tmdbId: number, type: MediaType) => ipcRenderer.invoke(CH.tmdbDetail, tmdbId, type),
    season: (tmdbId: number, season: number) => ipcRenderer.invoke(CH.tmdbSeason, tmdbId, season),
    genres: (type: MediaType) => ipcRenderer.invoke(CH.tmdbGenres, type),
    trailer: (tmdbId: number, type: MediaType) =>
      ipcRenderer.invoke(CH.tmdbTrailer, tmdbId, type),
  },
  search: (query: string, page: number) => ipcRenderer.invoke(CH.search, query, page),
  resolve: (item: MediaSummary) => ipcRenderer.invoke(CH.searchResolve, item),
  providers: {
    list: () => ipcRenderer.invoke(CH.providersList),
    outcomes: (media: TitleRef) => ipcRenderer.invoke(CH.providersOutcomes, media),
  },
  releases: {
    checkNow: () => ipcRenderer.invoke(CH.releasesCheck),
  },
  play: (req: PlayRequest) => ipcRenderer.invoke(CH.playOpen, req),
  player: {
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke(CH.playSetBounds, bounds),
    close: () => ipcRenderer.invoke(CH.playClose),
    goTo: (season: number, episode: number) => ipcRenderer.invoke(CH.playGoTo, season, episode),
    switchProvider: (providerId: string) =>
      ipcRenderer.invoke(CH.playSwitchProvider, providerId),
    dismissSuggestion: () => ipcRenderer.invoke(CH.playDismissSuggestion),
    reload: () => ipcRenderer.invoke(CH.playReload),
  },
  mal: {
    preview: () => ipcRenderer.invoke(CH.malPreview),
    commit: (decisions: MalDecisions) => ipcRenderer.invoke(CH.malImport, decisions),
  },
  openExternal: (url: string) => ipcRenderer.invoke(CH.openExternal, url),
  data: {
    export: () => ipcRenderer.invoke(CH.dataExport),
    import: (payload: unknown) => ipcRenderer.invoke(CH.dataImport, payload),
    dir: () => ipcRenderer.invoke(CH.dataDir),
  },
  sync: {
    status: () => ipcRenderer.invoke(CH.syncStatus),
    connect: () => ipcRenderer.invoke(CH.syncConnect),
    cancel: () => ipcRenderer.invoke(CH.syncCancel),
    disconnect: () => ipcRenderer.invoke(CH.syncDisconnect),
    now: () => ipcRenderer.invoke(CH.syncNow),
  },
  on: {
    menuAction: (cb) => subscribe(EV.menuAction, cb),
    navigate: (cb) => subscribe(EV.navigate, cb),
    releaseFound: (cb) => subscribe(EV.releaseFound, cb),
    episodeWatched: (cb) => subscribe(EV.episodeWatched, cb),
    storeChanged: (cb) => subscribe(EV.storeChanged, cb),
    playbackActive: (cb) => subscribe(EV.playbackActive, cb),
    playerState: (cb) => subscribe(EV.playerState, cb),
    playerSuggestion: (cb) => subscribe(EV.playerSuggestion, cb),
    playerPointerTop: (cb) => subscribe(EV.playerPointerTop, cb),
    syncStatus: (cb) => subscribe(EV.syncStatus, cb),
    malProgress: (cb) => subscribe(EV.malProgress, cb),
  },
}

contextBridge.exposeInMainWorld('wta', api)
