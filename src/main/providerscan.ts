/**
 * Trying every provider up front, so the user does not have to.
 *
 * ## The question this answers
 *
 * `outcomes.ts` records what *has* played. That is the best evidence there is,
 * and it has one gap: a title nobody has watched yet has no evidence at all, so
 * every dot is blank and Automatic is guessing. The user's own fix for that was
 * to press play, wait, watch it fail, pick the next source, and repeat — which
 * is the manual work this replaces.
 *
 * A scan plays the title on every enabled provider in the background and writes
 * down what happened. The dots then say something about *this* title before the
 * user has tried anything, and Automatic walks a list that was measured rather
 * than assumed.
 *
 * ## Three verdicts, because two would lie
 *
 * The temptation is `worked` / `failed`, matching the outcome log. It is wrong,
 * and the cost of being wrong is asymmetric: a provider marked dead is one the
 * user will not try, so a false red removes a working source permanently while
 * a false green costs one click. Probes have false negatives — a bot challenge,
 * a slow CDN, a provider that happened to be restarting — and they are not rare
 * enough to round away.
 *
 * So there is a middle verdict for "the provider answered but nothing streamed",
 * and it renders amber rather than red. It means *try this one by hand*, which
 * is exactly the state it describes.
 *
 *   - `stream` — media was actually fetched. The strongest signal available on
 *     either platform, and the only one that cannot be faked by a page that
 *     loads fine and plays nothing.
 *   - `unsure` — the provider is alive and reachable, but no media followed
 *     within the budget. Worth a manual try.
 *   - `dead` — nothing usable: no template for this title, the host did not
 *     resolve, or the page made no meaningful requests at all.
 *
 * *Absent* stays the meaningful fourth state, exactly as it is for outcomes: a
 * provider that was never scanned is not a provider that failed. See the note
 * on `TitleOutcome` in the contract — a dot of any colour is a claim, and "no
 * idea" is not one.
 *
 * ## Why everything here is pure
 *
 * The phone runs the same scan against the same store, and its bridge imports
 * this file. Every function here is a transformation of plain data, over
 * other pure modules. The platform-specific part — *how* you make a provider
 * try to play — lives in `scanservice.ts` on the desktop and `bridge/scan.ts`
 * on the phone. Importing Electron or Node here would break the port: ESLint
 * refuses it in every file the phone's bundle reaches (`eslint.config.js`,
 * with the set worked out from the imports by `tools/phonereach.js`), and
 * `mobile/src/boundary.test.ts` loads each of them with no `process`.
 */

import type { DeviceKind, Provider, QualityKind, ScanReason, SourceSortKey, StoreShape } from '@shared/types'
import type { CastLearned } from '@shared/castanswer'
import { isDownloadedSource } from '@shared/downloads/types'
import { verdictForReason } from '@shared/scanreason'
import type { ProbeVerdict, ProviderScan, ResumeSource, TitleOutcome } from '@shared/ipc'
import { providerRank } from '@shared/scanrank'
import { MAX_SCANS, RESULT_TTL_MS, testedAtOf } from '@shared/scanrow'
import type { TitleResults } from '@shared/scanshare'
import {
  deviceRows,
  isPlaybackEvidence,
  legacyResults,
  measurement,
  titleResults as decideTitle,
  type MeasuredAt,
  type ResultDevice,
  type SourceResult,
} from '@shared/sourceresults'
import { lastPlayedAt } from './outcomes'

/**
 * Moved to `shared/scanrow.ts` so the sync merge can reach them; re-exported so
 * this stays the one module a caller needs for test results.
 */
export { MAX_SCANS, RESULT_TTL_MS, testedAtOf }

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * When the background tester tests a provider again, by what it found last.
 *
 * Reds soonest, because a wrong red is the expensive mistake and nothing else
 * corrects it: a source painted red is one nobody clicks. Ambers a day later,
 * greens only when they expire — spread out, as the owner put it, "to spread
 * the load". Agreed 2026-09-26.
 */
