/**
 * Window creation and window-state persistence.
 *
 * Two window kinds with deliberately different security postures:
 *
 * The **app window** loads only local files and runs with `webSecurity` on
 * behind a CSP. It can afford to because the renderer makes no network calls —
 * everything goes through IPC to the main process.
 *
 * **Player windows** load untrusted third-party embed pages. `webSecurity` has
 * to stay off there (video CDNs are cross-origin from the embed page), so
 * everything else is locked down instead: no Node, context isolation on, and
 * every popup denied. Embed pages are an ad-injection surface and will try.
 */

import { BrowserWindow, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { suppressEmbedChrome } from './embedchrome'

interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

const DEFAULT_STATE: WindowState = { width: 1440, height: 900 }

export function loadWindowState(dir: string): WindowState {
  const file = join(dir, 'window-state.json')
  try {
    if (existsSync(file)) {
      return { ...DEFAULT_STATE, ...(JSON.parse(readFileSync(file, 'utf-8')) as WindowState) }
    }
  } catch (err) {
    console.error('[windows] window state unreadable, using defaults:', err)
  }
  return DEFAULT_STATE
}

export function saveWindowState(dir: string, win: BrowserWindow): void {
  try {
    mkdirSync(dir, { recursive: true })
    // `getBounds()` on a maximized window reports the maximized size, which
    // then becomes the restored size next launch. Use the normal bounds.
    const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds()
    const state: WindowState = { ...bounds, maximized: win.isMaximized() }
    writeFileSync(join(dir, 'window-state.json'), JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    console.error('[windows] could not save window state:', err)
  }
}

/** Debounce state writes — resize fires continuously while dragging. */
function debounce(fn: () => void, ms: number): () => void {
  let timer: NodeJS.Timeout | null = null
  return () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(fn, ms)
  }
}

export function createAppWindow(
  dirname: string,
  dataDir: string,
  /** Loopback server base URL; null when Vite is serving in dev. */
  rendererBaseUrl: string | null,
): BrowserWindow {
  const state = loadWindowState(dataDir)

  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0b0f',
    title: 'WatchThemAll',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      /*
       * Previews are unmuted by default, and Chromium blocks unmuted autoplay
       * without a user gesture.
       *
       * The blocked embed does not fail loudly — it sits there *paused*, and a
       * paused YouTube player draws its transport controls over the picture and
       * leaves them there. That is the "the YouTube buttons are still visible"
       * report, and it is why cropping them away and delaying the reveal both
       * failed: the overlay was not a start-up animation waiting to finish, it
       * was the paused state, and it was never going to clear.
       *
       * Scoped to this window. The player view sets it separately for its own
       * reasons; nothing else in the app plays media.
       */
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  if (state.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())

  // Trailer previews are cross-origin YouTube frames; only the main process can
  // reach inside one to style its chrome away. See `embedchrome.ts`.
  suppressEmbedChrome(win.webContents)

  // Nothing in the app UI should spawn a window; external links belong in the
  // system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const persist = debounce(() => saveWindowState(dataDir, win), 400)
  win.on('resize', persist)
  win.on('move', persist)
  win.on('close', () => saveWindowState(dataDir, win))

  // Always an http(s) origin, never `file://` — see localserver.ts for why.
  const url = process.env.ELECTRON_RENDERER_URL ?? `${rendererBaseUrl}/index.html`
  void win.loadURL(url)

  return win
}
