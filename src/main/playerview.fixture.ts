/**
 * Stand-ins for the Electron objects `playerview.ts` touches, for its tests
 * (`playerview.test.ts`, and `webrequesthub.test.ts` for the session).
 *
 * Only as much of each as the player uses, plus the two behaviours of the real
 * thing those tests are about, both measured on Electron 42.5.0:
 *
 * - A session keeps **one** listener per `webRequest` event: registering a
 *   second replaces the first (`FakeWebRequest`).
 * - A frame of a page that has been navigated away from never answers an
 *   `executeJavaScript` that was still pending, and the new page commits within
 *   milliseconds (`hangingFrame`). Advert frames mid-navigation do the same,
 *   which is why the player races every frame against a timeout.
 */

import { EventEmitter } from 'node:events'
import type { PlayRequest } from '@shared/ipc'
import type { PlayCandidate } from './providers'

type Listener = ((details: unknown) => void) | null
type ObservedEvent = 'sendHeaders' | 'completed' | 'errorOccurred'

export class FakeWebRequest {
  /** What Electron would call, per event: the last listener registered, as there. */
  private readonly listeners = new Map<ObservedEvent, Listener>()

  onSendHeaders(_filter: unknown, listener: Listener): void {
    this.listeners.set('sendHeaders', listener)
  }
  onCompleted(_filter: unknown, listener: Listener): void {
    this.listeners.set('completed', listener)
  }
  onErrorOccurred(_filter: unknown, listener: Listener): void {
    this.listeners.set('errorOccurred', listener)
  }

  /** A request event, as the network stack would report it. */
  emit(event: ObservedEvent, details: Record<string, unknown>): void {
    this.listeners.get(event)?.(details)
  }

  /** Whether anything is listening to `event`, for unsubscribing. */
  listening(event: ObservedEvent): boolean {
    return (this.listeners.get(event) ?? null) !== null
  }
}

export class FakeSession {
  readonly webRequest = new FakeWebRequest()
  on(): void {}
  setUserAgent(): void {}
}

export interface FakeFrame {
  /** Every second a seek asked this frame's film to go to, in order. */
  seeks: number[]
  executeJavaScript(script: string): Promise<unknown>
}

/** A frame holding the film: answers every reading at once, and notes seeks. */
export function filmFrame(reading: () => { seconds: number; duration: number }): FakeFrame {
  const frame: FakeFrame = {
    seeks: [],
    executeJavaScript(script) {
      const seek = /currentTime = ([\d.]+)/.exec(script)
      if (seek) {
        frame.seeks.push(Number(seek[1]))
        return Promise.resolve(null)
      }
      const { seconds, duration } = reading()
      return Promise.resolve(JSON.stringify({ seconds, duration, ended: false, paused: false, width: 1280, height: 720 }))
    },
  }
  return frame
}

/** A frame that never answers: an advert mid-navigation, or any frame of a page just left. */
export function hangingFrame(): FakeFrame {
  return { seeks: [], executeJavaScript: () => new Promise(() => {}) }
}

/** A frame that answers at once and holds no video: the shell, or a page still loading. */
export function emptyFrame(): FakeFrame {
  return { seeks: [], executeJavaScript: () => Promise.resolve(null) }
}

export class FakeContents extends EventEmitter {
  readonly session = new FakeSession()
  /** The frames `mainFrame.framesInSubtree` lists: set by the test as pages come and go. */
  frames: FakeFrame[] = []
  readonly loads: string[] = []
  private destroyed = false
  readonly mainFrame = {
    contents: this,
    get framesInSubtree(): FakeFrame[] {
      return this.contents.frames
    },
  }

  setBackgroundThrottling(): void {}
  setAudioMuted(): void {}
  setWindowOpenHandler(): void {}
  send(): void {}
  focus(): void {}
  reload(): void {}
  loadURL(url: string): Promise<void> {
    this.loads.push(url)
    return Promise.resolve()
  }
  executeJavaScript(): Promise<unknown> {
    return Promise.resolve(null)
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  close(): void {
    this.destroyed = true
  }

  /** The shell this load asked for has replaced the page before it. */
  commit(): void {
    this.emit('did-navigate', {}, 'http://127.0.0.1/__player', 200, 'OK')
  }
}

const created: FakeContents[] = []

/** The web contents of the view the player made most recently. */
export function lastContents(): FakeContents {
  const contents = created[created.length - 1]
  if (contents === undefined) throw new Error('no player view has been created')
  return contents
}

class FakeView {
  readonly webContents = new FakeContents()
  constructor() {
    created.push(this.webContents)
  }
  setBounds(): void {}
  getBounds(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: 1280, height: 720 }
  }
  setBackgroundColor(): void {}
}

/** The module `vi.mock('electron', …)` hands to the player. */
export const fakeElectron = {
  WebContentsView: FakeView,
  BrowserWindow: class {},
  ipcMain: { on: (): void => {}, removeListener: (): void => {} },
  webFrameMain: { fromId: (): null => null },
}

/** The app window, as the player uses it. */
export function fakeWindow(): unknown {
  return {
    isDestroyed: () => false,
    isFullScreen: () => false,
    setFullScreen: () => {},
    on: () => {},
    removeListener: () => {},
    contentView: { addChildView: () => {}, removeChildView: () => {} },
    webContents: { send: () => {} },
  }
}

/** A source that can serve anything, under `id`. */
export function candidate(id: string): PlayCandidate {
  const rootUrl = `https://${id}.example/`
  return {
    provider: { id, name: id.toUpperCase(), rootUrl, tv: { urlTemplate: `${rootUrl}tv` }, movie: { urlTemplate: `${rootUrl}movie` } },
    url: `${rootUrl}play`,
  }
}

/** Episode `episode` of season 1 of a 45-minute series. */
export function episodeRequest(episode: number): PlayRequest {
  return { tmdbId: 1, imdbId: 'tt0000001', type: 'tv', title: 'A series', season: 1, episode, providerId: null, runtimeMinutes: 45 }
}
