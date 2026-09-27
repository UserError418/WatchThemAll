/**
 * The app window's saved size, fitted to the display it opens on.
 *
 * Plain logic with no Electron in it; `windows.ts` reads and writes the file
 * and asks `screen` for the work area. Tested in `windowstate.test.ts`.
 */

export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

export interface WorkArea {
  width: number
  height: number
}

export const DEFAULT_STATE: WindowState = { width: 1440, height: 900 }

/**
 * Room left for a title bar. The saved size is the content's, and the window
 * manager puts its title bar on top of it; under Wayland, Electron cannot ask
 * how tall that is (it reports bounds and content bounds as equal). 48 is more
 * than any common theme takes.
 */
export const TITLE_BAR_ALLOWANCE = 48

/**
 * The state to open with.
 *
 * A saved size that leaves no room for a title bar, and that also spans the
 * display's width, is a maximized window, whatever the file says. Opened as
 * saved, the title bar lands on top of a content area already the display's
 * height, and the window's bottom, with the player's controls, ends below the
 * screen's edge. That is what the owner's PC had (2026-09-27): 2844×1600, not
 * maximized, on a 2844×1600 display, saved while the player was fullscreen.
 *
 * A size that is merely too large (a bigger display, since disconnected) is
 * shrunk to fit.
 */
export function fitToDisplay(saved: WindowState, workArea: WorkArea): WindowState {
  const maxHeight = workArea.height - TITLE_BAR_ALLOWANCE
  const fillsWidth = saved.width >= workArea.width - TITLE_BAR_ALLOWANCE
  if (saved.height > maxHeight && fillsWidth) {
    // Its un-maximized size is the default, fitted: the saved one is the display's.
    return {
      width: Math.min(DEFAULT_STATE.width, workArea.width),
      height: Math.min(DEFAULT_STATE.height, maxHeight),
      maximized: true,
    }
  }
  return {
    ...saved,
    width: Math.min(saved.width, workArea.width),
    height: Math.min(saved.height, maxHeight),
  }
}
