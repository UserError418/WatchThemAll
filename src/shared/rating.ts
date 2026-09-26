/**
 * The user's own ratings: what the scale means, and which rating applies to
 * what.
 *
 * ## The scale
 *
 * A rating is a whole number from 1 to 10 (`RatingValue`). Builds up to 1.7.3
 * stored a like or a dislike instead, and two things here exist only to bridge
 * the two: the fixed values a legacy opinion converts to, and the reverse
 * mapping that keeps writing a like or a dislike for those builds to read. See
 * `TitleRating.rating` for why that field is still written at all.
 *
 * ## Scope
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

import type { LegacyRating, RatingValue, TitleRating, WatchedEntry } from './types'

/* ── The scale ──────────────────────────────────────────────────────────── */

/**
 * What a legacy like and dislike become on the 1–10 scale.
 *
 * the owner's call, not a derivation: an 8 is a clear "yes" without claiming a
 * favourite, and a 4 a clear "no" without claiming contempt. Both sit far
 * enough inside their band (see `ratingBand`) that the Watched filters hold
 * exactly what they held before the upgrade. A converted value is marked
 * `coarse`, because it says which side the user came down on and nothing
 * about how far.
 */
export const LEGACY_LIKE_VALUE: RatingValue = 8
export const LEGACY_DISLIKE_VALUE: RatingValue = 4

/**
 * The like or dislike a value reads as, for builds that know only those two.
 *
 * The line is 6, the midpoint of the two conversion values, so the round trip
 * through an old build is exact in both directions: like → 8 → like, and
 * dislike → 4 → dislike. That is what lets a record cross between a new and an
 * old device any number of times without drifting.
 *
 * Note that this line is *not* the one `ratingBand` draws. An old build has
 * to put a 6 or a 7 on one side or the other; the new UI has a third band for
 * them. Reading a lukewarm 6 as a like on the old phone is the smaller wrong —
 * it is still above the user's floor — and it only lasts until that phone
 * updates.
 */
export function legacyRatingOf(value: RatingValue): LegacyRating {
  return value >= 6 ? 'like' : 'dislike'
}

/** The fixed value a legacy opinion converts to. */
export function valueOfLegacy(rating: LegacyRating): RatingValue {
  return rating === 'like' ? LEGACY_LIKE_VALUE : LEGACY_DISLIKE_VALUE
}

/**
 * Whether something read from disk, a sync or an import is a valid rating.
 *
 * The only sanctioned way to turn a number into a `RatingValue`. A TMDB score
 * of 7.4 fails it, which is the point — see `RatingValue` for the confusion
 * this guards.
 */
export function isRatingValue(x: unknown): x is RatingValue {
  return typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 10
}

/** Whether something is a like or a dislike as builds up to 1.7.3 wrote them. */
export function isLegacyRating(x: unknown): x is LegacyRating {
  return x === 'like' || x === 'dislike'
}

/** The three ways a rating reads at a glance: the filters, and the tints. */
export type RatingBand = 'liked' | 'mixed' | 'disliked'

/**
 * Which band a rating falls in: 8–10 liked, 6–7 mixed, 1–5 disliked.
 *
 * Not the middle of the range, and deliberately so. It follows the sentiment
 * reading `malimport.ts` already documents for MyAnimeList's scores, which are
 * the same 1–10 and whose community average sits near 7: a 7 is the ordinary
 * outcome and a 6 is mild disappointment, so neither is a "liked", and nothing
 * below 6 is lukewarm enough to call mixed.
 *
 * It also makes the upgrade invisible where the user would notice first. The
 * migrated values, 8 and 4, land in liked and disliked, so the Watched tab's
 * filters keep exactly the contents they had before and "mixed" starts empty
 * — it fills only with ratings the user actually gives on the new scale.
 */
export function ratingBand(value: RatingValue): RatingBand {
  if (value >= 8) return 'liked'
  if (value >= 6) return 'mixed'
  return 'disliked'
}

/* ── Scope ──────────────────────────────────────────────────────────────── */

/** Ratings carry `season: null` for a whole title; `undefined` is pre-1.5.7. */
type Scoped = Pick<TitleRating, 'tmdbId' | 'value'> & { season?: number | null }

/**
 * The rating held at exactly this scope, or null.
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
): RatingValue | null {
  return ratings.find((r) => r.tmdbId === tmdbId && (r.season ?? null) === season)?.value ?? null
}

/**
 * The rating that applies to a watched entry, at the entry's own scope.
 *
 * A watched entry already knows what it is about — a season, or a whole title —
 * so the scope should never be passed separately. Every place that wanted "the
 * rating on this card" and reached for `ratingForScope` with its own idea of
 * the season is a place that could get it wrong.
 */
export function ratingForEntry(
  ratings: readonly Scoped[],
  entry: Pick<WatchedEntry, 'tmdbId' | 'season'>,
): RatingValue | null {
  return ratingForScope(ratings, entry.tmdbId, entry.season ?? null)
}
