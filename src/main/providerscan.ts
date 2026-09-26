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
 * The phone runs the same scan against the same store, and `mobile/README.md`
 * lists `outcomes.ts` among the modules shared verbatim. This file is in that
 * set: every function is a transformation of plain data, and the only imports
 * are types and one shared pure module. The platform-specific part — *how* you
 * make a provider try to play — lives in `scanservice.ts` on the desktop and
 * `bridge/scan.ts` on the phone. Importing Electron here would break the port
 * and the `lint-imports` contract that guards it.
 */

import type { CastOutcome, DeviceKind, Provider, SourceSortKey, StoreShape, StreamDelivery } from '@shared/types'
import type { ProbeVerdict, ProviderScan, ResumeSource, TitleOutcome } from '@shared/ipc'
import { providerRank } from '@shared/scanrank'
import { MAX_SCANS, RESULT_TTL_MS, testedAtOf } from '@shared/scanrow'
import { withSharedResults, type TitleResults } from '@shared/scanshare'
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

/**
 * A copy of `scan` holding only the providers `keep` accepts, or null if none
 * are left. `at` follows the newest provider kept.
 */
function keepProviders(
  scan: ProviderScan,
  keep: (providerId: string, testedAt: number) => boolean,
): ProviderScan | null {
  const out: ProviderScan = { titleKey: scan.titleKey, at: 0, verdicts: {}, testedAt: {} }
  for (const [id, verdict] of Object.entries(scan.verdicts)) {
    const testedAt = testedAtOf(scan, id) ?? scan.at
    if (!keep(id, testedAt)) continue
    out.verdicts[id] = verdict
    out.testedAt![id] = testedAt
    out.at = Math.max(out.at, testedAt)
    copyDetails(scan, out, id)
  }
  return Object.keys(out.verdicts).length > 0 ? out : null
}

/**
 * Move one provider's details — timing, quality, reason, how its video arrived
 * and what a television made of it — from `from` to `to`, or clear them there.
 *
 * All or nothing per provider: a new measurement replaces everything the old
 * one said about that provider, so a detail it did not produce is removed
 * rather than left standing beside a result it no longer describes.
 */
function copyDetails(from: ProviderScan, to: ProviderScan, id: string): void {
  // The maps hold different value types, which one loop can only see as unknown.
  const source = from as Details
  const target = to as Details
  for (const key of DETAIL_KEYS) {
    const value = source[key]?.[id]
    if (value !== undefined) (target[key] ??= {})[id] = value
    else delete target[key]?.[id]
  }
}

/** Every per-provider detail a row can carry besides the verdict and its time. */
const DETAIL_KEYS = ['timings', 'qualities', 'reasons', 'delivery', 'casts'] as const

type Details = Partial<Record<(typeof DETAIL_KEYS)[number], Record<string, unknown>>>

/**
 * What is still worth believing about one title, or null if nothing is.
 *
 * Two things take a result out:
 *
 * - **Age.** Older than `RESULT_TTL_MS`.
 * - **A real play since.** `playedAt` is when each provider last actually
 *   streamed this title in the player. A red or amber test result older than
 *   that is overtaken by the stronger evidence — the source demonstrably
 *   played — and leaving it in would keep a working source at the bottom of
 *   the list, because a red outranks play history in `providerRank`. Plays only
 *   ever upgrade: the player records `failed` on ambiguous symptoms (a source
 *   that is merely slow), so a failure there is not allowed to overrule a test.
 */
export function freshScan(
  scans: readonly ProviderScan[],
  titleKey: string,
  now: number = Date.now(),
  playedAt: Readonly<Record<string, number>> = {},
): ProviderScan | null {
  const found = scans.find((scan) => scan.titleKey === titleKey)
  if (!found) return null
  return keepProviders(found, (id, testedAt) => {
    if (now - testedAt > RESULT_TTL_MS) return false
    const played = playedAt[id]
    return found.verdicts[id] === 'stream' || played === undefined || played <= testedAt
  })
}

/**
 * One title's results as this device reads them: its own fresh ones, with the
 * user's other devices' good news folded in (the rule is `scanshare.ts`'s).
 *
 * Everything that acts on test results reads them through this — Automatic's
 * order, the pickers' dots, the resume rule, the player's switch offer — so
 * a green that came from the desktop means the same thing in all of them.
 * Only the background tester reads the device's own rows alone: what it
 * decides is what *this* device should measure next.
 */
