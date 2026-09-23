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

import type { Provider } from '@shared/types'
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
  /** The user's global provider order, best first. The baseline, not a tiebreak. */
  order?: readonly string[]
  /** Providers the user starred. They lead each tier. */
  favouriteIds?: readonly string[]
  /** The fresh scan for this title, if there is one. */
  scan?: ProviderScan | null
}

/**
 * Order providers for Automatic, best first, using measurement where it exists.
 *
 * This is `automaticOrder` with a scan folded in, and it degrades to exactly
 * that function's behaviour when there is no scan: without verdicts every
 * provider lands in tier 1, 3 or 4, which is the same worked-first-then-rest
 * split, with the user's order and favourites deciding within each.
 *
 * The user's order remains the baseline inside every tier. That is the rule the
 * Providers panel promises, and a measurement is not a licence to break it —
 * the scan decides which *group* a provider is in, never where it sits among
 * its equals.
 */
export function scanAwareOrder(
  providers: Provider[],
  titleOutcomes: Record<string, TitleOutcome>,
  options: ScanOrderOptions = {},
): Provider[] {
  const { order = [], favouriteIds = [], scan = null } = options
  const favourites = new Set(favouriteIds)
  const place = new Map(order.map((id, index) => [id, index]))

  return providers
    .map((provider, index) => ({ provider, index }))
    .sort((a, b) => {
      const rankA = providerRank(titleOutcomes[a.provider.id], scan?.verdicts[a.provider.id])
      const rankB = providerRank(titleOutcomes[b.provider.id], scan?.verdicts[b.provider.id])
      if (rankA !== rankB) return rankA - rankB

      // Favourites lead their tier, not the whole list: a starred provider that
      // was just measured dead must not be tried before one measured working.
      const favA = favourites.has(a.provider.id) ? 0 : 1
      const favB = favourites.has(b.provider.id) ? 0 : 1
      if (favA !== favB) return favA - favB

      return (
        (place.get(a.provider.id) ?? order.length) - (place.get(b.provider.id) ?? order.length) ||
        // Catalogue order decides between two providers the user has not
        // placed, so the result does not depend on sort implementation.
        a.index - b.index
      )
    })
    .map((entry) => entry.provider)
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
