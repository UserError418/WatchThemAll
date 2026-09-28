/**
 * Test results across the user's own devices, as builds before 2.0.3 shared
 * them: one row per device and title, inside the library file.
 *
 * ## Since 2.0.3
 *
 * Results are a history now (`sourceresults.ts`) that travels in a file of
 * its own, and nothing writes these rows any more. This merge stays for as
 * long as a device on an older build is still syncing: it keeps filing that
 * device's rows in `sharedScans`, where `legacyResults` reads them as results
 * of the whole title. The rules below are how those builds read each other,
 * and the rules the history keeps are `sourceresults.ts`'s: this kind of
 * device first, the other kind's good news filling gaps as amber.
 *
 * ## What crosses, agreed with the owner 2026-09-26
 *
 * Only good news. A result says what one device's network and engine could
 * reach at one moment, and the two kinds of mistake cost different amounts: a
 * false green costs one tap, while a false red hides a working source, because
 * nobody picks a red one. Reds are also the results most tied to where they
 * were measured — a phone on a hotel wifi, or the Android WebView that some
 * providers refuse while the desktop plays them. So:
 *
 * - **This device's own newer result always wins.** Another device's result
 *   only fills a gap, or replaces something older.
 * - **Greens cross; reds and ambers do not.** A source another device found
 *   dead is tested here in its own time rather than believed.
 * - **Castability crosses** with the green it belongs to. How a source hands
 *   out its video is a fact about the source's servers much more than about
 *   the device that looked.
 * - **The desktop's green is green on the phone, the phone's is amber on the
 *   desktop.** The desktop calls a source working only when video arrives; the
 *   phone accepts a playlist alone, which the desktop stopped trusting after
 *   Videasy served clean playlists whose every segment was refused.
 *
 * ## How it travels
 *
 * The synced file is the whole document, so every device already uploads its
 * own `providerScans`; the merge used to discard them. Now it files them — and
 * whatever that device had from others — in `sharedScans`, one row per
 * device and title, each replaced whole by that device's newer row. Replaced
 * whole, and filtered only when read: that is how a source a device has since
 * found dead stops being reported as working here.
 */

import { MAX_SCANS, RESULT_TTL_MS } from './scanrow'
import type { DeviceKind, ProviderScan, SharedScan, StoreShape } from './types'

/** The parts of a document the merge reads. */
type ShareSide = Pick<StoreShape, 'deviceId' | 'deviceKind' | 'providerScans' | 'sharedScans'>

/**
 * This device's `sharedScans` after a sync with `remote`.
 *
 * `remote.providerScans` are the uploader's own results; `remote.sharedScans`
 * what it had from other devices, which is how a phone learns what a second
 * desktop measured without the two ever syncing directly. Anything that
 * originated here is dropped — this device's own results are `providerScans`.
 *
 * A remote document with no `deviceKind` was written by a build from before
 * results were shared, and its own rows are skipped: without knowing which
 * kind of device measured them there is no rule to read them by.
 */
export function mergeSharedScans(local: ShareSide, remote: ShareSide, now: number = Date.now()): SharedScan[] {
  const incoming: SharedScan[] = [
    ...local.sharedScans,
    ...(remote.deviceKind && remote.deviceId !== local.deviceId
      ? remote.providerScans.map((row) => ({ ...row, deviceId: remote.deviceId, deviceKind: remote.deviceKind! }))
      : []),
    ...remote.sharedScans,
  ]

  /** Per device and title, that device's newest row. */
  const newest = new Map<string, SharedScan>()
  for (const row of incoming) {
    if (row.deviceId === local.deviceId) continue
    // Every provider in a row older than this has expired, so the row has.
    if (now - row.at > RESULT_TTL_MS) continue
    const key = `${row.deviceId}\u0000${row.titleKey}`
    const held = newest.get(key)
    if (!held || row.at > held.at) newest.set(key, row)
  }

  // The same bound per device as a device keeps for itself, newest titles kept.
  const byDevice = new Map<string, SharedScan[]>()
  for (const row of newest.values()) byDevice.set(row.deviceId, [...(byDevice.get(row.deviceId) ?? []), row])
  return [...byDevice.values()].flatMap((rows) => rows.sort((a, b) => a.at - b.at).slice(-MAX_SCANS))
}

/** One title's results as this device reads them, and which came from elsewhere. */
export interface TitleResults {
  /** Own results, with other devices' good news filled in. Null when there is nothing. */
  scan: ProviderScan | null
  /** The providers whose result came from another device, and what kind of device. */
  sharedFrom: Record<string, DeviceKind>
}
