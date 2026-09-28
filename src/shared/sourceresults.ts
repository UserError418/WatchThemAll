/**
 * Every source result, kept, per episode and per kind of device.
 *
 * ## Why a history (the owner, 2026-09-28)
 *
 * The tests used to keep one result per source per title: the last one. That
 * threw away two things. First, how a source behaves over time: one slow
 * evening replaced every fast one before it. Second, the episode: a
 * provider can serve episode 1 and not episode 2, which another provider
 * has, and a title-wide row could only say one thing for both.
 *
 * So every result is kept (bounded: `KEEP_PER_EPISODE`, `KEEP_MS`,
 * `MAX_RESULTS`), and the row the rest of the app reads is worked out when
 * it is read (`titleResults`). The row keeps its old shape (`ProviderScan`),
 * so ranking, the pickers' dots, Resume, the switch offer, castability and
 * the preview all read it exactly as before.
 *
 * ## Where results come from
 *
 * - `test`: "Test all sources" and the background tester, as before.
 * - `play`: the player, when a source really streams, and when it fails in a
 *   way that cannot be mistaken (an error page, a refused stream, the wrong
 *   film). A slow source is not a failure here.
 * - `preview`: the detail view's stream preview, when its stream arrives.
 *
 * ## How a row is decided, per source
 *
 * 1. **This kind of device first.** Results from this kind of device decide.
 *    The other kind's results only fill a gap: a source that streamed there
 *    and was never tried here reads amber, labelled with where it worked,
 *    and a failure there never turns a source red here (the owner's choice:
 *    some sources refuse the phone and play on the PC). Two PCs are one
 *    kind: what one measured decides for the other.
 * 2. **The episode, then its season, then the title.** The episode's own
 *    results decide. Without them the season's, and without those the whole
 *    title's, which is what a title-wide row always said.
 * 3. **Strong and weak.** A test and any success are strong; a failure seen
 *    only while playing is weak, because the player cannot run a test's
 *    controlled measurement. The newest strong result decides. One weak
 *    failure newer than it turns the source amber, and two in a row turn it
 *    red.
 * 4. **Speed and quality from several results.** The time to stream is the
 *    median of the latest successes, so one slow evening does not move a
 *    source down. The quality is the best of them, since a player's first
 *    picture is often a lower rung of the stream's ladder.
 *
 * ## Old results
 *
 * The title-wide rows stored before this (`providerScans`, and other
 * devices' in `sharedScans`) are read as results of the whole title
 * (`legacyResults`). Nothing is migrated or deleted: they age out.
 */

import { RESULT_TTL_MS, testedAtOf } from './scanrow'
import type { TitleResults } from './scanshare'
import type {
  CastOutcome,
  DeviceKind,
  ProbeVerdict,
  ProviderScan,
  ScanReason,
  SharedScan,
  StreamDelivery,
} from './types'

/**
 * How long a result is kept: as long as one is read (`RESULT_TTL_MS`, thirty
 * days since the owner set it on 2026-09-26). Anything older would be stored
 * and synced for nothing.
 */
export const KEEP_MS = RESULT_TTL_MS
/** The newest results kept per source, episode and kind of device. */
export const KEEP_PER_EPISODE = 10
/**
 * A bound on the whole history, newest kept. It syncs as one file, of about
 * 200 bytes a result: this caps it near 800 KB, above a month of the
 * background tester and everything watched in it.
 */
export const MAX_RESULTS = 4_000
/** How many of the latest successes the speed and quality are taken from. */
export const SAMPLE_SIZE = 5

export type ResultOrigin = 'test' | 'play' | 'preview'

/**
 * One measurement of one source for one title.
 *
 * It has no id of its own: the device, the moment and the source identify it
 * (`resultKey`), and the history syncs as one file, where a second copy of
 * that in every record would be a fifth of its size.
 */
export interface SourceResult {
  /** `tv:tt0903747` or `movie:tt0137523`, as `outcomes.titleKey`. */
  titleKey: string
  /** The episode measured. Both null for a film, and for a result from before episodes were kept. */
  season: number | null
  episode: number | null
  providerId: string
  at: number
  deviceId: string
  deviceKind: DeviceKind
  origin: ResultOrigin
  verdict: ProbeVerdict
  /** Milliseconds from the start of the load to the stream arriving. Successes only. */
  ms?: number
  /** A quality class (`streamquality.ts`). Successes only. */
  quality?: number
  /** Why a failure failed, where it could tell. */
  reason?: ScanReason
  delivery?: StreamDelivery
  /** What a television said when this source was cast. */
  cast?: CastOutcome
}

