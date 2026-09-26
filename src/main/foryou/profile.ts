/**
 * The taste profile Browse plans from: the whole library's, and one per lane.
 *
 * Per lane because a genre means different things in each. In the library
 * this was tuned on, "Drama" is nearly all anime — measured, the Drama shelf
 * was 91% animation — so a live-action drama scored by the whole library's
 * taste was being scored by how much it resembled anime. Each lane is scored
 * by its own titles instead, as long as it has enough of them to go on
 * (`MIN_LANE_TITLES`).
 */

import type { MediaType } from '@shared/types'
import {
  avoidedConcepts,
  conceptAffinity,
  normalisedGenreFit,
  ownedTitles,
  titleAffinity,
  titleId,
  titleNames,
  type ConceptAffinity,
  type TasteStore,
  type TitleAffinity,
} from '../taste'
import { guessLanes, LANES, type Lane } from './lanes'
import { isListed } from '@shared/listed'

export interface LaneProfile {
  lane: Lane
  /** The lane's own titles, both liked and disliked. */
  titles: TitleAffinity[]
  singles: ConceptAffinity[]
  pairs: ConceptAffinity[]
  /** Concept → affinity scaled to ±1, for scoring the lane's candidates. */
  fit: Map<number, number>
  /** The lane's part of everything the user likes, 0..1. What earns it rows. */
  share: number
  /**
   * The lane had too few liked titles to trust its own genre taste, so its
   * genres and themes are borrowed (see `BORROW`). Its seeds are still its own.
   */
  borrowed: boolean
  /**
   * How much of the lane's liking is films, clamped — see `FILM_SHARE`. Only
   * anime spans both catalogues, so only anime uses it.
   */
  filmShare: number
}

export interface Profile {
  titles: TitleAffinity[]
  /** Concept → affinity scaled to ±1, across the whole library. */
  fit: Map<number, number>
  singles: ConceptAffinity[]
  pairs: ConceptAffinity[]
  avoided: number[]
  owned: Set<string>
  names: Map<string, string>
  /** Each of the user's titles' lane, by `titleId`. */
  laneOf: Map<string, Lane>
  lanes: Record<Lane, LaneProfile>
  /** The watchlist, newest first: what the user means to watch next. */
  watchlist: Array<{ tmdbId: number; type: MediaType; genreIds: number[] }>
}

/**
 * Fewer liked titles than this and a lane's genre taste is borrowed.
 *
 * Four, the same bar as a genre pair (`MIN_PAIR_TITLES`): below it, one title
 * decides the lane's whole taste. A user with two rated films still gets movie
 * rows — shaped by what they like in series, which says more than two films.
 */
export const MIN_LANE_TITLES = 4

/**
 * Where a thin lane borrows its genre taste from.
 *
 * Series and films from each other: live-action taste carries across the
 * catalogues well. Anime from the whole library, which is all there is left.
 */
const BORROW: Record<Lane, Lane[]> = {
  series: ['series', 'films'],
  films: ['series', 'films'],
  anime: ['series', 'films', 'anime'],
}

/**
 * The least and most of a lane that is films, when it spans both catalogues.
 *
 * Clamped rather than exact: at zero, someone who has never rated an anime film
 * would never be shown one, and the lane would confirm the profile forever
 * instead of testing it.
 */
const FILM_SHARE = { min: 0.2, max: 0.8 } as const

/**
 * The profile.
 *
 * `lanes` places the user's titles; without it they are placed without asking
 * TMDB (`guessLanes`), which is right for everything but animation added by
 * hand. `forYouPlan` and `forYouRow` pass the looked-up answer.
 */
export function buildProfile(
  store: TasteStore,
  now = Date.now(),
  lanes?: ReadonlyMap<string, Lane>,
): Profile {
  const titles = titleAffinity(store, now)
  const laneOf = new Map(lanes ?? guessLanes(titles, store))
  for (const [id, lane] of guessLanes(titles, store)) if (!laneOf.has(id)) laneOf.set(id, lane)

  const { singles, pairs } = conceptAffinity(titles)
  const liked = (ts: readonly TitleAffinity[]): number =>
    ts.reduce((sum, t) => sum + Math.max(0, t.score), 0)
  const total = liked(titles)

  const inLanes = (set: readonly Lane[]): TitleAffinity[] =>
    titles.filter((t) => set.includes(laneOf.get(titleId(t.type, t.tmdbId))!))

  const laneProfile = (lane: Lane): LaneProfile => {
    const own = inLanes([lane])
    const borrowed = own.filter((t) => t.score > 0).length < MIN_LANE_TITLES
    const taste = conceptAffinity(borrowed ? inLanes(BORROW[lane]) : own)
    const films = liked(own.filter((t) => t.type === 'movie'))
    const mine = liked(own)
    return {
      lane,
      titles: own,
      singles: taste.singles,
      pairs: taste.pairs,
      fit: normalisedGenreFit(taste.singles),
      share: total > 0 ? mine / total : 0,
      borrowed,
      filmShare: Math.min(FILM_SHARE.max, Math.max(FILM_SHARE.min, mine > 0 ? films / mine : 0.5)),
    }
  }

  return {
    titles,
    fit: normalisedGenreFit(singles),
    singles,
    pairs,
    avoided: avoidedConcepts(singles),
    owned: ownedTitles(store),
    names: titleNames(store),
    laneOf,
    lanes: Object.fromEntries(LANES.map((l) => [l, laneProfile(l)])) as Record<Lane, LaneProfile>,
    // Listed only: this seeds "More like your watchlist", and an unlisted
    // entry is a title the user ticked or rated, not one they saved.
    watchlist: [...store.watchlist]
      .filter((w) => w.tmdbId > 0 && isListed(w))
      .sort((a, b) => b.addedAt - a.addedAt)
      .map((w) => ({ tmdbId: w.tmdbId, type: w.type, genreIds: w.genreIds ?? [] })),
  }
}

/**
 * The titles a lane's genre taste comes from: its own, or for a thin lane, the
 * ones it borrows from. What its themes are read from too — except for a thin
 * anime lane, whose themes would come from live action and say nothing about
 * anime, so it has none.
 */
export function tasteSources(profile: Profile, lane: Lane): TitleAffinity[] {
  const own = profile.lanes[lane]
  if (!own.borrowed) return own.titles
  if (lane === 'anime') return []
  return BORROW[lane].flatMap((l) => profile.lanes[l].titles)
}
