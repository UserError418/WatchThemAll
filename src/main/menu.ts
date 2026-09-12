/**
 * Application menu and tray.
 *
 * The accelerators here are the app's real keyboard shortcuts — Electron menu
 * accelerators fire before the renderer sees the key, so defining them in both
 * places means the renderer's handler never runs. The renderer owns only keys
 * with no menu item (search focus, escape, arrow navigation).
 *
 * The original documented Ctrl+1..4 as Home/Bookmarks/Watchlist/History in its
 * README while the menu bound Ctrl+1 to a "Providers" tab that the UI did not
 * have, so Ctrl+1 and Ctrl+2 both landed on Bookmarks.
 */

import { app, Menu, Tray, dialog, shell, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { EV } from '@shared/ipc'

export interface MenuDeps {
  getMainWindow: () => BrowserWindow | null
  createMainWindow: () => void
  exportData: () => void
  importData: () => void
  checkReleasesNow: () => void
  dataDir: string
}

function send(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

export function buildMenu(deps: MenuDeps): void {
  const isMac = process.platform === 'darwin'
  const win = () => deps.getMainWindow()

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'Export Data…', accelerator: 'CmdOrCtrl+E', click: deps.exportData },
        { label: 'Import Data…', accelerator: 'CmdOrCtrl+I', click: deps.importData },
        { type: 'separator' },
        {
          label: 'Check Releases Now',
          accelerator: 'CmdOrCtrl+R',
          click: deps.checkReleasesNow,
        },
        {
          label: 'Open Data Folder',
          click: () => void shell.openPath(deps.dataDir),
        },
        { type: 'separator' },
        isMac ? { role: 'close', label: 'Close Window' } : { role: 'quit', label: 'Quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Go',
      submenu: [
        {
          label: 'Browse',
          accelerator: 'CmdOrCtrl+1',
          click: () => send(win(), EV.navigate, 'browse'),
        },
        {
          label: 'Search',
          accelerator: 'CmdOrCtrl+2',
          click: () => send(win(), EV.navigate, 'search'),
        },
        {
          label: 'Watchlist',
          accelerator: 'CmdOrCtrl+3',
          click: () => send(win(), EV.navigate, 'watchlist'),
        },
        {
          label: 'Releases',
          accelerator: 'CmdOrCtrl+4',
          click: () => send(win(), EV.navigate, 'releases'),
        },
        { type: 'separator' },
        {
          label: 'Command Palette…',
          accelerator: 'CmdOrCtrl+K',
          click: () => send(win(), EV.menuAction, 'focus-search'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Shift+I' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: `About ${app.getName()}`,
          click: () => {
            const target = win()
            const options = {
              type: 'info' as const,
              title: `About ${app.getName()}`,
              message: app.getName(),
              detail:
                `Version ${app.getVersion()}\n\n` +
                'A navigator for third-party video embeds, with release tracking.\n' +
                'Metadata by TMDB. This app hosts no media.',
            }
            if (target) void dialog.showMessageBox(target, options)
            else void dialog.showMessageBox(options)
          },
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * Tray icon. Wrapped because it genuinely fails on some Linux desktops that
 * have no system tray — that is not an error worth taking the app down for,
 * but it is worth logging rather than swallowing.
 */
export function createTray(dirname: string, deps: MenuDeps): Tray | null {
  try {
    const tray = new Tray(join(dirname, '../../icons/icon48.png'))
    tray.setToolTip('WatchThemAll')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Open WatchThemAll',
          click: () => {
            const win = deps.getMainWindow()
            if (win && !win.isDestroyed()) {
              win.show()
              win.focus()
            } else {
              deps.createMainWindow()
            }
          },
        },
        { label: 'Check Releases Now', click: deps.checkReleasesNow },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ]),
    )
    tray.on('click', () => {
      const win = deps.getMainWindow()
      if (win && !win.isDestroyed()) {
        win.show()
        win.focus()
      } else {
        deps.createMainWindow()
      }
    })
    return tray
  } catch (err) {
    console.error('[tray] unavailable on this desktop:', err)
    return null
  }
}