export const RETEST_AFTER_MS: Record<ProbeVerdict, number> = {
  dead: 3 * DAY_MS,
  unsure: 4 * DAY_MS,
  stream: RESULT_TTL_MS,
}

/* ── Reading results ─────────────────────────────────────────────────── */

/**
 * Where test results come from: the history (`@shared/sourceresults`, its own
 * file and its own synced file), and the library's title-wide rows from
 * before it, this device's (`providerScans`) and the other devices'
 * (`sharedScans`).
 *
 * The old rows are no longer written. They are read as results of the whole
 * title until they age out, and a device still on an older build keeps
 * adding its rows to `sharedScans` through the library until it is updated.
 */
export interface ResultSources {
  history: readonly SourceResult[]
  doc: Pick<StoreShape, 'deviceId' | 'providerScans' | 'sharedScans' | 'streamOutcomes'>
}

function everyResult(sources: ResultSources, here: DeviceKind): SourceResult[] {
  const legacy = legacyResults(sources.doc, { deviceId: sources.doc.deviceId, deviceKind: here })
  return legacy.length === 0 ? [...sources.history] : [...sources.history, ...legacy]
}

/**
 * One title's results as this device reads them, for one episode: null for a
 * film, or for a series when no episode is in question. The rules are
 * `@shared/sourceresults`'s.
 *
 * Everything that acts on test results reads them through this: Automatic's
 * order, the pickers' dots, the resume rule, the player's switch offer, the
 * stream preview. So a green means the same thing in all of them.
 *
 * `playedAt` comes from the play log, where a real play from before plays
 * were kept as results still overtakes an older failure.
 */
export function titleResults(
  sources: ResultSources,
  key: string,
  episode: { season: number; episode: number } | null,
  here: DeviceKind,
  now: number = Date.now(),
): TitleResults {
  return decideTitle({
    results: everyResult(sources, here),
    titleKey: key,
    episode,
    here,
    now,
    playedAt: lastPlayedAt(sources.doc.streamOutcomes, key),
  })
}

/**
 * This device's own results, one title-wide row per title: what the
 * background tester schedules from. It decides what *this* device should
 * measure next, so another device's results do not count.
 */
export function ownRows(sources: ResultSources, here: DeviceKind, now: number = Date.now()): ProviderScan[] {
  return deviceRows(
    everyResult(sources, here).filter((result) => result.deviceId === sources.doc.deviceId),
    now,
  )
}

/**
 * Whether this kind of device has tested every one of `providerIds` on the
 * title: by hand, by the background tester or by `autotest.ts`, any episode.
 * Plays and previews do not count; they measure the one source that was
 * used. Every source, so a scan cancelled part-way (the phone cancels one
 * when the app leaves the screen) is not taken for a finished one.
 */
export function kindTested(sources: ResultSources, here: DeviceKind, key: string, providerIds: readonly string[]): boolean {
  const tested = new Set(
    everyResult(sources, here)
      .filter((result) => result.titleKey === key && result.deviceKind === here && result.origin === 'test')
      .map((result) => result.providerId),
  )
  return providerIds.every((id) => tested.has(id))
}

/** Every device's title-wide rows: a source's castability record across titles. */
export function everyRow(sources: ResultSources, here: DeviceKind, now: number = Date.now()): ProviderScan[] {
  return deviceRows(everyResult(sources, here), now)
}

/* ── Writing results ─────────────────────────────────────────────────── */

/**
 * The test results as a platform holds them: what is known, which install
 * this is, and where to keep what it measures. One per app, handed to
 * everything that reads or records results.
 */
export interface ResultsAccess {
  sources(): ResultSources
  device(): ResultDevice
  record(results: readonly SourceResult[]): void
}

/**
 * The longest a play's time to stream is believed. Past it, the wait
 * included the user: a source's poster waiting for a click, or a "keep
 * waiting". The success still counts, without a time. The desktop player's
 * silence check fires at the same moment, for the same reason.
 */
export const PLAY_TIMING_MAX_MS = 25_000

