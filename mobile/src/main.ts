/**
 * The phone app's entry point.
 *
 * Mirrors `src/renderer/src/main.ts` with one addition that has to happen
 * first: `window.wta` must exist before `App` mounts, because the library
 * module calls it during its own initialisation. The desktop build gets that
 * for free — the preload script runs before any renderer code — so this is the
 * one place the two entries genuinely differ.
 */

import { mount } from 'svelte'
import App from '@/App.svelte'
import { StatusBar, Style } from '@capacitor/status-bar'
import '@/styles/fonts.css'
import '@/styles/tokens.css'
import '@/styles/global.css'
import './styles/mobile.css'
import { createBridge } from './bridge'

/**
 * Show a failure the user can act on, instead of a white screen.
 *
 * Everything in `start` runs before Svelte mounts, so a throw anywhere in it —
 * an unreadable store, a plugin missing from the APK, a bad migration — leaves
 * the WebView showing an empty `<div id="app">` and no way to report it. On
 * desktop that same failure at least leaves a window with a menu and a DevTools
 * console; on a phone it is indistinguishable from the app being broken beyond
 * repair.
 *
 * Deliberately plain DOM and inline styles: this has to render when the reason
 * it is rendering might be that the app's own modules did not load.
 */
function renderStartupFailure(error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const target = document.getElementById('app')
  if (!target) return

  target.innerHTML = ''
  const panel = document.createElement('div')
  panel.style.cssText =
    'padding:24px;font:15px/1.5 system-ui,sans-serif;color:#e8e6ef;background:#0a0a0f;min-height:100vh'
  const heading = document.createElement('h1')
  heading.textContent = 'WatchThemAll could not start'
  heading.style.cssText = 'font-size:20px;margin:0 0 12px'
  const detail = document.createElement('p')
  detail.textContent = message
  detail.style.cssText =
    'font-family:ui-monospace,monospace;font-size:13px;color:#f4c86a;word-break:break-word'
  const hint = document.createElement('p')
  hint.textContent =
    'Your library is still on the device. Reopening the app is worth trying first; if this keeps happening, reinstalling loses the library unless you exported it.'
  hint.style.cssText = 'color:#9a97ab'

  panel.append(heading, detail, hint)
  target.appendChild(panel)
}

async function start(): Promise<void> {
  window.wta = await createBridge()

  /**
   * Draw behind the status bar rather than under it.
   *
   * The nav is translucent over artwork, and a reserved system strip above it
   * puts a hard grey band across the top of every poster. `viewport-fit=cover`
   * plus the safe-area padding in mobile.css is what keeps the content clear.
   * Wrapped because these throw on a browser preview, where there is no bar.
   */
  try {
    await StatusBar.setOverlaysWebView({ overlay: true })
    await StatusBar.setStyle({ style: Style.Dark })
  } catch {
    // Not running on a device. The layout is identical either way.
  }

  mount(App, { target: document.getElementById('app')! })
}

void start().catch((error: unknown) => {
  console.error('[startup] failed:', error)
  renderStartupFailure(error)
})
