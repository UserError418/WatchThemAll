/**
 * Changes to the test results, gathered over a moment and reported once.
 *
 * Open screens re-read a title's results when they change (`EV.resultsChanged`),
 * and a re-read is not free: every list showing the title asks for its whole
 * source state again, and the detail view may plan its preview again. The
 * results change in bursts — a sync can bring hundreds at once, a test run
 * files every source it measured, a play files its time and then its picture
 * — so each change reported on its own would be a re-render storm. Both the
 * desktop's main process and the phone's bridge pass changes through this,
 * as they pass the library's through `batchChanges`.
 */

/**
 * Long enough to gather a burst, and far shorter than anything waiting on
 * it: a re-read, then a stream preview that takes seconds to start.
 */
export const RESULTS_BATCH_MS = 250

/**
 * A listener that delivers the titles changed in a batch, once, `windowMs`
 * after the first change in it. A change that touched no title (a sync that
 * brought nothing new) starts no batch.
 */
export function batchResultChanges(
  deliver: (titleKeys: string[]) => void,
  windowMs = RESULTS_BATCH_MS,
): (titleKeys: readonly string[]) => void {
  let pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null

  return (titleKeys) => {
    for (const key of titleKeys) pending.add(key)
    if (timer !== null || pending.size === 0) return
    timer = setTimeout(() => {
      timer = null
      const batch = [...pending]
      pending = new Set()
      deliver(batch)
    }, windowMs)
  }
}
