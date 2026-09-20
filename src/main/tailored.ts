/**
 * The "for you" row, assembled once for both platforms.
 *
 * The desktop and the phone each used to build this themselves, from the same
 * taste model and with the same two TMDB calls. That was survivable while the
 * answer was "discover by the top three genres" — it is one expression — and
 * stopped being survivable the moment the row became content-based, because
 * two copies of a ranking heuristic drift and nobody notices which one they are
 * looking at.
 *
 * So the policy lives here and the callers supply the network. That also makes
 * the interesting part testable without one.
 *
 * ## Why it asks what it asks
 *
 * `/discover?with_genres=` answers "what is popular in Drama this week", which
 * is the same answer for two people with opposite taste who happen to share a
 * top genre. `/recommendations` answers "what is like *this title*", computed
 * from what people watch together as well as from metadata — it separates two
 * series that share every genre tag and nothing else, which genre filtering
 * structurally cannot do.
 *
 * Genres are still the fallback, because a seed TMDB knows nothing about
 * returns nothing, and a thin row is worse than a generic one.
 */

import type { MediaSummary, MediaType, StoreShape } from '@shared/types'
import { excludedTmdbIds, genreWeights, hasEnoughSignal, seedTitles } from './taste'

export interface TailoredResult {
  items: MediaSummary[]
  genreIds: number[]
  ready: boolean
}

export interface TailoredDeps {
  recommendations: (tmdbId: number, type: MediaType, page: number) => Promise<{ items: MediaSummary[] }>
  discoverByGenres: (type: MediaType, genreIds: number[], page: number) => Promise<{ items: MediaSummary[] }>
}

type TailoredStore = Pick<StoreShape, 'ratings' | 'watched' | 'watchlist' | 'history'>

/**
 * How many content-based matches count as a row that stands on its own.
 *
 * Below this the genre discover is appended to fill it out. The number is a
 * judgement, not a measurement: it is roughly a screen and a half of cards, so
 * the row does not end in visible emptiness on a wide window.
 */
export const ENOUGH = 12

/** Up to three genres, OR-ed. More than three and the row reads as "popular". */
const GENRE_BREADTH = 3

/**
 * Interleave two lists, longest tail last.
 *
 * A taste profile built from a mixed library and answered with series only
 * reads as a bug to anyone whose likes are mostly films.
 */
export function interleave<T>(a: T[], b: T[]): T[] {
  const out: T[] = []
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i]) out.push(a[i] as T)
    if (b[i]) out.push(b[i] as T)
  }
  return out
}

export async function buildTailoredRow(
  store: TailoredStore,
  page: number,
  deps: TailoredDeps,
): Promise<TailoredResult> {
  if (!hasEnoughSignal(store)) return { items: [], genreIds: [], ready: false }

  const weights = genreWeights(store)
  if (weights.length === 0) return { items: [], genreIds: [], ready: false }

  const genreIds = weights.slice(0, GENRE_BREADTH).map((g) => g.genreId)
  const excluded = new Set(excludedTmdbIds(store))

  /*
   * Content first. A candidate recommended by several seeds is a stronger
   * match than one recommended by a single seed, so votes accumulate — weighted
   * by how strongly each seed represents the user, since "like this thing you
   * sat through eleven hours of" is a better lead than "like this thing you
   * put on a list once".
   */
  const seeds = seedTitles(store)
  const pooled = new Map<number, { item: MediaSummary; score: number }>()

  if (seeds.length > 0) {
    const pages = await Promise.all(
      seeds.map((seed) => deps.recommendations(seed.tmdbId, seed.type, page)),
    )

    pages.forEach((result, index) => {
      const seedScore = seeds[index]?.score ?? 1
      for (const item of result.items) {
        if (excluded.has(item.tmdbId)) continue
        const existing = pooled.get(item.tmdbId)
        if (existing) existing.score += seedScore
        else pooled.set(item.tmdbId, { item, score: seedScore })
      }
    })
  }

  const contentBased = [...pooled.values()]
    .sort((a, b) => b.score - a.score || b.item.rating - a.item.rating)
    .map((entry) => entry.item)

  if (contentBased.length >= ENOUGH) return { items: contentBased, genreIds, ready: true }

  const [tv, movie] = await Promise.all([
    deps.discoverByGenres('tv', genreIds, page),
    deps.discoverByGenres('movie', genreIds, page),
  ])

  // Never the same title twice, which is what a plain concatenation would give
  // for anything both queries agree on.
  const seen = new Set(contentBased.map((m) => m.tmdbId))
  const filler = interleave(tv.items, movie.items).filter(
    (m) => !excluded.has(m.tmdbId) && !seen.has(m.tmdbId),
  )

  return { items: [...contentBased, ...filler], genreIds, ready: true }
}