export interface ResultDevice {
  deviceId: string
  deviceKind: DeviceKind
}

/** What identifies a result across devices and syncs. */
export function resultKey(result: Pick<SourceResult, 'deviceId' | 'at' | 'providerId'>): string {
  return `${result.deviceId}\u0000${result.at}\u0000${result.providerId}`
}

const VERDICTS: readonly unknown[] = ['stream', 'unsure', 'dead'] satisfies ProbeVerdict[]
const ORIGINS: readonly unknown[] = ['test', 'play', 'preview'] satisfies ResultOrigin[]
const KINDS: readonly unknown[] = ['desktop', 'phone'] satisfies DeviceKind[]
const DELIVERIES: readonly unknown[] = ['progressive', 'segmented', 'other', 'unknown'] satisfies StreamDelivery[]
const CASTS: readonly unknown[] = ['played', 'refused'] satisfies CastOutcome[]

/**
 * Whether a record is one this app could have written.
 *
 * The synced file is in the user's own Drive, where anything can be edited,
 * and a malformed record taken in would be stored and pushed back out from
 * here; so anything else is dropped rather than merged.
 */
export function isSourceResult(value: unknown): value is SourceResult {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  const count = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
  const episodeNumber = (v: unknown): boolean => v === null || count(v)
  const optional = (v: unknown, ok: (v: unknown) => boolean): boolean => v === undefined || ok(v)
  return (
    typeof r.titleKey === 'string' &&
    episodeNumber(r.season) &&
    episodeNumber(r.episode) &&
    typeof r.providerId === 'string' &&
    count(r.at) &&
    typeof r.deviceId === 'string' &&
    KINDS.includes(r.deviceKind) &&
    ORIGINS.includes(r.origin) &&
    VERDICTS.includes(r.verdict) &&
    optional(r.ms, count) &&
    optional(r.quality, count) &&
    optional(r.reason, (v) => typeof v === 'object' && v !== null && typeof (v as { kind?: unknown }).kind === 'string') &&
    optional(r.delivery, (v) => DELIVERIES.includes(v)) &&
    optional(r.cast, (v) => CASTS.includes(v))
  )
}

/* ── Keeping ─────────────────────────────────────────────────────────────── */

/**
 * The history bounded: nothing older than `KEEP_MS`, the newest
 * `KEEP_PER_EPISODE` per source, episode and kind, the newest `MAX_RESULTS`
 * overall. Duplicates (the same id from two syncs) are kept once. Oldest
 * first, as it is stored.
 */
export function pruneResults(results: readonly SourceResult[], now: number): SourceResult[] {
  const byKey = new Map<string, SourceResult>()
  for (const result of results) {
    if (now - result.at > KEEP_MS) continue
    byKey.set(resultKey(result), result)
  }
  // Ties broken by key, so the stored order is the same whichever device pruned.
  const newestFirst = [...byKey.entries()]
    .sort(([keyA, a], [keyB, b]) => b.at - a.at || (keyA < keyB ? 1 : keyA > keyB ? -1 : 0))
    .map(([, result]) => result)
  const perGroup = new Map<string, number>()
  const kept: SourceResult[] = []
  for (const result of newestFirst) {
    const group = [result.providerId, result.titleKey, result.season, result.episode, result.deviceKind].join('\u0000')
    const count = perGroup.get(group) ?? 0
    if (count >= KEEP_PER_EPISODE) continue
    perGroup.set(group, count + 1)
    kept.push(result)
    if (kept.length >= MAX_RESULTS) break
  }
  return kept.reverse()
}

/** Both devices' histories as one: every result either had, bounded. */
export function mergeResults(local: readonly SourceResult[], remote: readonly SourceResult[], now: number): SourceResult[] {
  return pruneResults([...local, ...remote], now)
}

/**
 * A test's row (`ProviderScan`, as "Test all sources" and the background
 * tester produce it) as results: one per source it reached.
 */
