/**
 * Store changes, gathered over a moment and reported once.
 *
 * The store reports every mutation as it happens, one call per key. Handed to
 * the renderer that way, one patch naming two collections was two full
 * library reloads, and a release sweep was one per tracked series. Both the
 * desktop's main process and the phone's bridge pass changes through this, so
 * the renderer hears one batch naming everything that changed in it.
 */

import type { ChangedKey } from './core'
import type { StoreDocument } from './document'

/** Long enough to gather one patch or one burst, too short for a person to see. */
export const CHANGE_BATCH_MS = 100

/**
 * A store listener that delivers a batch of changed keys `windowMs` after the
 * first change in it: null when anything in the batch touched the whole
 * document, which means "everything".
 */
export function batchChanges(
  deliver: (keys: Array<keyof StoreDocument> | null) => void,
  windowMs = CHANGE_BATCH_MS,
): (key: ChangedKey) => void {
  let keys: Set<keyof StoreDocument> | null = new Set()
  let timer: ReturnType<typeof setTimeout> | null = null

  return (key) => {
    if (key === null) keys = null
    else keys?.add(key)
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      const batch = keys === null ? null : [...keys]
      keys = new Set()
      deliver(batch)
    }, windowMs)
  }
}
