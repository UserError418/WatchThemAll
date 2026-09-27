/**
 * v2's own controls on the phone: the hub between them and the top bar. The
 * overlay's host is `overlayhost.ts`.
 *
 * On the desktop our controls (`PlayerOverlay.svelte`) live in the `/__player`
 * shell and the top bar (`PlayerChrome.svelte`) in a view of its own, and main
 * carries what one tells the other: the pointer moved, our controls have the
 * film, open a panel, the bar is up or down. Here both are in the app's one
 * document, so this hub carries the same things with plain signals. The two
 * components are the desktop's, and neither can tell the difference.
 *
 * ## Delivered later, as IPC delivers
 *
 * Every message crosses on a microtask, never inside the sender's call. The
 * two components were written against IPC, which is asynchronous, and they
 * call each other from their effects. Delivered at once, the top bar's
 * `activityTick += 1` ran inside our controls' effect, which then depended on
 * what it had just written and looped until Svelte stopped it
 * (`effect_update_depth_exceeded`, measured on the emulator 2026-09-27): the
 * overlay froze at its first report.
 */

import type { BarState, EpisodeNav, OverlayArea, WtaChromeApi } from '@shared/ipc'
import { Signal } from './events'

type Panel = 'episodes' | 'cast' | 'sources'

/** A signal whose latest value a late subscriber still receives, as `remembered` does in the desktop's preload. */
class Remembered<T> {
  private readonly signal = new Signal<T>()
  constructor(private value: T) {}
  get(): T {
    return this.value
  }
  set(next: T): void {
    this.value = next
    this.signal.emit(next)
  }
  subscribe(cb: (value: T) => void): () => void {
    cb(this.value)
    return this.signal.subscribe(cb)
  }
}

export interface OverlayHub {
  /** What the top bar's API needs from here; spread into `createChromeApi`'s result. */
  chrome: Pick<WtaChromeApi, 'setOverlayArea' | 'onActivity' | 'onOwned' | 'onOpenPanel' | 'onDismiss' | 'onEpisodeNav'>
  /** The overlay's side, for the bridge's `WtaPlayerApi`. */
  activity(hold: boolean): void
  owned(owned: boolean): void
  openPanel(panel: Panel): void
  dismiss(): void
  onBarState(cb: (state: BarState) => void): () => void
  /** Whether a panel of the top bar is open: Back closes it before anything else. */
  panelOpen(): boolean
  /** Close whichever panel is open. */
  closePanel(): void
}

/** Run `deliver` after the current call and its effects, as a message over IPC would arrive. */
const later = (deliver: () => void): void => queueMicrotask(deliver)

export function createOverlayHub(): OverlayHub {
  const activity = new Signal<boolean>()
  const owned = new Signal<boolean>()
  const openPanel = new Signal<Panel>()
  const dismiss = new Signal<void>()
  const episodeNav = new Signal<EpisodeNav>()
  const barState = new Remembered<BarState>({ visible: true, away: false })
  let panelOpen = false
  let latestBar: BarState = barState.get()

  return {
    chrome: {
      setOverlayArea(area: OverlayArea) {
        panelOpen = area.episodesOpen === true || area.sourcesOpen === true
        const next = { visible: area.barVisible !== false, away: area.away === true }
        // Compared with the latest said, not the latest delivered: two areas
        // can arrive before the first is delivered.
        if (next.visible !== latestBar.visible || next.away !== latestBar.away) {
          latestBar = next
          later(() => barState.set(latestBar))
        }
      },
      onActivity: (cb) => activity.subscribe(cb),
      onOwned: (cb) => owned.subscribe(cb),
      onOpenPanel: (cb) => openPanel.subscribe(cb),
      onDismiss: (cb) => dismiss.subscribe(() => cb()),
      onEpisodeNav: (cb) => episodeNav.subscribe(cb),
    },
    activity: (hold) => later(() => activity.emit(hold)),
    owned: (value) => later(() => owned.emit(value)),
    openPanel: (panel) => later(() => openPanel.emit(panel)),
    dismiss: () => later(() => dismiss.emit(undefined)),
    onBarState: (cb) => barState.subscribe(cb),
    panelOpen: () => panelOpen,
    // The chrome's own "close" for the episode keys closes any panel.
    closePanel: () => later(() => episodeNav.emit('close')),
  }
}
