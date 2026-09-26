/**
 * Test results across the user's own devices.
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

import { MAX_SCANS, RESULT_TTL_MS, testedAtOf } from './scanrow'
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

/**
 * Fold the other devices' good news for one title into this device's own row.
 *
 * `own` is this device's fresh row for the title — `freshScan`'s answer, so it
 * is already past its lifetime and real-play checks. `playedAt` is when each
 * provider last streamed the title *here*: a play is stronger evidence than a
 * result read as amber, as it is for this device's own ambers.
 */
export function withSharedResults(
  own: ProviderScan | null,
  shared: readonly SharedScan[],
  titleKey: string,
  here: DeviceKind,
  now: number,
  playedAt: Readonly<Record<string, number>> = {},
): TitleResults {
  const out: ProviderScan = own
    ? {
        ...own,
        verdicts: { ...own.verdicts },
        testedAt: Object.fromEntries(Object.keys(own.verdicts).map((id) => [id, testedAtOf(own, id)!])),
        timings: { ...own.timings },
        qualities: { ...own.qualities },
        reasons: { ...own.reasons },
        delivery: { ...own.delivery },
        casts: { ...own.casts },
      }
    : { titleKey, at: 0, verdicts: {}, testedAt: {}, timings: {}, qualities: {}, reasons: {}, delivery: {}, casts: {} }
  const sharedFrom: Record<string, DeviceKind> = {}

  for (const row of shared) {
    if (row.titleKey !== titleKey) continue
    // What the other kind of device's green is worth here.
    const readAs = row.deviceKind === 'phone' && here === 'desktop' ? 'unsure' : 'stream'

    for (const [id, verdict] of Object.entries(row.verdicts)) {
      if (verdict !== 'stream') continue
      const testedAt = testedAtOf(row, id)!
      if (now - testedAt > RESULT_TTL_MS) continue
      // Newer here, whether measured here or taken from another device already.
      if (id in out.verdicts && out.testedAt![id]! >= testedAt) continue
      if (readAs === 'unsure' && (playedAt[id] ?? -Infinity) > testedAt) continue

      out.verdicts[id] = readAs
      out.testedAt![id] = testedAt
      // A timing and a quality describe a stream; beside an amber they would
      // describe a moment this device has no reason to believe happened.
      setDetail(out.timings!, id, readAs === 'stream' ? row.timings?.[id] : undefined)
      setDetail(out.qualities!, id, readAs === 'stream' ? row.qualities?.[id] : undefined)
      setDetail(out.reasons!, id, undefined)
      setDetail(out.delivery!, id, row.delivery?.[id])
      setDetail(out.casts!, id, row.casts?.[id])
      sharedFrom[id] = row.deviceKind
    }
  }

  if (Object.keys(out.verdicts).length === 0) return { scan: null, sharedFrom }
  out.at = Math.max(...Object.values(out.testedAt!))
  return { scan: out, sharedFrom }
}

function setDetail<T>(map: Record<string, T>, id: string, value: T | undefined): void {
  if (value === undefined) delete map[id]
  else map[id] = value
}