/**
 * The shortest video taken for the film rather than an advert, for what a
 * play measures: below any episode, above any advert seen on these sources.
 * The preview's `MIN_FILM_SECONDS` is the same rule.
 */
export const PLAY_MIN_FILM_SECONDS = 120

/**
 * What one load of a source showed while the user watched, or while the
 * detail view previewed it: that it streamed, or that it failed in a way
 * that cannot be mistaken.
 *
 * Re-reported with the same `at` as more is learned (the picture improves in
 * the first minute; the player's own list of qualities answers), which
 * replaces the result rather than adding one: a result is identified by its
 * device, time and source. Re-reported only ever with a quality at least as
 * high, and at the same quality only from a floor to an offer, which is the
 * order `knowsMore` keeps copies in on every build.
 */
export type PlayMeasurement =
  | {
      at: number
      streamed: true
      /** From the start of the load to the stream playing. Absent when the wait included the user. */
      ms?: number
      /**
       * The source's best as a quality class: the top of its player's own
       * list (offered), or failing that the best picture seen (a floor).
       */
      quality?: number
      qualityKind?: QualityKind
      /** The languages its sound is offered in, from its player's own list (`withPlayOffer`). */
      audio?: string[]
    }
  | {
      at: number
      streamed: false
      /**
       * Only failures the source's own servers declared: an error status for
       * its page or its backend, or its video refused. A dropped network, a
       * crash, a page still loading or waiting for a click, say nothing about
       * the source, so they are not results.
       */
      reason: ScanReason
    }

/** A start of a source on a title within this long of another on the same device is a warm one. */
export const WARM_START_MS = 30 * 60_000

/**
 * Tells a cold start of a source from a warm one, on this device.
 *
 * A play or a preview files how long its source took to start, and the
 * source lists show the median. A start soon after the same source played
 * the same title here is warm: its page, player and first segments come from
 * the HTTP cache, most of all on the phone, where the preview and the player
 * share one WebView — Resume carrying the preview over, or the preview coming
 * back after the player. Such a start can take well under a second and says
 * nothing about the source (the owner, 2026-09-30: sources that "load in
 * under 1 s"). A warm start still counts as a success; it files no time.
 */
export class WarmStarts {
  private readonly starts = new Map<string, number[]>()

  /** Whether the start at `at` is warm. Asking again for the same start (a play re-filed with its quality) answers the same. */
  isWarm(titleKey: string, providerId: string, at: number): boolean {
    const key = `${titleKey}\u0000${providerId}`
    const before = (this.starts.get(key) ?? []).filter((t) => at - t < WARM_START_MS)
    const warm = before.some((t) => t < at)
    if (!before.includes(at)) before.push(at)
    this.starts.set(key, before.slice(-8))
    return warm
  }

  /** `seen` without its time when the start was warm. */
  measure<T extends { at: number; ms?: number }>(titleKey: string, providerId: string, seen: T): T {
    // Noted whether or not it carries a time: it warms the next start either way.
    const warm = this.isWarm(titleKey, providerId, seen.at)
    if (!warm || seen.ms === undefined) return seen
    const untimed = { ...seen }
    delete untimed.ms
    return untimed
  }
}

/**
 * A play's success with one more quality reading taken in, or null when the
 * reading changes nothing and the play need not be filed again.
 *
 * - An offer (the top of the player's own list) is final for the play: a
 *   floor never displaces it, and the list is asked for once.
 * - A floor (a decoded picture) is taken when it is better than the one held.
 * - An offer is taken over a floor at least as high. One below a picture
 *   already decoded is not believed: the list found is not the one playing.
 *
 * So a play is only ever filed again with a quality at least as high, and at
 * the same quality only from a floor to an offer: the order `knowsMore`
 * (`sourceresults.ts`) keeps the copies in, on this build and on one from
 * before kinds were kept. Both platforms' players go through here.
 */
export function withQualityReading<T extends { at: number; quality?: number; qualityKind?: QualityKind }>(
  seen: T,
  reading: { quality: number; kind: QualityKind },
): T | null {
  if (seen.qualityKind === 'offered') return null
  const held = seen.quality ?? 0
  const taken = reading.kind === 'offered' ? reading.quality >= held : reading.quality > held
  return taken ? { ...seen, quality: reading.quality, qualityKind: reading.kind } : null
}

