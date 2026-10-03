/**
 * Something that should happen only with the app on screen.
 *
 * `run` acts at once when the page is visible, and otherwise the next time it
 * becomes visible. Only the latest act waits: each caller passes what should
 * happen as things stand, so an older one is out of date by then. `cancel`
 * drops it, for when what it was about has ended.
 */

export interface VisibleGate {
  run(act: () => void): void
  cancel(): void
}

type VisibilitySource = Pick<Document, 'visibilityState' | 'addEventListener'>

export function createVisibleGate(page: VisibilitySource = document): VisibleGate {
  let pending: (() => void) | null = null
  page.addEventListener('visibilitychange', () => {
    if (page.visibilityState !== 'visible' || pending === null) return
    const act = pending
    pending = null
    act()
  })
  return {
    run(act) {
      if (page.visibilityState === 'visible') {
        pending = null
        act()
      } else {
        pending = act
      }
    },
    cancel() {
      pending = null
    },
  }
}
