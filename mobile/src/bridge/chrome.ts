/**
 * `window.wtaChrome`, implemented for Android.
 *
 * ## Why this file has to exist
 *
 * The player's controls — back, reload, the episode strip, the source
 * switcher — used to live in `PlayerFrame.svelte`, in the app's own document,
 * which is why the phone had them for free. On desktop they then moved into
 * `PlayerChrome.svelte`, a second renderer entry (`chrome.html`) mounted into
 * a transparent `WebContentsView` stacked over the video. They had to: the app
 * window's page always paints *beneath* its native child views, so a menu
 * drawn in it rendered behind the picture.
 *
 * The phone build has one entry and one document, so it inherited none of
 * that. The Android player became a bare full-screen iframe with no title, no
 * exit but the system back gesture, no way to step to the next episode and —
 * the one that turns a small bug into a broken app — **no way to change source
 * when a provider fails to play.** `player.goTo`, `player.switchProvider` and
 * `player.reload` were all implemented in the bridge and unreachable, because
 * the only thing that called them was a document the phone does not build.
 *
 * ## Why the same component rather than a phone-shaped one
 *
 * A second implementation of the source list would eventually disagree with
 * the first about what a green dot means, and the whole port exists on the
 * principle that the renderer is shared. So the phone mounts the *same*
 * `PlayerChrome.svelte`, in the app's own document this time, positioned over
 * the surface iframe — which it can do precisely because the surface is a DOM
 * node here and not a native layer. The component takes one new prop, `touch`,
 * for the two behaviours that cannot survive the move; everything else is the
 * desktop's code path.
 *
 * ## The four members that mean nothing here
 *
 * `setOverlayArea` and `setSkipSize` size a native view so it stops
 * swallowing clicks outside what it draws. A DOM overlay has no such problem:
 * `mobile.css` gives the host `pointer-events: none` and its children `auto`,
 * so the picture below is reachable everywhere the chrome is not painted.
 *
 * `onPointerTop` reports a pointer that does not exist. `onSkipOffer` reports
 * an intro timestamp nothing can vet, because vetting one means reading
 * `duration` off a `<video>` in a cross-origin document. Both return a
 * subscription that never fires rather than throwing, so the component's
 * effects tear down cleanly.
 */

import type { Season } from '@shared/types'
import type {
  PlayerContext,
  PlayerState,
  PlayerSuggestion,
  ProviderScan,
  ProviderScanProgress,
  SkipOffer,
  TitleProviderState,
  TitleRef,
  WtaChromeApi,
} from '@shared/ipc'

/** What the chrome needs from the bridge, and nothing more. */
export interface ChromeDeps {
  /** The player's current state, or null when nothing is playing. */
  subscribeState(cb: (state: PlayerState | null) => void): () => void
  /** The same, read once — see `onContext` for why a subscription is not enough. */
  currentState(): PlayerState | null
  subscribeSuggestion(cb: (suggestion: PlayerSuggestion | null) => void): () => void
  close(): void
  goTo(season: number, episode: number): Promise<void>
  switchProvider(providerId: string): Promise<boolean>
  reload(): Promise<void>
  season(tmdbId: number, season: number): Promise<Season | null>
  outcomes(media: TitleRef): Promise<TitleProviderState>
  /**
   * Test every enabled source against what is playing.
   *
   * Passed through rather than reimplemented: it is the same runner the detail
   * view's picker drives, so a scan started from either surface is one scan,
   * and both draw the same dots from it.
   */
  scan(media: TitleRef, episode?: { season: number; episode: number } | null): Promise<ProviderScan>
  cancelScan(): Promise<void>
  subscribeScan(cb: (progress: ProviderScanProgress) => void): () => void
  /** The cast controls, already built — see `createCastBridge`. */
  cast: WtaChromeApi['cast']
}

/** A subscription that will never fire. Returns an unsubscribe that is a no-op. */
function never<T>(_cb: (value: T) => void): () => void {
  return () => {}
}

export function createChromeApi(deps: ChromeDeps): WtaChromeApi {
  return {
    /**
     * Nothing to size.
     *
     * On desktop this number decides how much of the picture the overlay view
     * makes unclickable. Here the overlay is a DOM node that only intercepts
     * taps where it actually paints.
     */
    setOverlayArea: () => {},
    setSkipSize: () => {},

    back: () => deps.close(),
    goTo: (season, episode) => void deps.goTo(season, episode),
    switchProvider: (providerId) => void deps.switchProvider(providerId),
    reload: () => deps.reload(),
    season: (tmdbId, season) => deps.season(tmdbId, season),
    outcomes: (media) => deps.outcomes(media),
    scan: (media, episode) => deps.scan(media, episode),
    cancelScan: () => deps.cancelScan(),
    onProviderScan: (cb) => deps.subscribeScan(cb),
    cast: deps.cast,

    /** Nothing raises a suggestion here, so there is never one to dismiss. */
    dismissSuggestion: async () => {},
    /** Nor one to accept. */
    acceptSuggestion: async () => false,

    /** No skip offer can be raised, so nothing can ask to be skipped to. */
    skipTo: () => {},

    /**
     * `PlayerState` and `PlayerContext` carry the same nine fields, for the
     * same reason: both answer "what is this window showing". The desktop
     * keeps them apart because they travel different IPC channels to different
     * documents. Here one signal feeds both, so the mapping is a rename.
     *
     * **The current value is replayed before subscribing**, and without that
     * the chrome comes up blank. Desktop sends the context to the overlay when
     * it creates it, so the view cannot exist before it has been told; here the
     * component subscribes from an `$effect`, which Svelte runs a tick after
     * `mount`, by which time the state that opened the player has already been
     * emitted. The bar then showed "Source" instead of the provider's name and
     * hid the Episodes button, because a null context reads exactly like a film.
     */
    onContext: (cb: (context: PlayerContext) => void) => {
      const now = deps.currentState()
      if (now !== null) cb(now)
      return deps.subscribeState((state) => {
        if (state === null) return
        cb(state)
      })
    },

    onSuggestion: (cb) => deps.subscribeSuggestion(cb),
    onSkipOffer: never<SkipOffer | null>,
    onPointerTop: never<boolean>,
  }
}