/**
 * A play's measurement with its source's own list, as the player's controls
 * told it once the film played (`WtaPlayerApi.offered`): its top as the
 * quality where `withQualityReading` takes it, and the languages its sound
 * is offered in where none were known. Null when it adds nothing.
 */
export function withPlayOffer<T extends { at: number; quality?: number; qualityKind?: QualityKind; audio?: string[] }>(
  seen: T,
  offer: { quality: number; audio: readonly string[] },
): T | null {
  const offered = withQualityReading(seen, { quality: offer.quality, kind: 'offered' })
  const takesAudio = offer.audio.length > 0 && (seen.audio === undefined || seen.audio.length === 0)
  if (offered === null && !takesAudio) return null
  const base = offered ?? seen
  return takesAudio ? { ...base, audio: [...offer.audio] } : base
}

/** A play's or a preview's measurement as a result: weaker than a test when it failed, see `sourceresults.ts`. */
export function playResult(where: MeasuredAt, origin: 'play' | 'preview', seen: PlayMeasurement): SourceResult {
  if (!seen.streamed) {
    return measurement(where, { at: seen.at, origin, verdict: verdictForReason(seen.reason), reason: seen.reason })
  }
  return measurement(where, {
    at: seen.at,
    origin,
    verdict: 'stream',
    ...(seen.ms === undefined ? {} : { ms: seen.ms }),
    ...(seen.quality === undefined ? {} : { quality: seen.quality }),
    ...(seen.quality === undefined || seen.qualityKind === undefined ? {} : { qualityKind: seen.qualityKind }),
    ...(seen.audio === undefined || seen.audio.length === 0 ? {} : { audio: seen.audio }),
  })
}

/**
 * A preview that played, as a success for its source: `streamedMs` after it
 * opened (`PreviewReport.streamedMs`). Null for a time that is not one.
 */
export function previewResult(where: MeasuredAt, streamedMs: number, at: number): SourceResult | null {
  if (typeof where.providerId !== 'string' || !Number.isFinite(streamedMs) || streamedMs < 0) return null
  return playResult(where, 'preview', { at, streamed: true, ms: Math.round(streamedMs) })
}

/**
 * What a beam files about its source, on either platform: one result when
 * the television answered, and nothing otherwise.
 *
 * `learned` exists only once the receiver has played or refused the stream
 * (`shared/castanswer.ts`). A beam that failed before that, or was still
 * loading when the wait ran out, passes none and files nothing: until 2.0.18
 * it filed its delivery as a success, which read as "casts to this TV" and as
 * a green for the source, and all 13 casts on the owner's record were that.
 *
 * Nothing for a download either, which is not a source; the phone filed one
 * under `downloaded` until 2.0.18.
 *
 * A play, not a test: it measured no start time and no quality. Its verdict
 * is `stream` whatever the television said, as casts were always filed; only
 * one that played counts as the source streaming (`isPlaybackEvidence`).
 */
export function castResults(where: MeasuredAt, learned: CastLearned | undefined, at: number): SourceResult[] {
  if (learned === undefined || isDownloadedSource(where.providerId)) return []
  return [
    measurement(where, {
      at,
      origin: 'play',
      verdict: 'stream',
      delivery: learned.delivery,
      cast: learned.outcome,
    }),
  ]
}

/**
 * Whether the background tester should test this provider for this title now.
 *
 * Never tested is always due. Otherwise by `RETEST_AFTER_MS`, measured from the
 * provider's own test time — not the row's, or re-testing one red would reset
 * the clock on its neighbours.
 *
 * One exception: a green that does not say how its video arrived is due now.
 * Greens were stored for a month before `delivery` existed, and without it
 * nobody can say whether the source casts — so each is measured once more,
 * at the tester's one-provider-a-minute pace, and never again for that
 * reason: every test since records a delivery, `unknown` included.
 */
