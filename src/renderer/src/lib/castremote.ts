/**
 * The arithmetic behind the cast remote.
 *
 * Pure, and separate from the component, because most of what is in here is
 * the kind of off-by-one that renders as a working button doing the wrong
 * thing rather than as an error — a volume slider that reports 101%, or the
 * wrong television picked for the user.
 *
 * Where ⏮ and ⏭ go is not in here: it is the same rule as auto-next, in
 * `shared/episodesteps.ts`, so the button and the countdown cannot disagree
 * about what comes next.
 */

import type { CastDevice } from '@shared/ipc'

/**
 * Which of the remote's two faces is up.
 *
 * `choose` is the television and the source being picked, which is what the
 * cast button opens straight onto (the owner, 2026-09-27: one tap into the
 * remote, where the source list used to be a panel over the player). It is
 * also where "Change source" and a source the television refused lead.
 * `control` is the transport, once something is on the television.
 */
export type RemoteMode = 'choose' | 'control'

/** The television used last, as remembered between casts. */
export interface RememberedDevice {
  id: string
  name: string
}

/**
 * The television to have selected before the user picks one, or null.
 *
 * The one used last, when it is on the network, matched by id and then by
 * name: a Chromecast's name is what its owner set, and survives the id
 * changing under it. Otherwise the only one there is. With several and no
 * history, nothing: guessing between two rooms is how a film starts on the
 * wrong television.
 */
export function preferredDevice(
  devices: readonly CastDevice[],
  last: RememberedDevice | null,
): string | null {
  if (last !== null) {
    const byId = devices.find((d) => d.id === last.id)
    if (byId) return byId.id
    const byName = devices.find((d) => d.name === last.name)
    if (byName) return byName.id
  }
  return devices.length === 1 ? devices[0]!.id : null
}

/** A remembered television read back from storage, or null for anything malformed. */
export function parseRememberedDevice(raw: string | null): RememberedDevice | null {
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const { id, name } = value as Record<string, unknown>
    return typeof id === 'string' && typeof name === 'string' ? { id, name } : null
  } catch {
    return null
  }
}

/**
 * How far through, 0–1, for the time bar.
 *
 * Zero rather than a fraction when the duration is unknown: a receiver reports
 * `duration: 0` until it has parsed the stream, and dividing by it produces
 * either Infinity or NaN, both of which render as a bar that has silently
 * vanished.
 */
export function progressFraction(seconds: number, duration: number): number {
  if (!Number.isFinite(seconds) || !Number.isFinite(duration) || duration <= 0) return 0
  return Math.max(0, Math.min(1, seconds / duration))
}

/** A volume level as a whole percentage, clamped to the range a slider has. */
export function volumePercent(level: number): number {
  if (!Number.isFinite(level)) return 0
  return Math.round(Math.max(0, Math.min(1, level)) * 100)
}

/**
 * What the remote is doing, which is not always "playing".
 *
 * `connecting` is the choose face's only phase: the television is being
 * reached, after a source was picked and before anything is loaded for it.
 *
 * `switching` and `beaming` exist because moving the television to another
 * episode is not instant and not reliable: the embed has to load it, the
 * provider has to fetch a stream, and only then can it be sent. Showing the
 * ordinary remote throughout would be showing transport controls for a
 * position that is about to be discarded.
 *
 * `stuck` is the documented ordinary case rather than an error — several
 * providers fetch nothing at all until their own play button is pressed, so
 * the remote says exactly that and keeps waiting.
 */
export type RemotePhase = 'playing' | 'connecting' | 'switching' | 'beaming' | 'stuck'

/** How long to wait for a provider to hand over a stream before saying so. */
export const STREAM_WAIT_MS = 20_000

/** The step sizes on the two nudge buttons, in seconds. */
export const NUDGE_SECONDS = 30

/**
 * Where a seek should land, given a bar dragged to `fraction`.
 *
 * Rounded to whole seconds because a receiver's `SEEK` takes them and a
 * fractional one is a decimal place nobody sees; clamped inside the duration
 * so dragging to the very end does not ask for a position past it, which some
 * receivers answer by stopping.
 */
export function seekTarget(fraction: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0))
  return Math.round(Math.max(0, Math.min(duration - 1, clamped * duration)))
}

/** Where a nudge lands: `by` seconds from here, inside the stream. */
export function nudgeTarget(seconds: number, by: number, duration: number): number {
  const from = Number.isFinite(seconds) ? seconds : 0
  const target = from + by
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, Math.round(target))
  return Math.round(Math.max(0, Math.min(duration - 1, target)))
}
