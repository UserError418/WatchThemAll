/**
 * What has actually streamed, and for what.
 *
 * Health probes answer "is this host up". That is not the question. The
 * question is "will this provider play *this episode* for *me*", and the only
 * evidence that answers it is a play that worked. A provider can be perfectly
 * reachable and not carry the show; another can be slow and carry everything.
 *
 * So every playback attempt writes an outcome here, and `Automatic` reads them
 * back — but only to *narrow* the list, never to reorder it. Ordering belongs
 * to the user:
 *
 *   1. The user's own provider order, set by dragging in the Providers panel.
 *   2. Narrowed to sources known to have played this title, when any have.
 *   3. Favourites moved to the front of whatever that leaves.
 *
 * This replaced a scored ranking — Wilson-discounted reliability, an
 * exact-episode tier, a mirror-group tier, and boosts for favourites and for
 * the last source used. It ordered well on paper and was impossible to predict
 * from the outside: a favourite lost to a non-favourite that had merely
 * streamed the title more recently, and the user reasonably read that as the
 * favourite setting being broken. A rule the user can state themselves beats a
 * better rule they cannot, because they are the one who has to trust it.
 *
 * The record shape is deliberately the shape a shared service would accept:
 * `{ providerId, mediaKey, outcome, at }` and nothing user-identifying. That is
 * the point of the design — one day these get pooled across users, so that a
 * title someone else already found a working source for is instantly playable
 * for everyone. Nothing here reaches the network today, but nothing here would
 * have to change for it to.
 */

import type { Provider } from '@shared/types'
import type { TitleOutcome } from '@shared/ipc'

/** What happened when we tried to play something. */
export type Outcome = 'stream' | 'failed'

export interface StreamOutcome {
  providerId: string
  /**
   * The exact thing that was played: `tv:tt0903747:1:1` or `movie:tt0137523`.
   *
   * Episode-level rather than title-level, because coverage is episode-level.
   * Providers routinely carry a series' first season and not its fourth, and a
   * title-level key would confidently recommend a provider for an episode it
   * has never had.
   */
  mediaKey: string
  outcome: Outcome
  /** Epoch ms. */
  at: number
}

/**
 * How many outcomes to keep.
 *
 * Bounded because this file is written on every play and read on every ranking,
 * and an unbounded log would grow without limit for a benefit that decays: an
 * outcome from a year ago says almost nothing about a provider whose backend
 * has changed hands twice since. Oldest are dropped first.
 */
export const MAX_OUTCOMES = 750

/** Build the key a play should be recorded under. */
export function mediaKey(req: {
  type: 'tv' | 'movie'
  imdbId: string | null
  tmdbId: number
  season?: number | null
  episode?: number | null
}): string {
  // IMDB id preferred: it is what the providers themselves key on, so two
  // records for the same episode cannot end up under different keys just
  // because one play started from a TMDB-sourced summary.
  const id = req.imdbId || `tmdb${req.tmdbId}`
  if (req.type === 'movie') return `movie:${id}`
  return `tv:${id}:${req.season ?? 1}:${req.episode ?? 1}`
}

/**
 * The key for a *title*, ignoring which episode.
 *
 * `mediaKey` is deliberately episode-level, because coverage is: a provider
 * routinely carries a series' first season and not its fourth. But the source
 * picker is answering a coarser question — "does this provider work for this
 * show" — and an episode-level answer would leave almost every dot blank, since
 * the user is rarely re-picking a source for an episode they have already
 * watched.
 */
export function titleKey(req: { type: 'tv' | 'movie'; imdbId: string | null; tmdbId: number }): string {
  const id = req.imdbId || `tmdb${req.tmdbId}`
  return `${req.type}:${id}`
}

// One definition of this lives in the contract, because the renderer draws
// from it and main derives it — see `TitleOutcome` in `@shared/ipc`.
export type { TitleOutcome } from '@shared/ipc'

/**
 * Roll the log up per provider for one title, across all its episodes.
 *
 * `worked` wins over `failed` regardless of order. A provider that has ever
 * produced a stream for this show demonstrably can; a later failure is far more
 * likely to be one missing episode or a bad night than a lost catalogue, and
 * flipping the dot red would tell the user to avoid the one source known to
 * carry it.
 */
export function outcomesForTitle(
  log: StreamOutcome[],
  key: string,
): Record<string, TitleOutcome> {
  const out: Record<string, TitleOutcome> = {}
  // `key` is a prefix of every episode key for this title: `tv:tt0903747`
  // against `tv:tt0903747:1:1`. The separator keeps `tt09037` from matching
  // `tt0903747`.
  const prefix = `${key}:`

  for (const entry of log) {
    if (entry.mediaKey !== key && !entry.mediaKey.startsWith(prefix)) continue
    if (out[entry.providerId] === 'worked') continue
    out[entry.providerId] = entry.outcome === 'stream' ? 'worked' : 'failed'
  }
  return out
}

/**
 * The provider that most recently *streamed* this title, at any episode.
 *
 * Title-level on purpose. `mediaKey` is episode-level because coverage is —
 * a provider routinely carries a series' first season and not its fourth — but
 * "carry on with the source I was just watching this show on" is a question
 * about the show. Keying it per episode would forget the answer at every
 * episode boundary, which is exactly where continuing matters most.
 *
 * Only `stream` outcomes count. A provider that was merely *opened* proves
 * nothing; the whole point is that this one is known to have played.
 */
