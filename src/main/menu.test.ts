/**
 * Every shortcut in the application menu is one shortcut.
 *
 * The accelerators here are the app's real keyboard shortcuts (see the
 * header of `menu.ts`), and a role brings an accelerator of its own when it
 * is not given one. That is how View → Reload, a role with Electron's default
 * CmdOrCtrl+R, came to share a key with Check Releases Now, so that one of
 * the two never fired from the keyboard.
 */
import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

let template: MenuItemConstructorOptions[] = []

vi.mock('electron', () => ({
  app: { getName: () => 'WatchThemAll', getVersion: () => '0.0.0', quit: () => {} },
  Menu: {
    buildFromTemplate: (built: MenuItemConstructorOptions[]) => (template = built),
    setApplicationMenu: () => {},
  },
  Tray: class {},
  dialog: {},
  shell: {},
}))

const { buildMenu } = await import('./menu')

/**
 * The accelerators Electron gives the roles this menu uses, when the item
 * names none: read out of Electron 42's own role table, as it defines them
 * on Linux. A role missing here fails the test rather than being skipped.
 */
const ROLE_DEFAULTS: Record<string, string | null> = {
  undo: 'CommandOrControl+Z',
  redo: 'Shift+CommandOrControl+Z',
  cut: 'CommandOrControl+X',
  copy: 'CommandOrControl+C',
  paste: 'CommandOrControl+V',
  selectAll: 'CommandOrControl+A',
  reload: 'CmdOrCtrl+R',
  forceReload: 'Shift+CmdOrCtrl+R',
  toggleDevTools: 'Ctrl+Shift+I',
  resetZoom: 'CommandOrControl+0',
  zoomIn: 'CommandOrControl+Plus',
  zoomOut: 'CommandOrControl+-',
  togglefullscreen: 'F11',
  quit: 'CommandOrControl+Q',
  close: 'CommandOrControl+W',
}

/** One spelling per key: modifiers by one name each and in one order. */
function normalise(accelerator: string): string {
  const alias: Record<string, string> = {
    commandorcontrol: 'cmdorctrl',
    cmdorctrl: 'cmdorctrl',
    control: 'ctrl',
    ctrl: 'ctrl',
    option: 'alt',
    alt: 'alt',
    shift: 'shift',
  }
  const parts = accelerator.split('+').map((part) => part.toLowerCase())
  const key = parts.pop()!
  return [...parts.map((part) => alias[part] ?? part).sort(), key].join('+')
}

/** Every menu item that answers to a key, with the key it answers to. */
function shortcuts(items: MenuItemConstructorOptions[]): Array<{ item: string; key: string }> {
  return items.flatMap((item) => {
    const nested = Array.isArray(item.submenu) ? shortcuts(item.submenu) : []
    let accelerator = typeof item.accelerator === 'string' ? item.accelerator : null
    if (accelerator === null && item.role) {
      if (!(item.role in ROLE_DEFAULTS)) throw new Error(`add Electron's default accelerator for the "${item.role}" role`)
      accelerator = ROLE_DEFAULTS[item.role] ?? null
    }
    const own = accelerator === null ? [] : [{ item: item.label ?? item.role ?? '?', key: normalise(accelerator) }]
    return [...own, ...nested]
  })
}

describe('application menu', () => {
  it('gives every shortcut to one item only', () => {
    buildMenu({
      getMainWindow: () => null,
      createMainWindow: () => {},
      exportData: () => {},
      importData: () => {},
      checkReleasesNow: () => {},
      dataDir: '/tmp',
    })

    const byKey = new Map<string, string[]>()
    for (const { item, key } of shortcuts(template)) byKey.set(key, [...(byKey.get(key) ?? []), item])
    const shared = [...byKey].filter(([, items]) => items.length > 1)

    expect(shared).toEqual([])
  })

  it('keeps Ctrl+R for Check Releases Now', () => {
    const owner = shortcuts(template).find(({ key }) => key === normalise('CmdOrCtrl+R'))
    expect(owner?.item).toBe('Check Releases Now')
  })
})
