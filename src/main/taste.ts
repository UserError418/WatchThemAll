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

import type { MediaType, StoreShape } from '@shared/types'

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

/* ── Affinity: which titles actually represent this person's taste ───────── */

/**
 * How much each *title* is worth as a statement of taste.
 *
 * `genreWeights` above answers "which genres", and that is as far as this file
 * used to go. It produces a row that is genuinely about the user and still
 * feels generic, because a genre is a very coarse thing: "Drama" covers both
 * halves of most people's library and everything TMDB will return for it is
 * simply what is popular in Drama this week. Two people with opposite taste and
 * the same top genre get the same row.
 *
 * So this scores titles rather than genres, and the scores are then used to ask
 * TMDB what is *like* those titles — which is a content-based question it can
 * answer well, from co-watching and metadata, and which no amount of genre
 * filtering approximates.
 *
 * ## Time invested is the signal that was being thrown away
 *
 * The store has always recorded how long the player actually ran, per play, and
 * nothing read it. It is the most honest signal here: saving a title is an
 * intention and rating one is a claim, but sitting through eleven hours of
 * something is a fact. It is also the only signal that distinguishes a series
 * somebody genuinely lives in from one they finished out of stubbornness.
 *
 * Counted with a square root rather than linearly. A person with one 90-hour
 * comfort show and forty other titles should not have a profile consisting
 * entirely of that show, and untreated hours do exactly that — the long-running
 * series swamps everything and the row becomes a monoculture.
 */
export const AFFINITY = {
  like: 6,
  dislike: -8,
  /** Per season of a series marked watched, so a five-season binge outranks a film. */
  watchedSeason: 2,
  watched: 3,
  watchlist: 1,
  /** Multiplier on the square root of hours actually played. */
  perRootHour: 2.5,
} as const

export interface TitleAffinity {
  tmdbId: number
  type: MediaType
  score: number
}

type AffinityStore = Pick<StoreShape, 'ratings' | 'watched' | 'watchlist' | 'history'>

/**
 * Titles scored by how strongly they represent the user's taste, best first.
 *
 * Negative scores — things actively disliked — are kept out rather than merely
 * ranked last: asking "what is like this" about something the user told us they
 * disliked is the fastest way to discredit the whole row.
 */
export function titleAffinity(store: AffinityStore): TitleAffinity[] {
  const scores = new Map<number, { type: MediaType; score: number }>()

  const add = (tmdbId: number, type: MediaType, delta: number): void => {
    if (!tmdbId) return
    const current = scores.get(tmdbId)
    if (current) current.score += delta
    else scores.set(tmdbId, { type, score: delta })
  }

  for (const entry of store.watchlist) add(entry.tmdbId, entry.type, AFFINITY.watchlist)

  for (const entry of store.watched) {
    // A season entry is a smaller claim than "I watched this whole thing", but
    // several of them add up to a larger one — which is the point of scoping.
    add(entry.tmdbId, entry.type, entry.season === null ? AFFINITY.watched : AFFINITY.watchedSeason)
  }

  for (const rating of store.ratings) {
    add(rating.tmdbId, rating.type, rating.rating === 'like' ? AFFINITY.like : AFFINITY.dislike)
  }

  // Hours per title, then damped. See the note above on why not linearly.
  const playedMs = new Map<number, number>()
  for (const play of store.history) {
    if (!play.tmdbId || !play.playedMs) continue
    playedMs.set(play.tmdbId, (playedMs.get(play.tmdbId) ?? 0) + play.playedMs)
  }
  for (const [tmdbId, ms] of playedMs) {
    const existing = scores.get(tmdbId)
    if (!existing) continue
    existing.score += Math.sqrt(ms / 3_600_000) * AFFINITY.perRootHour
  }

  return [...scores.entries()]
    .map(([tmdbId, { type, score }]) => ({ tmdbId, type, score }))
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score || a.tmdbId - b.tmdbId)
}

/**
 * How many titles to ask TMDB about.
 *
 * Each seed is one request, and they are made together on every open of the
 * Browse tab. Five is enough for a row that visibly changes as the library
 * does, and few enough that the row does not cost a burst of traffic.
 */
export const SEED_LIMIT = 5

/** The titles worth asking "what is like this?" about. */
export function seedTitles(store: AffinityStore, limit = SEED_LIMIT): TitleAffinity[] {
  return titleAffinity(store).slice(0, limit)
}
