/**
 * Whether a watchlist entry is on the user's watchlist, or only kept for what
 * it records. See `WatchlistEntry.listed`.
 *
 * One function rather than `entry.listed !== false` at every call site: the
 * field is optional, so the natural-looking `entry.listed` reads every entry
 * written before it existed as unlisted, and would empty the watchlist.
 */

import type { WatchlistEntry } from './types'

export function isListed(entry: Pick<WatchlistEntry, 'listed'>): boolean {
  return entry.listed !== false
}