export function resultsFromScan(
  scan: ProviderScan,
  device: ResultDevice,
  episode: { season: number; episode: number } | null,
): SourceResult[] {
  return Object.entries(scan.verdicts).map(([providerId, verdict]) => {
    const at = testedAtOf(scan, providerId) ?? scan.at
    const result: SourceResult = {
      titleKey: scan.titleKey,
      season: episode?.season ?? null,
      episode: episode?.episode ?? null,
      providerId,
      at,
      deviceId: device.deviceId,
      deviceKind: device.deviceKind,
      origin: 'test',
      verdict,
    }
    setOptional(result, 'ms', verdict === 'stream' ? scan.timings?.[providerId] : undefined)
    setOptional(result, 'quality', verdict === 'stream' ? scan.qualities?.[providerId] : undefined)
    setOptional(result, 'reason', verdict === 'stream' ? undefined : scan.reasons?.[providerId])
    setOptional(result, 'delivery', scan.delivery?.[providerId])
    setOptional(result, 'cast', scan.casts?.[providerId])
    return result
  })
}

/**
 * The title-wide rows stored before the history existed, read as results of
 * the whole title. This device's own rows are in `providerScans`; other
 * devices' in `sharedScans`, with where they came from.
 */
export function legacyResults(
  doc: { providerScans: readonly ProviderScan[]; sharedScans: readonly SharedScan[] },
  own: ResultDevice,
): SourceResult[] {
  const rows = [
    ...doc.providerScans.map((row) => ({ row, device: own })),
    ...doc.sharedScans.map((row) => ({ row, device: { deviceId: row.deviceId, deviceKind: row.deviceKind } })),
  ]
  return rows.flatMap(({ row, device }) => resultsFromScan(row, device, null))
}

/* ── Deciding ────────────────────────────────────────────────────────────── */

interface Decision {
  verdict: ProbeVerdict
  /** When the result that decided it was measured. */
  at: number
  reason?: ScanReason
}

/** A test, or a success of any kind: see rule 3 in the header. */
function isStrong(result: SourceResult): boolean {
  return result.origin === 'test' || result.verdict === 'stream'
}

/** Rule 3: the newest strong result, overruled by weak failures newer than it. */
function decide(results: readonly SourceResult[]): Decision | null {
  let strong: SourceResult | null = null
  for (const result of results) {
    if (isStrong(result) && (strong === null || result.at > strong.at)) strong = result
  }
  // Every success is strong, so the weak results newer than it are failures in a row.
  const newerWeak = results
    .filter((r) => !isStrong(r) && (strong === null || r.at > strong.at))
    .sort((a, b) => b.at - a.at)
  const latestWeak = newerWeak[0]
  if (latestWeak !== undefined) {
    const verdict = newerWeak.length >= 2 ? latestWeak.verdict : 'unsure'
    return withReason({ verdict, at: latestWeak.at }, latestWeak.reason)
  }
  if (strong === null) return null
  return withReason({ verdict: strong.verdict, at: strong.at }, strong.verdict === 'stream' ? undefined : strong.reason)
}

/**
 * Rule 2: the narrowest scope that has anything to say. A film, and every
 * result from before episodes were kept, only ever has the whole title.
 */
function inScope(
  results: readonly SourceResult[],
  episode: { season: number; episode: number } | null,
): readonly SourceResult[] {
  if (episode === null) return results
  const exact = results.filter((r) => r.season === episode.season && r.episode === episode.episode)
  if (exact.length > 0) return exact
  const season = results.filter((r) => r.season === episode.season)
  if (season.length > 0) return season
  return results
}

