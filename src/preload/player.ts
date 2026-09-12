/**
 * Preload for player windows.
 *
 * Runs inside an untrusted third-party embed page. It exposes **nothing** to
 * that page — there is no `contextBridge` call here.
 *
 * It used to draw the whole control layer: episode stepping, the source
 * switcher, reload. Those now live in the app's own chrome bar above the video,
 * where they are ordinary DOM instead of buttons injected into a hostile page
 * that repaints them away. What is left here is the two jobs that genuinely
 * cannot be done from outside — the keyboard, because the native view swallows
 * key events before the app window sees them, and the toast, because it has to
 * appear over the picture.
 *
 * Why the main process supplies the episode grammar instead of this file
 * guessing it: the original parsed the URL with three fallback heuristics
 * (query params, then any `tt`-looking path segment, then any two small numbers
 * in a row) and mis-detected episodes whenever a provider's path happened to
 * contain other digits. Here, main knows exactly which template produced the
 * URL, so it says which fields mean what.
 */

import { ipcRenderer } from 'electron'
import { EV } from '@shared/ipc'
import type { PlayerContext } from '@shared/ipc'

let context: PlayerContext | null = null
/** Message to show after the next render, set before a provider switch. */
let pendingToast: string | null = null
let current = { season: 0, episode: 0 }

ipcRenderer.on(EV.playerContext, (_event, payload: PlayerContext) => {
  context = payload
  current = { season: payload.season ?? 0, episode: payload.episode ?? 0 }
  render()
})

/**
 * Playback fell back to another provider on its own.
 *
 * Saying so matters: a window that silently reloads into a different source
 * looks like a glitch, and the user has no way to know their preferred
 * provider is the one that is broken.
 */
ipcRenderer.on(
  EV.playerProviderChanged,
  (_event, payload: { providerId: string; providerName: string; reason: string }) => {
    if (context) {
      context = { ...context, providerId: payload.providerId, providerName: payload.providerName }
    }
    /**
     * Queue the message rather than showing it now.
     *
     * This event arrives immediately *before* the window navigates to the new
     * provider, and that load rebuilds the whole control layer — a toast shown
     * here is wiped a second later and the user never learns why their source
     * changed. `render()` drains the queue once the new page is up.
     */
    pendingToast = `Switched to ${payload.providerName} — previous source failed (${payload.reason})`
  },
)

/* ── Navigation ─────────────────────────────────────────────────────────── */

/**
 * Rebuild the current URL for a different episode using the same template that
 * produced it, and navigate there.
 */
function goTo(season: number, episode: number): void {
  if (!context || season < 1 || episode < 1) return
  ipcRenderer.send(EV.playerNavigate, { season, episode })
}

/* ── Controls ───────────────────────────────────────────────────────────── */

const STYLE_ID = 'wta-player-style'
const ROOT_ID = 'wta-player-controls'

const CSS = `
#${ROOT_ID} { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;
  font-family: system-ui, -apple-system, sans-serif; }

/* Shown when playback falls back to another provider on its own. */
#${ROOT_ID} .wta-toast { position: absolute; left: 50%; bottom: 58px; pointer-events: none;
  transform: translateX(-50%); padding: 9px 16px; border-radius: 10px;
  background: rgba(12,12,22,0.94); color: #fff; font-size: 12px; font-weight: 600;
  border: 1px solid rgba(255,255,255,0.14); opacity: 0;
  transition: opacity 220ms ease; }
#${ROOT_ID} .wta-toast.show { opacity: 1; }
`

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head?.appendChild(style)
}



/** Briefly explain an automatic provider change, then fade out. */
function showToast(message: string): void {
  const root = document.getElementById(ROOT_ID)
  if (!root) return
  root.querySelector('.wta-toast')?.remove()

  const toast = document.createElement('div')
  toast.className = 'wta-toast'
  toast.textContent = message
  root.appendChild(toast)

  requestAnimationFrame(() => toast.classList.add('show'))
  setTimeout(() => {
    toast.classList.remove('show')
    setTimeout(() => toast.remove(), 400)
  }, 4200)
}

function render(): void {
  if (!context || !document.body) return

  ensureStyle()
  document.getElementById(ROOT_ID)?.remove()

  // A bare container. The controls that used to hang off it are in the app's
  // chrome bar now; this exists so the toast has somewhere to appear.
  const root = document.createElement('div')
  root.id = ROOT_ID
  document.body.appendChild(root)

  if (pendingToast) {
    const message = pendingToast
    pendingToast = null
    showToast(message)
  }
}

/* ── Bootstrap ──────────────────────────────────────────────────────────── */

function boot(): void {
  render()

  /**
   * Embed pages are single-page apps that replace the whole body, taking the
   * controls with them. Watch for that and rebuild — debounced, because these
   * pages mutate the DOM continuously and rebuilding on every mutation pins a
   * core.
   */
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null
  const observer = new MutationObserver(() => {
    if (document.getElementById(ROOT_ID)) return
    if (rebuildTimer) clearTimeout(rebuildTimer)
    rebuildTimer = setTimeout(render, 300)
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}

/* ── Keyboard ───────────────────────────────────────────────────────────── */

window.addEventListener(
  'keydown',
  (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    switch (event.key) {
      case 'ArrowLeft':
        if (current.episode > 1) goTo(current.season, current.episode - 1)
        break
      case 'ArrowRight':
        goTo(current.season, current.episode + 1)
        break
      case 'ArrowUp':
        if (current.season > 1) goTo(current.season - 1, 1)
        break
      case 'ArrowDown':
        goTo(current.season + 1, 1)
        break
      case 'r':
      case 'R':
        window.location.reload()
        break
      default:
        return
    }
    event.preventDefault()
  },
  // Capture: embed players swallow arrow keys for their own seek controls.
  true,
)
