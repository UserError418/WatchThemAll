/**
 * Which opinion applies to what.
 *
 * Ratings are scoped: a series can hold one, and so can each of its seasons,
 * because a show worth watching can have a season that is not. That makes every
 * lookup a question about *scope* rather than about a title, and getting the
 * scope wrong is silent — the answer is a real rating for a real title, just
 * not the one being asked about.
 *
 * It already went wrong once. The Watched tab asked for the series rating while
 * its own rate buttons set the season one, so a season the user had just liked
 * kept being listed as unrated, with a lit thumb on the same card. Nothing a
 * linter or a type checker can see: both calls are well-typed, and the two
 * disagree only about an argument one of them left out.
 *
 * So the rule lives here, once, and callers ask this rather than re-deriving
 * it.
 *
 * ## Unresolved imports share one identity
 *
 * An import that never resolved carries `tmdbId: 0`, and several of them are
 * indistinguishable here — rating one would show on all of them. That is not
 * guarded against, deliberately: `rate` writes such a rating under the key
 * `tv:0` regardless, so refusing to *read* it back would leave the buttons
 * doing nothing visible at all. One shared opinion across unresolved titles is
 * a smaller wrong than a control that silently ignores the user.
 */

import type { Rating, TitleRating, WatchedEntry } from './types'

/** Ratings carry `season: null` for a whole title; `undefined` is pre-1.5.7. */
type Scoped = Pick<TitleRating, 'tmdbId' | 'rating'> & { season?: number | null }

/**
 * The opinion held at exactly this scope, or null.
 *
 * Deliberately not a fallback: asking about season 3 does *not* return the
 * series rating. A season nobody has rated is unrated, and answering with the
 * series' opinion would make every season of a liked show look individually
 * liked — which is the whole distinction the season scope exists to draw.
 */
export function ratingForScope(
  ratings: readonly Scoped[],
  tmdbId: number,
  season: number | null,
): Rating | null {
  return ratings.find((r) => r.tmdbId === tmdbId && (r.season ?? null) === season)?.rating ?? null
}

/**
 * The opinion that applies to a watched entry, at the entry's own scope.
 *
 * A watched entry already knows what it is about — a season, or a whole title —
 * so the scope should never be passed separately. Every place that wanted "the
 * rating on this card" and reached for `ratingForScope` with its own idea of
 * the season is a place that could get it wrong.
 */
export function ratingForEntry(
  ratings: readonly Scoped[],
  entry: Pick<WatchedEntry, 'tmdbId' | 'season'>,
): Rating | null {
  return ratingForScope(ratings, entry.tmdbId, entry.season ?? null)
}
