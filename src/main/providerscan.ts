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

/**
 * How long a scan is worth showing.
 *
 * These providers change behaviour by the hour — a backend moves, a domain gets
 * a challenge page, a catalogue gap is filled. A measurement from last week
 * describes a service that no longer exists, and showing it as current is worse
 * than showing nothing, because the user cannot tell the difference.
 *
 * Six hours is chosen to cover the case the feature is actually for: scan a
 * series, then watch several episodes of it over an evening. It is deliberately
 * shorter than a day, so a scan never survives into a session where the user
 * would reasonably assume it had been re-measured.
 */
export const SCAN_TTL_MS = 6 * 60 * 60 * 1000

/**
 * How many titles' scans to keep.
 *
 * Bounded for the same reason the outcome log is: this is written every time
 * the user scans and read on every ranking. Oldest are dropped first. Sixty is
 * far more than the handful of shows anyone has in flight, and small enough
 * that the whole set stays cheap to scan linearly.
 */
export const MAX_SCANS = 60

/** A scan that is recent enough to be worth believing, or null. */
export function freshScan(
  scans: readonly ProviderScan[],
  titleKey: string,
  now: number = Date.now(),
): ProviderScan | null {
  const found = scans.find((scan) => scan.titleKey === titleKey)
  if (!found) return null
  return now - found.at <= SCAN_TTL_MS ? found : null
}

/**
 * Store a completed scan, replacing any earlier one for the same title.
 *
 * Replacing rather than merging is deliberate. A scan is a single measurement
 * of every provider at one moment, and merging two of them would produce a row
 * that was never true all at once — a provider marked working from this morning
 * sitting beside one marked dead from just now, with nothing to tell the user
 * which half is current.
 */
export function recordScan(
  scans: readonly ProviderScan[],
  scan: ProviderScan,
): ProviderScan[] {
  const others = scans.filter((entry) => entry.titleKey !== scan.titleKey)
  const next = [...others, scan]
  return next.length > MAX_SCANS ? next.slice(next.length - MAX_SCANS) : next
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

/** Drop scans that have aged out. Called when the store is loaded. */
export function pruneScans(
  scans: readonly ProviderScan[],
  now: number = Date.now(),
): ProviderScan[] {
  return scans.filter((scan) => now - scan.at <= SCAN_TTL_MS)
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
