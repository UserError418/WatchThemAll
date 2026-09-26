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

import type { Provider, SourceSortKey } from '@shared/types'
import type { ProbeVerdict, ProviderScan, TitleOutcome } from '@shared/ipc'
import { providerRank } from '@shared/scanrank'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How long a test result is shown and used at all: thirty days.
 *
 * It was six hours, on the belief that these providers change by the hour.
 * the owner's experience over months of use is that they do not, and he set thirty
 * days on 2026-09-26. What keeps a month-old result honest is not expiry but
 * re-testing, below — and a real play, which overrides an older red or amber
 * (see `freshScan`).
 */
export const RESULT_TTL_MS = 30 * DAY_MS

/**
 * When the background tester tests a provider again, by what it found last.
 *
 * Reds soonest, because a wrong red is the expensive mistake and nothing else
 * corrects it: a source painted red is one nobody clicks. Ambers a day later,
 * greens only when they expire — spread out, in the owner's words, "to spread the
 * load". Agreed 2026-09-26.
 */
export const RETEST_AFTER_MS: Record<ProbeVerdict, number> = {
  dead: 3 * DAY_MS,
  unsure: 4 * DAY_MS,
  stream: RESULT_TTL_MS,
}

/**
 * How many titles' results to keep.
 *
 * Bounded for the same reason the outcome log is: this is written on every test
 * and read on every ranking. Least recently updated go first. Two hundred
 * covers a long watchlist plus a month of titles scanned by hand, and stays
 * cheap to search linearly.
 */
export const MAX_SCANS = 200

/** When one provider in a row was tested, or null if it never was. */
export function testedAtOf(scan: ProviderScan, providerId: string): number | null {
  if (!(providerId in scan.verdicts)) return null
  // Rows stored before per-provider times existed were all tested at `at`.
  return scan.testedAt?.[providerId] ?? scan.at
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

/** Move one provider's timing, quality and reason from `from` to `to`, or clear them there. */
function copyDetails(from: ProviderScan, to: ProviderScan, id: string): void {
  const timing = from.timings?.[id]
  const quality = from.qualities?.[id]
  const reason = from.reasons?.[id]
  if (timing !== undefined) (to.timings ??= {})[id] = timing
  else if (to.timings) delete to.timings[id]
  if (quality !== undefined) (to.qualities ??= {})[id] = quality
  else if (to.qualities) delete to.qualities[id]
  if (reason !== undefined) (to.reasons ??= {})[id] = reason
  else if (to.reasons) delete to.reasons[id]
}

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
 * Whether the background tester should test this provider for this title now.
 *
 * Never tested is always due. Otherwise by `RETEST_AFTER_MS`, measured from the
 * provider's own test time — not the row's, or re-testing one red would reset
 * the clock on its neighbours.
 */
export function isRetestDue(scan: ProviderScan | undefined, providerId: string, now: number): boolean {
  if (!scan) return true
  const testedAt = testedAtOf(scan, providerId)
  if (testedAt === null) return true
  return now - testedAt >= RETEST_AFTER_MS[scan.verdicts[providerId]!]
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
