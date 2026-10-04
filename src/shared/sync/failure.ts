/**
 * What a failed sync tells the user, and whether it tries again by itself.
 *
 * Shared by both platforms' sync services, which showed every failure as a
 * red error. A busy Drive (a rate limit, a 429, a server error) is nothing the
 * user can act on and passes by itself, so it reads as a quiet note in the
 * status line, and another sync follows a minute later. A sign-in that Google
 * revoked is handled before this, by the services themselves.
 */

import { DriveBusy } from './drive'
import type { SyncStatus } from './types'

/** How long after a busy Drive the next sync runs by itself; the note in `drive.ts` says "in a minute". */
export const RETRY_AFTER_MS = 60_000

export function afterFailure(error: unknown): {
  status: Pick<SyncStatus, 'state' | 'error' | 'notice'>
  retry: boolean
} {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof DriveBusy) return { status: { state: 'idle', error: null, notice: message }, retry: true }
  return { status: { state: 'error', error: message, notice: null }, retry: false }
}