export function lastWorkingForTitle(log: StreamOutcome[], key: string): string | null {
  // Same prefix rule as `outcomesForTitle`: the separator keeps `tt09037` from
  // matching `tt0903747`.
  const prefix = `${key}:`

  let best: StreamOutcome | null = null
  for (const entry of log) {
    if (entry.outcome !== 'stream') continue
    if (entry.mediaKey !== key && !entry.mediaKey.startsWith(prefix)) continue
    if (!best || entry.at > best.at) best = entry
  }
  return best?.providerId ?? null
}

/** Append an outcome, dropping the oldest once the log is full. */
export function record(
  log: StreamOutcome[],
  entry: Omit<StreamOutcome, 'at'> & { at?: number },
): StreamOutcome[] {
  const next = [...log, { ...entry, at: entry.at ?? Date.now() }]
  return next.length > MAX_OUTCOMES ? next.slice(next.length - MAX_OUTCOMES) : next
}

/**
 * Reorder a fallback chain so a failure moves to a **different backend** first.
 *
 * Without this, a failure walks through every mirror of the provider that just
 * failed before reaching anything genuinely different — and since mirrors share
 * a backend, they fail identically. Measured on the shipped catalogue that was
 * five wasted loads and roughly twenty seconds before the user reached a
 * provider that could have worked.
 *
 * Order within a group is preserved, so the ranking above still decides which
 * mirror represents its group.
 */
export function spreadAcrossGroups<T extends { provider: Provider }>(candidates: T[]): T[] {
  const seen = new Set<string>()
  const first: T[] = []
  const rest: T[] = []

  for (const candidate of candidates) {
    // An ungrouped provider is its own backend, so it always counts as new.
    const group = candidate.provider.group ?? `solo:${candidate.provider.id}`
    if (seen.has(group)) rest.push(candidate)
    else {
      seen.add(group)
      first.push(candidate)
    }
  }

  return [...first, ...rest]
}

/**
 * The order a fresh install starts with: the catalogue, spread across backends.
 *
 * Only a *default*. Once the user drags a row in the Providers panel their
 * order is stored and this is never consulted again — an order the user set is
 * an instruction, and quietly improving on it is how a setting stops meaning
 * anything.
 *
 * Spread rather than raw catalogue order because six of the shipped entries are
 * mirrors of one backend, and mirrors fail identically. Left adjacent, a dead
 * backend costs five loads and about twenty seconds before Automatic reaches a
 * genuinely different source. Nobody would choose that order by hand, so it is
 * a bad thing to hand someone as their starting point.
 */
export function defaultProviderOrder(providers: Provider[]): string[] {
  return spreadAcrossGroups(providers.map((provider) => ({ provider }))).map((e) => e.provider.id)
}

export interface AutomaticOptions {
  /**
   * The user's global provider order, best first, as provider ids.
   *
   * Providers missing from it — added by a catalogue refresh after the order
   * was last saved — keep their catalogue order behind everything the user has
   * actually placed. Appending is the only safe guess: inserting them anywhere
   * else would silently move a source the user had deliberately positioned.
   */
  order?: readonly string[]
  /** Providers the user starred. Moved to the front of whatever list remains. */
  favouriteIds?: readonly string[]
}

/**
 * Order providers for Automatic, best first.
 *
 * **Superseded by `scanAwareOrder` in `providerscan.ts`, which both apps now
 * call.** That function is this one with a background scan's verdicts folded
 * in, and it reduces to exactly this behaviour when nothing has been scanned —
 * so the rules below still describe what happens on an unscanned title. Kept
 * for its tests, which pin that baseline. Do not wire it up to anything new:
 * a caller reaching for this one gets provider ordering that silently ignores
 * everything the user's last scan measured.
 *
 * Three rules, applied in this order, and all three are the user's rather than
 * the app's:
 *
 * 1. **The user's order is the baseline.** Not a tiebreak — the starting list.
 * 2. **Known-working sources come first, when there are any.** If anything has
 *    ever streamed this title, everything untried and everything that failed
 *    moves behind it. This is title-level on purpose: it is exactly what the
 *    green dots in the source picker already show the user, so the list they
 *    see and the list Automatic walks cannot disagree.
 * 3. **Favourites lead each segment.** Within the known-working sources, and
 *    again within the rest.
 *
 * Note that step 2 *demotes* rather than drops. The user asked to filter the
 * others out, and for every purpose they can observe that is what happens — the
 * first choice and every fallback are identical either way. The difference only
 * shows up when every known-working source fails right now, where dropping
 * would leave Automatic with nothing to try while eight untried providers sat
 * there unused. A dead end is a worse outcome than a long chain.
 */
export function automaticOrder(
  providers: Provider[],
  titleOutcomes: Record<string, TitleOutcome>,
  options: AutomaticOptions = {},
): Provider[] {
  const { order = [], favouriteIds = [] } = options
  const favourites = new Set(favouriteIds)
  const place = new Map(order.map((id, index) => [id, index]))

  const byUserOrder = providers
    .map((provider, index) => ({ provider, index }))
    .sort(
      (a, b) =>
        (place.get(a.provider.id) ?? order.length) - (place.get(b.provider.id) ?? order.length) ||
        // Catalogue order decides between two providers the user has not
        // placed, so the result does not depend on sort implementation.
        a.index - b.index,
    )
    .map((entry) => entry.provider)

  const favouritesFirst = (list: Provider[]): Provider[] => [
    ...list.filter((p) => favourites.has(p.id)),
    ...list.filter((p) => !favourites.has(p.id)),
  ]

  const worked = byUserOrder.filter((p) => titleOutcomes[p.id] === 'worked')
  if (worked.length === 0) return favouritesFirst(byUserOrder)

  const rest = byUserOrder.filter((p) => titleOutcomes[p.id] !== 'worked')
  return [...favouritesFirst(worked), ...favouritesFirst(rest)]
}
