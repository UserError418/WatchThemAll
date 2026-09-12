/**
 * The event half of `WtaApi`.
 *
 * On desktop these arrive over IPC from a separate process. In the WebView
 * there is no process boundary, so the "events" are just calls the bridge makes
 * to itself — but the renderer must not be able to tell the difference, and in
 * particular every subscription still has to hand back its own unsubscribe.
 * The original app registered `ipcRenderer.on` listeners it never removed, and
 * a component that resubscribes on every open leaks a listener per open
 * regardless of which side of the boundary it is on.
 */

type Listener<T> = (payload: T) => void

/** A single typed event with add/remove/emit. */
export class Signal<T> {
  private listeners = new Set<Listener<T>>()

  /** Subscribe, and get back the function that undoes it. */
  subscribe(cb: Listener<T>): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  emit(payload: T): void {
    // Copied before iterating: a listener that unsubscribes itself while the
    // set is being walked would otherwise skip whichever listener follows it.
    for (const cb of [...this.listeners]) {
      try {
        cb(payload)
      } catch (err) {
        // One bad subscriber must not stop the others from being told.
        console.error('[bridge] listener threw:', err)
      }
    }
  }

  get size(): number {
    return this.listeners.size
  }
}