export function isRetestDue(scan: ProviderScan | undefined, providerId: string, now: number): boolean {
  if (!scan) return true
  const testedAt = testedAtOf(scan, providerId)
  if (testedAt === null) return true
  const verdict = scan.verdicts[providerId]!
  if (verdict === 'stream' && scan.delivery?.[providerId] === undefined) return true
  return now - testedAt >= RETEST_AFTER_MS[verdict]
}

/**
 * Which episode a scan should actually probe.
 *
 * A TV request with no season or episode renders **no URL at all** — the
 * templates carry `{season}` and `{episode}`, and `renderTemplate` refuses
 * rather than substituting blanks. Every provider then comes back
 * `no-template`, which maps to `dead`, and the user is shown a full row of red
 * dots telling them to give up on sources that were never contacted.
 *
 * That is not hypothetical: it shipped in the first version of this feature and
 * was caught by running a scan from the detail view, where the episode was not
 * being passed. The caller has been fixed, but a wrong answer this expensive
 * should not depend on every caller remembering — so the floor lives here,
 * where both platforms go through it.
 *
 * Falling back to the first episode is the right guess rather than merely a
 * safe one: a provider's coverage of a series almost always starts at S1E1, so
 * it is the episode most likely to distinguish a provider that carries the show
 * from one that does not.
 */
export function scanEpisode(
  type: 'tv' | 'movie',
  episode: { season: number; episode: number } | null | undefined,
): { season: number; episode: number } | null {
  if (type === 'movie') return null
  if (episode && episode.season >= 1 && episode.episode >= 1) return episode
  return { season: 1, episode: 1 }
}

/**
 * Re-exported so callers of this module get the ranking without a second
 * import, and so the one definition stays in `shared/` where the renderer can
 * reach it. The source pickers colour their dots from the same function, which
 * is what keeps "green" meaning "Automatic will try this first".
 */
export { providerRank } from '@shared/scanrank'

export interface ScanOrderOptions {
  /** The user's global provider order, best first. */
  order?: readonly string[]
  /** Providers the user starred. They lead their tier when `list` decides. */
  favouriteIds?: readonly string[]
  /** The fresh scan for this title, if there is one. */
  scan?: ProviderScan | null
  /**
   * What decides within a tier, in priority order — `Settings.sourceOrder`.
   * Defaults to the user's list alone, which is the order before the setting
   * existed.
   */
  sourceOrder?: readonly SourceSortKey[]
}

/**
 * Two start times count as the same speed within this factor of the faster.
 *
 * Relative, not absolute, because that is how the measurement wobbles: the
 * same provider has started in 12 s and in 15 s on consecutive runs, while a
 * fast one moves by a few tenths. A fixed 0.3 s would split slow providers on
 * noise and still call 0.8 s and 1.0 s different.
 */
export const SAME_SPEED_FACTOR = 1.3

/**
 * ...and never closer than this. The phone times a stream to the poll that
 * noticed it, every half second, so it cannot tell two starts apart any finer.
 */
export const SAME_SPEED_FLOOR_MS = 500

/**
 * Order providers for Automatic, best first, using measurement where it exists.
 *
 * Two layers. The outer one is fixed: `providerRank`'s tiers, so a source that
 * works always comes before one that may work, and that before one that does
 * not — a preference for speed or quality is not a licence to try a dead
 * source first. Without a scan every provider lands in tier 1, 3 or 4: the
 * worked-first split of `automaticOrder`, except that a source that failed on
 * this title goes behind the untried ones rather than staying among them.
 *
 * The inner layer is the user's `sourceOrder`: a chain of keys, each deciding
 * only among the providers the keys before it left tied. Speed groups sources
 * that started within `SAME_SPEED_FACTOR` of each other; quality groups by
 * class; the list — favourites first, then the provider order — orders
 * completely. With the default chain, list first, this is exactly the order
 * the Providers panel promises and the scan decides nothing but the tier.
 *
 * A provider with no measurement for a key sorts after those with one, inside
 * its group: known evidence before no evidence, as in the tiers.
 */
