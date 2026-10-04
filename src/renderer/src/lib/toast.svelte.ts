/**
 * The one toast at the foot of the window, and the action it may offer.
 *
 * One at a time, with one timer: a newer toast replaces the one showing and
 * gets its full time. App draws it; anything may raise it.
 *
 * The action is what makes a one-click destructive change safe without asking
 * first: removing a title, clearing a season, marking one watched all say what
 * they did and offer to undo it, instead of a confirmation in front of every
 * click.
 */

export interface ToastAction {
  label: string
  run: () => void
}

export interface Toast {
  /** Distinguishes one toast from the next, so an old timer cannot take a new toast down. */
  id: number
  message: string
  action: ToastAction | null
}

/** Long enough to read a sentence. */
export const TOAST_MS = 6000
/** Longer when there is something to press: reading it and reaching for it take a moment. */
export const ACTION_TOAST_MS = 9000

class Toasts {
  /** Raw: only ever replaced whole, and holds a function. */
  current = $state.raw<Toast | null>(null)
  private timer: ReturnType<typeof setTimeout> | null = null
  private count = 0

  /** `ms` for a toast that needs longer than the usual, e.g. one carrying a path to note down. */
  show(message: string, action: ToastAction | null = null, ms = action ? ACTION_TOAST_MS : TOAST_MS): void {
    this.clearTimer()
    const id = ++this.count
    this.current = { id, message, action }
    this.timer = setTimeout(() => {
      if (this.current?.id === id) this.current = null
    }, ms)
  }

  /** Run the action of the toast showing, once, and take the toast down. */
  act(): void {
    const action = this.current?.action
    this.dismiss()
    action?.run()
  }

  dismiss(): void {
    this.clearTimer()
    this.current = null
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

export const toast = new Toasts()
