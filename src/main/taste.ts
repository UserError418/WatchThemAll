/**
 * What the user seems to like, as genre weights.
 *
 * This is the input to the tailored Browse row. It is deliberately a small,
 * isolated, pure function rather than something woven through the views,
 * because the *scoring* is the part most likely to be replaced — the shape of
 * the answer (an ordered list of genre ids with weights) is stable, the way we
 * arrive at it is not.
 *
 * ## What it reads, and why each is weighted as it is
 *
 * Four sources, in descending order of how much they tell us:
 *
 * - **An explicit dislike** is the strongest signal in the set and the only
 *   negative one. Someone who says they disliked something has told us more
 *   than someone who merely saved it, and unlike everything else here it can
 *   push a genre *below* zero and out of the results entirely.
 * - **An explicit like** is next: a stated opinion, unprompted.
 * - **A finished title** — in the watched list — is a revealed preference. Weaker
 *   than a stated one because finishing something is not the same as rating it,
 *   but it is a completed act rather than an intention.
 * - **A watchlist entry** is the weakest: it is an intention, and a watchlist is
 *   full of things people mean to get to.
 *
 * The weights are ordinal, not measured. There is no data to fit them against
 * on a fresh install, and inventing a precision we do not have would make this
 * harder to reason about without making it better. They are chosen so that one
 * dislike cancels a like, and so that no amount of watchlist padding outranks a
 * handful of stated opinions.
 */

import type { StoreShape } from '@shared/types'

/** How much one appearance of a genre is worth, per source. */
export const WEIGHTS = {
  like: 3,
  dislike: -3,
  watched: 2,
  watchlist: 1,
} as const

export interface GenreWeight {
  genreId: number
  weight: number
}

/**
 * Genre weights, strongest first, negatives dropped.
 *
 * Negatives are dropped rather than kept and inverted: there is no "show me
 * less of this" surface to spend them on, and a genre the user actively
 * dislikes should simply not appear rather than appear at the bottom.
 */
export function genreWeights(store: Pick<StoreShape, 'ratings' | 'watched' | 'watchlist'>): GenreWeight[] {
  const totals = new Map<number, number>()

  const add = (genreIds: number[] | undefined, weight: number): void => {
    for (const id of genreIds ?? []) {
      totals.set(id, (totals.get(id) ?? 0) + weight)
    }
  }

  for (const entry of store.watchlist) add(entry.genreIds, WEIGHTS.watchlist)
  for (const entry of store.watched) add(entry.genreIds, WEIGHTS.watched)
  for (const rating of store.ratings) {
    add(rating.genreIds, rating.rating === 'like' ? WEIGHTS.like : WEIGHTS.dislike)
  }

  return [...totals]
    .map(([genreId, weight]) => ({ genreId, weight }))
    .filter((g) => g.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.genreId - b.genreId)
}

/**
 * Titles the tailored row must not suggest.
 *
 * Everything the user has already saved, already seen, or already judged. A
 * recommendation whose first result is a show sitting in the watchlist reads as
 * broken, and it is the single most common way a "for you" row discredits
 * itself.
 */
export function excludedTmdbIds(
  store: Pick<StoreShape, 'ratings' | 'watched' | 'watchlist'>,
): number[] {
  const ids = new Set<number>()
  for (const entry of store.watchlist) ids.add(entry.tmdbId)
  for (const entry of store.watched) if (entry.tmdbId) ids.add(entry.tmdbId)
  for (const rating of store.ratings) if (rating.tmdbId) ids.add(rating.tmdbId)
  ids.delete(0)
  return [...ids]
}

/**
 * Whether there is enough signal to bother showing a tailored row.
 *
 * Below this the row would be "because you watch Drama" derived from two saved
 * titles, which is a guess wearing the costume of a recommendation. Showing
 * nothing is more honest and the surface has plenty else on it.
 */
export const MIN_SIGNAL = 3

export function hasEnoughSignal(
  store: Pick<StoreShape, 'ratings' | 'watched' | 'watchlist'>,
): boolean {
  return store.ratings.length + store.watched.length + store.watchlist.length >= MIN_SIGNAL
}