/** Rule 4: the median time to stream and the best quality of the latest successes. */
function measurements(results: readonly SourceResult[]): { ms?: number; quality?: number } {
  const latest = results
    .filter((r) => r.verdict === 'stream')
    .sort((a, b) => b.at - a.at)
    .slice(0, SAMPLE_SIZE)
  const times = latest.flatMap((r) => (r.ms === undefined ? [] : [r.ms]))
  const qualities = latest.flatMap((r) => (r.quality === undefined ? [] : [r.quality]))
  const out: { ms?: number; quality?: number } = {}
  if (times.length > 0) out.ms = median(times)
  if (qualities.length > 0) out.quality = Math.max(...qualities)
  return out
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

/**
 * How the source hands out its video, and what a television said when it was
 * cast: from the newest success that saw it. A cast carries both, and a test
 * after it carries only the delivery, so a newer test replaces the
 * television's answer as it always did (a source that changed its form has
 * to be cast again to be known).
 */
function castDetails(results: readonly SourceResult[]): Pick<SourceResult, 'delivery' | 'cast'> {
  const newest = results
    .filter((r) => r.verdict === 'stream' && r.delivery !== undefined)
    .sort((a, b) => b.at - a.at)[0]
  return { delivery: newest?.delivery, cast: newest?.cast }
}

/**
 * One title's row as this device reads it, for one episode (or the film, or
 * the whole title when `episode` is null): the history decided by the rules
 * in the header.
 *
 * `results` is everything known, this device's and the others', new and
 * legacy alike. `playedAt` is when each source last streamed this title here
 * by the play log: a play from before plays were kept as results still
 * overtakes an older failure, as it did.
 */
export function titleResults(input: {
  results: readonly SourceResult[]
  titleKey: string
  episode: { season: number; episode: number } | null
  here: DeviceKind
  now: number
  playedAt?: Readonly<Record<string, number>>
}): TitleResults {
  const { titleKey, episode, here, now } = input
  const playedAt = input.playedAt ?? {}
  const byProvider = new Map<string, SourceResult[]>()
  for (const result of input.results) {
    if (result.titleKey !== titleKey || now - result.at > RESULT_TTL_MS) continue
    byProvider.set(result.providerId, [...(byProvider.get(result.providerId) ?? []), result])
  }

  const row: Required<ProviderScan> = {
    titleKey,
    at: 0,
    verdicts: {},
    testedAt: {},
    reasons: {},
    timings: {},
    qualities: {},
    delivery: {},
    casts: {},
  }
  const sharedFrom: Record<string, DeviceKind> = {}
  const playedHereAfter = (providerId: string, at: number): boolean => (playedAt[providerId] ?? -Infinity) > at

  for (const [providerId, results] of byProvider) {
    const ownScope = inScope(
      results.filter((r) => r.deviceKind === here),
      episode,
    )
    const own = decide(ownScope)
    if (own !== null && !(own.verdict !== 'stream' && playedHereAfter(providerId, own.at))) {
      row.verdicts[providerId] = own.verdict
      row.testedAt[providerId] = own.at
      if (own.reason) row.reasons[providerId] = own.reason
      if (own.verdict === 'stream') {
        const { ms, quality } = measurements(ownScope)
        if (ms !== undefined) row.timings[providerId] = ms
        if (quality !== undefined) row.qualities[providerId] = quality
        fillCastDetails(row, providerId, ownScope)
      }
      continue
    }

    // Rule 1: nothing here, so the other kind's good news fills the gap, as
    // amber. Decided by the same rules there, so a source it has since found
    // dead stops being reported as working here.
    const otherScope = inScope(
      results.filter((r) => r.deviceKind !== here),
      episode,
    )
    const other = decide(otherScope)
    if (other?.verdict !== 'stream' || playedHereAfter(providerId, other.at)) continue
    row.verdicts[providerId] = 'unsure'
    row.testedAt[providerId] = other.at
    sharedFrom[providerId] = otherScope[0]!.deviceKind
    fillCastDetails(row, providerId, otherScope)
  }

  if (Object.keys(row.verdicts).length === 0) return { scan: null, sharedFrom }
  row.at = Math.max(...Object.values(row.testedAt))
  return { scan: row, sharedFrom }
}

function fillCastDetails(row: Required<ProviderScan>, providerId: string, results: readonly SourceResult[]): void {
  const { delivery, cast } = castDetails(results)
  if (delivery !== undefined) row.delivery[providerId] = delivery
  if (cast !== undefined) row.casts[providerId] = cast
}

/**
 * Title-wide rows, one per device and title, each as that device reads its
 * own results: for what reads across titles. The background tester's
 * schedule reads this device's; a source's castability record elsewhere
 * reads everyone's.
 */
export function deviceRows(results: readonly SourceResult[], now: number): SharedScan[] {
  const groups = new Map<string, SourceResult[]>()
  for (const result of results) {
    const key = `${result.deviceId}\u0000${result.titleKey}`
    groups.set(key, [...(groups.get(key) ?? []), result])
  }
  return [...groups.values()].flatMap((group) => {
    const { deviceId, deviceKind, titleKey } = group[0]!
    const { scan } = titleResults({ results: group, titleKey, episode: null, here: deviceKind, now })
    return scan === null ? [] : [{ ...scan, deviceId, deviceKind }]
  })
}

function withReason(decision: Decision, reason: ScanReason | undefined): Decision {
  return reason === undefined ? decision : { ...decision, reason }
}

function setOptional<K extends keyof SourceResult>(target: SourceResult, key: K, value: SourceResult[K] | undefined): void {
  if (value !== undefined) target[key] = value
}