export function titleResults(
  doc: Pick<StoreShape, 'providerScans' | 'sharedScans' | 'streamOutcomes'>,
  key: string,
  here: DeviceKind,
  now: number = Date.now(),
): TitleResults {
  const playedAt = lastPlayedAt(doc.streamOutcomes, key)
  const own = freshScan(doc.providerScans, key, now, playedAt)
  return withSharedResults(own, doc.sharedScans, key, here, now, playedAt)
}

/**
 * Store test results for one title, merged into what is already known.
 *
 * Merged per provider, not replaced. This used to replace the whole row,
 * because a row was one scan measured at one moment and merging two would have
 * produced a row that was never true all at once. The background tester tests
 * one provider at a time, days apart, so rows are now mixed by design — and
 * every provider carries its own `testedAt`, which is what makes the mix
 * honest rather than misleading.
 *
 * `result` may hold every provider (a scan by hand) or just one (the tester).
 * Each provider it holds replaces that provider's earlier result entirely,
 * timing, quality and reason included; the others are left alone.
 */
export function recordScan(
  scans: readonly ProviderScan[],
  result: ProviderScan,
): ProviderScan[] {
  const previous = scans.find((entry) => entry.titleKey === result.titleKey)
  const merged: ProviderScan = previous
    ? {
        ...previous,
        verdicts: { ...previous.verdicts },
        testedAt: Object.fromEntries(
          Object.keys(previous.verdicts).map((id) => [id, testedAtOf(previous, id) ?? previous.at]),
        ),
        timings: { ...previous.timings },
        qualities: { ...previous.qualities },
        reasons: { ...previous.reasons },
        delivery: { ...previous.delivery },
        casts: { ...previous.casts },
      }
    : { titleKey: result.titleKey, at: 0, verdicts: {}, testedAt: {} }

  for (const [id, verdict] of Object.entries(result.verdicts)) {
    const testedAt = testedAtOf(result, id) ?? result.at
    merged.verdicts[id] = verdict
    merged.testedAt![id] = testedAt
    copyDetails(result, merged, id)
  }
  merged.at = Math.max(0, ...Object.values(merged.testedAt!))

  // Most recently updated last, so the cap below drops the stalest title.
  const next = [...scans.filter((entry) => entry.titleKey !== result.titleKey), merged]
  return next.length > MAX_SCANS ? next.slice(next.length - MAX_SCANS) : next
}

/**
 * File what a real cast found out about one source for one title.
 *
 * A cast that identified a stream is a measurement — the source streamed, and
 * the stream was fetched and classified — so it is stored as one: a green
 * verdict, tested now, with how the video arrived and, where the television
 * answered unambiguously, what it said. Unlike a test it measured no start
 * time and no quality, so the ones already known for the source are kept
 * rather than cleared.
 */
export function recordCast(
  scans: readonly ProviderScan[],
  titleKey: string,
  providerId: string,
  learned: { delivery: StreamDelivery; outcome: CastOutcome | null },
  now: number,
): ProviderScan[] {
  const previous = scans.find((entry) => entry.titleKey === titleKey)
  const result: ProviderScan = {
    titleKey,
    at: now,
    verdicts: { [providerId]: 'stream' },
    testedAt: { [providerId]: now },
    delivery: { [providerId]: learned.delivery },
  }
  const timing = previous?.verdicts[providerId] === 'stream' ? previous.timings?.[providerId] : undefined
  const quality = previous?.verdicts[providerId] === 'stream' ? previous.qualities?.[providerId] : undefined
  if (timing !== undefined) result.timings = { [providerId]: timing }
  if (quality !== undefined) result.qualities = { [providerId]: quality }
  if (learned.outcome !== null) result.casts = { [providerId]: learned.outcome }
  return recordScan(scans, result)
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
 * Drop results that have aged out, and rows left empty by that. Called when a
 * result is stored.
 */
export function pruneScans(
  scans: readonly ProviderScan[],
  now: number = Date.now(),
): ProviderScan[] {
  return scans.flatMap((scan) => keepProviders(scan, (_id, testedAt) => now - testedAt <= RESULT_TTL_MS) ?? [])
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
 * source first. It degrades to `automaticOrder` when there is no scan: without
 * verdicts every provider lands in tier 1, 3 or 4, the same worked-first split.
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

/** Best quality first, one group per class. */
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