export function scanAwareOrder(
  providers: Provider[],
  titleOutcomes: Record<string, TitleOutcome>,
  options: ScanOrderOptions = {},
): Provider[] {
  const { order = [], favouriteIds = [], scan = null, sourceOrder = ['list'] } = options
  const favourites = new Set(favouriteIds)
  const place = new Map(order.map((id, index) => [id, index]))

  // Everything starts in list order, so every grouping below is stable with
  // respect to it and `list` needs no work of its own when it is reached.
  const inListOrder = providers
    .map((provider, index) => ({ provider, index }))
    .sort(
      (a, b) =>
        (favourites.has(a.provider.id) ? 0 : 1) - (favourites.has(b.provider.id) ? 0 : 1) ||
        (place.get(a.provider.id) ?? order.length) - (place.get(b.provider.id) ?? order.length) ||
        // Catalogue order decides between two providers the user has not
        // placed, so the result does not depend on sort implementation.
        a.index - b.index,
    )
    .map((entry) => entry.provider)

  const tiers = new Map<number, Provider[]>()
  for (const provider of inListOrder) {
    const rank = providerRank(titleOutcomes[provider.id], scan?.verdicts[provider.id])
    tiers.set(rank, [...(tiers.get(rank) ?? []), provider])
  }

  const measured = {
    speed: (id: string) => scan?.timings?.[id],
    quality: (id: string) => scan?.qualities?.[id],
  }
  return [...tiers.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([, tier]) => orderWithin(tier, sourceOrder, measured))
}

/** Automatic's order for one title, and the source it resumes on, if any. */
export interface AutomaticOrder {
  providers: Provider[]
  /** Null when there is nothing to resume on, or it is no longer green. */
  resume: ResumeSource | null
}

/**
 * The source this title last played on, on *this device*: its newest play
 * that streamed in the results history. Null when this device never played it.
 *
 * Per device, not the library's `streamOutcomes`, which sync and carry no
 * device: a title watched on the phone last resumed on the PC on the
 * phone's source, which may be the phone's best and not the PC's (the owner,
 * 2026-09-30: "I find myself manually switching the provider too often").
 */
export function lastPlayedHere(sources: ResultSources, key: string): string | null {
  let best: SourceResult | null = null
  for (const result of sources.history) {
    if (result.titleKey !== key || result.deviceId !== sources.doc.deviceId) continue
    if (result.origin !== 'play' || result.verdict !== 'stream') continue
    // A cast the television refused, or the source blocked, was not watched.
    if (!isPlaybackEvidence(result)) continue
    if (!best || result.at > best.at) best = result
  }
  return best?.providerId ?? null
}

/**
 * Start where the user left off: the source this title last streamed on goes
 * first, as long as it is still green.
 *
 * The owner's call, 2026-09-26. The ordering rules decide the *first* visit
 * well, but they are a guess about sources in general, and once the user has
 * watched a title on the second or third source in that order, the guess has
 * been answered for this title. Starting from the top again on every return
 * means a slow or broken first choice every time, followed by a switch the
 * user already made once.
 *
 * Not the "last used" boost `outcomes.ts` records removing. That one was a
 * weight among others, applied everywhere, and could beat a favourite for
 * reasons the user could not see. This moves exactly one source — the one
 * both pickers label "resume", so the list says what happens — and only for
 * the title it streamed. Favourites still decide every title not yet watched.
 *
 * "Still green" is `providerRank` 0 or 1: measured streaming, or streamed with
 * no newer test saying otherwise. A source a later test found dead or
 * unsure is not resumed on; the ordinary order stands, with it in its tier.
 */
export function resumeFirst(
  ordered: Provider[],
  resumeId: string | null,
  titleOutcomes: Record<string, TitleOutcome>,
  scan: ProviderScan | null,
): AutomaticOrder {
  const at = ordered.findIndex((p) => p.id === resumeId)
  // Absent means disabled on this device, and a disabled source is never tried.
  if (at < 0 || !isResumable(resumeId, titleOutcomes, scan)) return { providers: ordered, resume: null }
  const source = ordered[at] as Provider
  if (at === 0) return { providers: ordered, resume: { providerId: source.id, movedFrom: null } }
  return {
    providers: [source, ...ordered.slice(0, at), ...ordered.slice(at + 1)],
    resume: { providerId: source.id, movedFrom: at },
  }
}

