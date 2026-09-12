/**
 * Deciding when the app window needs to hear about the pointer.
 *
 * The chrome bar hides itself while you watch and has to come back when you
 * reach for it, and *neither renderer can see the pointer do that*. The app
 * window cannot, because the player view is a native layer over it that
 * swallows every mouse event inside its rectangle; the view's own preload
 * cannot either, because the video usually plays in a nested cross-origin
 * iframe whose mouse events never reach the parent document. So the main
 * process watches the view's raw input stream and forwards a verdict.
 *
 * Extracted from `playerview.ts` because it is the part that decides, and the
 * part that decides is the part that has been wrong twice. It is plain
 * TypeScript with no Electron in it, so `pointerzone.test.ts` can drive the
 * exact sequences that broke — which the real path cannot be made to do from a
 * test, since CDP-injected mouse events do not reach Electron's `input-event`.
 */

export interface PointerZoneOptions {
  /** How far down the window still counts as "reaching for the bar". */
  topZonePx: number
  /**
   * How often to repeat an unchanged "still up here".
   *
   * Repeats are needed because the bar hides on a timer even while the pointer
   * is near the top — otherwise a pointer nudged up and then left alone pinned
   * it open for the rest of the film. Once it has hidden, only a fresh report
   * brings it back, and a pointer moving *within* the zone produces no
   * transition to report.
   *
   * Scoped to the zone rather than to all movement, so the traffic is bounded
   * by something rare and brief. Movement across the picture, which is most
   * movement, still crosses the bridge only when it changes the answer.
   */
  repeatMs: number
}

/** What to send, or `null` for "say nothing". */
export type PointerZoneReport = boolean | null

export interface PointerZoneWatcher {
  /** A mouse move inside the view, in the window's content coordinates. */
  move(x: number, y: number, now: number): PointerZoneReport
  /** The pointer left the view's rectangle. */
  leave(now: number): PointerZoneReport
}

export function createPointerZoneWatcher(options: PointerZoneOptions): PointerZoneWatcher {
  const { topZonePx, repeatMs } = options

  let lastSent: boolean | null = null
  let lastSentAt = Number.NEGATIVE_INFINITY
  let lastX = Number.NaN
  let lastY = Number.POSITIVE_INFINITY

  const decide = (nearTop: boolean, now: number): PointerZoneReport => {
    const changed = nearTop !== lastSent
    // A transition always goes. An unchanged `true` goes at most every
    // `repeatMs`; an unchanged `false` never does, because nothing downstream
    // acts on it.
    if (!changed && !(nearTop && now - lastSentAt >= repeatMs)) return null

    lastSent = nearTop
    lastSentAt = now
    return nearTop
  }

  return {
    move(x, y, now) {
      // A move to the position it already held is not a move. Chromium
      // re-hit-tests after a layout change, and the bar hiding *is* a layout
      // change — so without this the bar could resize the view, be told the
      // pointer is still near the top, and reopen itself in a loop.
      const still = x === lastX && y === lastY
      lastX = x
      lastY = y
      return still ? null : decide(y <= topZonePx, now)
    },

    /**
     * Leaving upward is not leaving.
     *
     * Upward means the pointer has crossed onto the app's own chrome, which is
     * ordinary DOM and reports for itself — saying "not near the top" here
     * would fight it and shut the bar as the user reached for it. Any other
     * direction means the pointer has gone for good.
     */
    leave(now) {
      return lastY > topZonePx ? decide(false, now) : null
    },
  }
}
