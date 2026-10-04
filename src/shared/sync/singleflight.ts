/**
 * One run of a task at a time, shared by every caller that asks while it is out.
 *
 * For the access-token refresh on both platforms. A sync starts the library,
 * the positions and the test history together, and with an expired token
 * (most launches) each used to refresh it on its own: three requests to
 * Google, and three writes of the stored credentials racing for one file.
 *
 * Unlike `CoalescingRunner` in `engine.ts`, a caller arriving mid-run is given
 * that run's answer rather than another run afterwards: a token fetched a
 * moment ago is exactly what it wants.
 */
export function singleFlight<T>(task: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null
  return () => {
    running ??= task().finally(() => {
      running = null
    })
    return running
  }
}