/**
 * Whether Automatic may start on this source: green in both pickers.
 *
 * Exported because the pickers' blue "resume" marker makes the same promise
 * and must not make it about a source Automatic will not start on.
 */
export function isResumable(
  providerId: string | null,
  titleOutcomes: Record<string, TitleOutcome>,
  scan: ProviderScan | null,
): boolean {
  if (providerId === null) return false
  return providerRank(titleOutcomes[providerId], scan?.verdicts[providerId]) <= 1
}

/** Order one tier by the chain of keys, each breaking only the ties of the last. */
function orderWithin(
  providers: Provider[],
  keys: readonly SourceSortKey[],
  measured: Record<'speed' | 'quality', (id: string) => number | undefined>,
): Provider[] {
  const [key, ...rest] = keys
  // `list` is the order they arrived in, and it leaves no ties behind.
  if (key === undefined || key === 'list' || providers.length < 2) return providers
  const groups = key === 'speed' ? bySpeed(providers, measured.speed) : byQuality(providers, measured.quality)
  return groups.flatMap((group) => orderWithin(group, rest, measured))
}

/**
 * Fastest first, in groups that count as the same speed.
 *
 * Grouped from the fastest down, each group holding everything within the
 * factor of its own first member. Pairwise "close enough" is not transitive —
 * 1.0, 1.25 and 1.55 s would each be close to the next — so the group's
 * fastest is the one reference, which keeps the answer the same whatever order
 * the providers arrive in.
 */
function bySpeed(providers: Provider[], ms: (id: string) => number | undefined): Provider[][] {
  const timed = providers
    .filter((p) => ms(p.id) !== undefined)
    .sort((a, b) => (ms(a.id) ?? 0) - (ms(b.id) ?? 0))
  const groups: Provider[][] = []
  let limit = -Infinity
  for (const provider of timed) {
    const time = ms(provider.id) ?? 0
    if (time > limit) {
      groups.push([])
      limit = Math.max(time * SAME_SPEED_FACTOR, time + SAME_SPEED_FLOOR_MS)
    }
    groups[groups.length - 1]?.push(provider)
  }
  // Each group back into list order, so the next key sees ties as the user
  // placed them rather than as the clock happened to fall.
  const listed = (group: Provider[]): Provider[] => providers.filter((p) => group.includes(p))
  const untimed = providers.filter((p) => ms(p.id) === undefined)
  return [...groups.map(listed), ...(untimed.length ? [untimed] : [])]
}

/**
 * Best quality first, one group per class, unknown last.
 *
 * By the value alone, whatever its kind: "720p+" and "720p" are one group.
 * A floor says the source has at least this, an offer that it has this; to
 * put the offer first would push a source down for how it was measured,
 * which says nothing about its picture. The next key in the chain decides
 * between them instead.
 */
function byQuality(providers: Provider[], quality: (id: string) => number | undefined): Provider[][] {
  const classes = [...new Set(providers.map((p) => quality(p.id)).filter((q): q is number => q !== undefined))]
  const unknown = providers.filter((p) => quality(p.id) === undefined)
  return [
    ...classes.sort((a, b) => b - a).map((c) => providers.filter((p) => quality(p.id) === c)),
    ...(unknown.length ? [unknown] : []),
  ]
}

/**
 * How far through a scan we are, for the progress readout.
 *
 * Separated from the service so the number the user reads is testable without
 * starting a browser.
 */
export function scanProgress(verdicts: Record<string, ProbeVerdict>, total: number): {
  done: number
  total: number
  working: number
} {
  const values = Object.values(verdicts)
  return {
    done: values.length,
    total,
    working: values.filter((verdict) => verdict === 'stream').length,
  }
}
