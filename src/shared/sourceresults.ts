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
 * - `play`: the player, when a source really streams (with its time, the
 *   top of its player's own list of qualities where that can be reached, and
 *   on the desktop its picture), and when the source's own servers declare a
 *   failure: an error status for its page or its backend, or its video
 *   refused. A slow source, a dropped network or a crash is not a result.
 *   The phone files successes only. See `PlayMeasurement`. A cast is filed
 *   as a play too, once the television has answered (`castResults`); only
 *   one that played counts as the source streaming (`isPlaybackEvidence`).
 * - `preview`: the detail view's stream preview, once its film plays.
 *
 * Never for a download: it is not a source (`DOWNLOADED_SOURCE_ID`), and a
 * result filed under it would teach the resume rule that the title streams
 * on a source that does not exist. `isSourceResult` turns such a record
 * away, and the store does not keep one (`store/results.ts`).
 *
 * Each device keeps its history in a file of its own, and it syncs as a
 * file of its own (`store/results.ts`, `sync/results.ts`).
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
 * 4. **Speed from several results.** The time to stream is the median of
 *    the latest successes (`SAMPLE_SIZE`), so one slow evening does not move
 *    a source down.
 * 5. **Quality from the results that carry one, by its own scope.** See
 *    `qualityOf`: the newest offer for this episode (else its season), and
 *    failing any offer the best floor among the latest readings. Most
 *    successes carry no quality (a preview, a play on the phone, a cast), and
 *    when the quality was taken from the latest successes of the verdict's
 *    scope, those evicted the test that read it: the quality vanished, or
 *    fell to a play's first picture, on exactly the sources being watched.
 *
 * 6. **What a television said is its own fact.** A cast's answer is read
 *    apart from the rules above, across the whole title and both kinds of
 *    device, newest first, and a test never replaces it (2.0.18; see
 *    `titleResults`).
 *
 * ## Old results
 *
 * The title-wide rows stored before this (`providerScans`, and other
 * devices' in `sharedScans`) are read as results of the whole title
 * (`legacyResults`). Nothing is migrated or deleted: they age out.
 */

import { isAudioList } from './audiotracks'
import { isCastCheck } from './castability'
import { isDownloadedSource } from './downloads/types'
import { RESULT_TTL_MS, testedAtOf } from './scanrow'
import { isStreamSignature, type StreamSignature } from './streamsignature'
import type { TitleResults } from './scanshare'
import type {
  CastCheck,
  CastOutcome,
  DeviceKind,
  ProbeVerdict,
  ProviderScan,
  QualityKind,
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
/**
 * How many of the latest successes the speed is taken from, and how many of
 * the latest quality readings a floor is the best of.
 */
export const SAMPLE_SIZE = 5

/**
 * How far ahead of this device's clock another device may have stamped a
 * result for it to be taken now. Clocks a minute or two apart are ordinary.
 */
export const CLOCK_SKEW_ALLOWED_MS = 10 * 60_000

/**
 * Results, less any stamped further ahead of `now` than clocks ordinarily
 * drift: another device's, with its clock wrong.
 *
 * Such a result was never old enough to drop, always the newest to read, and
 * took one of `KEEP_PER_EPISODE` slots from results measured since. It is held
 * back rather than re-dated: `at` is part of a result's identity
 * (`resultKey`), and the other device still holds the original, so a re-dated
 * copy would come back as a second result on every sync. Held back, it is
 * taken once this clock reaches it.
 */
export function withoutFutureResults(results: readonly SourceResult[], now: number): SourceResult[] {
  return results.filter((result) => result.at <= now + CLOCK_SKEW_ALLOWED_MS)
}

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
  /**
   * What `quality` is worth: the best on offer, or a floor under it
   * (`QualityKind`).
   *
   * Absent from results filed before it was kept (2026-10), and those are
   * read as floors: until then a reading of one rendition — a stream's
   * header, a play's first picture — was filed as the best, and nothing tells
   * which of them were. They age out with `KEEP_MS`. A kind this build does
   * not know, from a newer one, is read as a floor too: a label may
   * understate, but must not claim an offer it cannot vouch for.
   */
  qualityKind?: QualityKind
  /**
   * The languages its sound is offered in (`audiotracks.ts`), where the
   * stream's master or its engine listed them. Successes only. Absent from
   * results filed before it was kept (2026-10), and from any that could not
   * tell: unknown, never "one language".
   */
  audio?: string[]
  /** Why a failure failed, where it could tell. */
  reason?: ScanReason
  delivery?: StreamDelivery
  /** What a television said when this source was cast. */
  cast?: CastOutcome
  /**
   * The model of the television that gave `cast` (`CastDevice.model`), and
   * what the stream it was handed held: a refusal applies to every source
   * whose stream is of the same class on the same model (`castability.ts`).
   * Absent where unknown, and on answers from before 2.0.19, which are read
   * as applying to every television, as they always were.
   */
  castReceiver?: string
  castSignature?: StreamSignature
  /**
   * The cast check a test made of a source that streamed, after its verdict
   * (2.0.19, `main/castcheck.ts`): whether the stream could be fetched as a
   * cast fetches it, whether it is the title, and what it holds. Filed on the
   * test's own result, under its time. Never a verdict on the source.
   */
  castCheck?: CastCheck
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
const DELIVERIES: readonly unknown[] = ['progressive', 'segmented', 'dash', 'other', 'unknown'] satisfies StreamDelivery[]
const CASTS: readonly unknown[] = ['played', 'refused', 'blocked'] satisfies CastOutcome[]

/**
 * Whether a record is one this app could have written.
 *
 * The synced file is in the user's own Drive, where anything can be edited,
 * and a malformed record taken in would be stored and pushed back out from
 * here; so anything else is dropped rather than merged.
 *
 * A result for a download is one this app must never write. The phone filed
 * one until 2.0.18 (a cast of a download); turning it away here drops it on
 * the next load and the next sync, on every device.
 *
 * A build that does not know a value (`blocked`, `dash`, from 2.0.18) drops
 * the whole record, and the next sync from a build that does puts it back.
 * A new optional field is kept by every build, which is the cheaper way to
 * add something.
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
    !isDownloadedSource(r.providerId) &&
    count(r.at) &&
    typeof r.deviceId === 'string' &&
    KINDS.includes(r.deviceKind) &&
    ORIGINS.includes(r.origin) &&
    VERDICTS.includes(r.verdict) &&
    optional(r.ms, count) &&
    optional(r.quality, count) &&
    // Any word, not only the kinds this build knows: a newer build's kind
    // must not get its whole result dropped here. Read as a floor (`isOffer`).
    optional(r.qualityKind, (v) => typeof v === 'string') &&
    optional(r.audio, isAudioList) &&
    optional(r.reason, (v) => typeof v === 'object' && v !== null && typeof (v as { kind?: unknown }).kind === 'string') &&
    optional(r.delivery, (v) => DELIVERIES.includes(v)) &&
    optional(r.cast, (v) => CASTS.includes(v)) &&
    optional(r.castReceiver, (v) => typeof v === 'string') &&
    optional(r.castSignature, isStreamSignature) &&
    optional(r.castCheck, isCastCheck)
  )
}

/* ── Keeping ─────────────────────────────────────────────────────────────── */

/**
 * The history bounded: nothing older than `KEEP_MS`, the newest
 * `KEEP_PER_EPISODE` per source, episode and kind, the newest `MAX_RESULTS`
 * overall. Duplicates (the same id from two syncs) are kept once, as the copy
 * that knows more (`knowsMore`). Oldest first, as it is stored.
 */
export function pruneResults(results: readonly SourceResult[], now: number): SourceResult[] {
  const byKey = new Map<string, SourceResult>()
  for (const result of results) {
    if (now - result.at > KEEP_MS) continue
    const key = resultKey(result)
    const held = byKey.get(key)
    byKey.set(key, held === undefined ? result : knowsMore(held, result))
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

/**
 * Of two copies of one result, the one that knows more.
 *
 * A result is filed again under its own key only to add what was learned
 * later: the desktop re-files a play with the best picture of its first
 * minute, and both platforms with the top of the player's own list once it
 * answers. Which copy survived used to be whichever came second, and in a
 * sync that is the other device's file, so a play uploaded before its
 * quality was known came back over the re-filed copy and stayed. Decided by
 * content, both devices keep the same copy in either order: the higher
 * quality, then an offer over a floor, then the one with a time, and for two
 * that still differ any fixed rule (the larger text) so that they agree.
 *
 * A play is only ever re-filed with a quality at least as high, and at the
 * same quality only from a floor to an offer, so a build from before kinds
 * were kept, which compares the text there, keeps the same copy: "offered"
 * sorts above "floor".
 *
 * A test is re-filed once its verdict is in, with the offer and the audio
 * found in what its page fetched (`findLadder`); the copy that knows the
 * audio is the one kept. A build from before audio was kept compares the
 * text there and may keep the other copy; nothing reads audio there.
 */
function knowsMore(a: SourceResult, b: SourceResult): SourceResult {
  const quality = (result: SourceResult): number => result.quality ?? -1
  if (quality(a) !== quality(b)) return quality(a) > quality(b) ? a : b
  if (isOffer(a) !== isOffer(b)) return isOffer(a) ? a : b
  if ((a.ms === undefined) !== (b.ms === undefined)) return a.ms === undefined ? b : a
  if ((a.audio === undefined) !== (b.audio === undefined)) return a.audio === undefined ? b : a
  // A test's result with its cast check over the same result without: the
  // check is filed with the result, so a copy without it is one from before.
  if ((a.castCheck === undefined) !== (b.castCheck === undefined)) return a.castCheck === undefined ? b : a
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b
}

/** Whether a result's quality is the best on offer rather than a floor under it. See `SourceResult.qualityKind`. */
function isOffer(result: SourceResult): boolean {
  return result.quality !== undefined && result.qualityKind === 'offered'
}

/** Both devices' histories as one: every result either had, bounded. */
export function mergeResults(local: readonly SourceResult[], remote: readonly SourceResult[], now: number): SourceResult[] {
  return pruneResults([...local, ...remote], now)
}

/**
 * The episode a request is about, for reading and writing results: null for
 * a film, and for a series request that names no episode (the whole title).
 */
export function episodeOf(ref: {
  type: 'tv' | 'movie'
  season?: number | null
  episode?: number | null
}): { season: number; episode: number } | null {
  if (ref.type !== 'tv' || typeof ref.season !== 'number' || typeof ref.episode !== 'number') return null
  return { season: ref.season, episode: ref.episode }
}

/** Where a measurement was made: which title, episode and source, on which device. */
export interface MeasuredAt {
  device: ResultDevice
  titleKey: string
  /** Null for a film. */
  episode: { season: number; episode: number } | null
  providerId: string
}

/** What was measured: everything a result says besides where. */
export type Measured = Omit<SourceResult, 'titleKey' | 'season' | 'episode' | 'providerId' | 'deviceId' | 'deviceKind'>

/** One result, from where it was measured and what was found. */
export function measurement(where: MeasuredAt, what: Measured): SourceResult {
  return {
    titleKey: where.titleKey,
    season: where.episode?.season ?? null,
    episode: where.episode?.episode ?? null,
    providerId: where.providerId,
    deviceId: where.device.deviceId,
    deviceKind: where.device.deviceKind,
    ...what,
  }
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
    setOptional(result, 'qualityKind', result.quality !== undefined ? scan.qualityKinds?.[providerId] : undefined)
    setOptional(result, 'audio', verdict === 'stream' ? nonEmpty(scan.audio?.[providerId]) : undefined)
    setOptional(result, 'reason', verdict === 'stream' ? undefined : scan.reasons?.[providerId])
    setOptional(result, 'delivery', scan.delivery?.[providerId])
    setOptional(result, 'cast', scan.casts?.[providerId])
    setOptional(result, 'castCheck', verdict === 'stream' ? scan.castChecks?.[providerId] : undefined)
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

/**
 * Whether a result says anything about the source streaming here, which is
 * what the verdict, the speed and the resume rule are decided from.
 *
 * A cast says so only when it played. One the television refused, or the
 * source blocked, is filed with the verdict casts always had (`stream`: the
 * beam fetched the source's stream to find it), so that older builds read
 * it as they did; but it is evidence about casting, read by rule 5, and a
 * cast that did not play must not make a source green.
 *
 * A play that carries a delivery and no answer is a beam from before
 * 2.0.18, filed whether or not the television ever played it: every phone
 * cast, and every desktop cast that failed or never settled. Nothing else
 * files a play with a delivery. It is not evidence of anything, and is read
 * as nothing until it ages out.
 */
export function isPlaybackEvidence(result: SourceResult): boolean {
  if (result.origin !== 'play' || result.delivery === undefined) return true
  return result.cast === 'played'
}

/** Whether a result is a television's answer, for rule 5; a beam from before 2.0.18 with no answer is not. */
function isCastAnswer(result: SourceResult): result is SourceResult & { cast: CastOutcome } {
  return result.cast !== undefined
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

/** Rule 4: the median time to stream of the latest successes. */
function startTime(results: readonly SourceResult[]): number | undefined {
  const times = results
    .filter((r) => r.verdict === 'stream')
    .sort((a, b) => b.at - a.at)
    .slice(0, SAMPLE_SIZE)
    .flatMap((r) => (r.ms === undefined ? [] : [r.ms]))
  return times.length > 0 ? median(times) : undefined
}

/**
 * Rule 5: the quality to show for one source, from this kind of device's
 * results for it, and what it is worth.
 *
 * Only results that carry a quality are read, so the many that do not
 * cannot crowd out the few that do. Its scope is its own, not the verdict's:
 * this episode's readings, else its season's. A play of the episode makes
 * its results the verdict's scope, and plays usually carry no quality; this
 * way the season's test still names the quality after the next episode
 * starts. A film has no season, so its scope is the title. Never another
 * season, by the owner's definition of the label (2026-10-09): the best
 * "offered for this episode, recently, on this kind of device". Another
 * season is other encodes, and its readings would be a guess about these.
 *
 * The newest offer is the answer: what the source lists is its best. It is
 * looked for in the episode, then in the season, before any floor is: an
 * episode that has only been played carries the play's first picture, a
 * floor, and the season's list says more about this episode than that
 * picture does. Letting the episode's floor win showed "720p+" on an
 * episode whose season the source lists at 1080p, which is the label too
 * low that the owner asked to be rid of. A floor never displaces an offer,
 * even a higher floor, because a floor is one rendition seen at one moment
 * and the offer is the whole list. With no offer, the best floor of the
 * latest `SAMPLE_SIZE` readings in the scope, still as a floor: an adaptive
 * player's first picture is often a lower rung, and the best of several is
 * closer to what the source has.
 */
function qualityOf(
  results: readonly SourceResult[],
  episode: { season: number; episode: number } | null,
): { quality: number; kind: QualityKind } | null {
  const readings = results
    .filter((r) => r.verdict === 'stream' && r.quality !== undefined)
    .sort((a, b) => b.at - a.at)
  const offer = qualityScope(readings.filter(isOffer), episode)[0]
  if (offer !== undefined) return { quality: offer.quality!, kind: 'offered' }
  const latest = qualityScope(readings, episode).slice(0, SAMPLE_SIZE)
  if (latest.length === 0) return null
  return { quality: Math.max(...latest.map((r) => r.quality!)), kind: 'floor' }
}

/**
 * The results a quality is read from (rule 5): the episode's, else its
 * season's. Unlike `inScope`, never the whole title for an episode, which
 * would be other seasons and results from before episodes were kept.
 */
function qualityScope(
  results: readonly SourceResult[],
  episode: { season: number; episode: number } | null,
): SourceResult[] {
  if (episode === null) return [...results]
  const exact = results.filter((r) => r.season === episode.season && r.episode === episode.episode)
  if (exact.length > 0) return exact
  return results.filter((r) => r.season === episode.season)
}

/**
 * The languages a source's sound is offered in: from the newest result that
 * listed them, in the quality's own scope (`qualityScope`), since both are
 * read off the same stream. Another season can be other encodes, and
 * another season's dub is not this one's.
 */
function audioOf(
  results: readonly SourceResult[],
  episode: { season: number; episode: number } | null,
): string[] | undefined {
  const listed = results.filter((r) => r.verdict === 'stream' && r.audio !== undefined).sort((a, b) => b.at - a.at)
  return qualityScope(listed, episode)[0]?.audio
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

/** How the source hands out its video: from the newest success that saw it. */
function newestDelivery(results: readonly SourceResult[]): StreamDelivery | undefined {
  return results
    .filter((r) => r.verdict === 'stream' && r.delivery !== undefined)
    .sort((a, b) => b.at - a.at)[0]?.delivery
}

/**
 * Rule 5: what a television said the last time this source was cast, for
 * any episode of the title, from either kind of device.
 *
 * Tracked apart from the delivery, because the two used to be one field:
 * the newest success that saw a delivery gave both, and a test carries no
 * answer, so the next test erased a refusal and the cast list offered the
 * source again. Now an answer stands until a newer answer or its lifetime.
 *
 * The whole title rather than the episode: a refusal on E1 hid the source
 * on E1 and left it offered on E2, where it failed the same way (a source
 * serves a title's episodes alike). A newer `played` anywhere on the title
 * lifts it. Either kind of device: a television's answer is about the stream
 * and the television, whichever device handed it over.
 */
function newestAnswer(results: readonly SourceResult[]): { cast: CastOutcome; at: number } | null {
  let newest: { cast: CastOutcome; at: number } | null = null
  for (const result of results) {
    if (isCastAnswer(result) && (newest === null || result.at > newest.at)) newest = { cast: result.cast, at: result.at }
  }
  return newest
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

  // Every field but the checks a test hands to `resultsFromScan`, which a decided row never carries.
  const row: Required<Omit<ProviderScan, 'castChecks'>> = {
    titleKey,
    at: 0,
    verdicts: {},
    testedAt: {},
    reasons: {},
    timings: {},
    qualities: {},
    qualityKinds: {},
    audio: {},
    delivery: {},
    casts: {},
    castAt: {},
  }
  const sharedFrom: Record<string, DeviceKind> = {}
  const playedHereAfter = (providerId: string, at: number): boolean => (playedAt[providerId] ?? -Infinity) > at

  for (const [providerId, everything] of byProvider) {
    const answer = newestAnswer(everything)
    if (answer !== null) {
      row.casts[providerId] = answer.cast
      row.castAt[providerId] = answer.at
    }

    const results = everything.filter(isPlaybackEvidence)
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
        const ms = startTime(ownScope)
        if (ms !== undefined) row.timings[providerId] = ms
        // From every result here, not the verdict's scope: see `qualityOf`.
        const quality = qualityOf(
          results.filter((r) => r.deviceKind === here),
          episode,
        )
        if (quality !== null) {
          row.qualities[providerId] = quality.quality
          row.qualityKinds[providerId] = quality.kind
        }
        const audio = audioOf(
          results.filter((r) => r.deviceKind === here),
          episode,
        )
        if (audio !== undefined) row.audio[providerId] = audio
        fillDelivery(row, providerId, ownScope)
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
    fillDelivery(row, providerId, otherScope)
  }

  // A source a television answered for and nothing else measured has an
  // answer and no verdict: still a row, for the cast list.
  const dates = [...Object.values(row.testedAt), ...Object.values(row.castAt)]
  if (dates.length === 0) return { scan: null, sharedFrom }
  row.at = Math.max(...dates)
  return { scan: row, sharedFrom }
}

function fillDelivery(row: Pick<Required<ProviderScan>, 'delivery'>, providerId: string, results: readonly SourceResult[]): void {
  const delivery = newestDelivery(results)
  if (delivery !== undefined) row.delivery[providerId] = delivery
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

/** A language list, or nothing for an empty one: no languages listed is unknown, not none. */
function nonEmpty(audio: string[] | undefined): string[] | undefined {
  return audio !== undefined && audio.length > 0 ? audio : undefined
}

function setOptional<K extends keyof SourceResult>(target: SourceResult, key: K, value: SourceResult[K] | undefined): void {
  if (value !== undefined) target[key] = value
}
