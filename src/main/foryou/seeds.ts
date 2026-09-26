/**
 * Which of the user's titles a row recommends from, and which genres a shelf
 * is about.
 *
 * Everything here takes a list of titles rather than the whole profile, so the
 * same rules pick seeds for the whole library or for one lane.
 */

import {
  conceptsOf,
  investment,
  titleId,
  type ConceptAffinity,
  type TitleAffinity,
} from '../taste'

/** How many favourites Top picks pools, and how many dislikes it consults. */
export const TOP_PICK_SEEDS = 6
export const ANTI_SEEDS = 2
/** Below this a title is not disliked enough to argue against anything. */
const ANTI_SEED_THRESHOLD = -0.8

/** How many "Because you…" candidates a session draws from. */
const BECAUSE_POOL = 12

/** How similar two seeds' genres may be before the second is redundant. */
const MAX_SEED_OVERLAP = 0.75

function jaccard(a: readonly number[], b: readonly number[]): number {
  const sa = new Set(conceptsOf(a))
  const sb = new Set(conceptsOf(b))
  if (sa.size === 0 && sb.size === 0) return 0
  let shared = 0
  for (const x of sa) if (sb.has(x)) shared += 1
  return shared / (sa.size + sb.size - shared)
}

/**
 * How much a seed identical in genre to one already chosen is discounted.
 *
 * At a half, a redundant favourite needs about twice the strength of a novel
 * one to win the slot — so a second 10 from the same corner of the library
 * loses to a 9 from a different one, which is the trade the row wants: six
 * seeds are few, and each should widen the pool.
 */
const SEED_OVERLAP_DISCOUNT = 0.5

/**
 * The favourites a pooled row is built from.
 *
 * The strongest titles, but not blindly: six seasons of near-identical shows
 * would make a row that is one taste six times. Each pick is discounted by how
 * much it overlaps the ones already chosen (maximal marginal relevance, in the
 * literature), so a runner-up from a different corner of the library can win a
 * place over a stronger title that adds nothing new.
 */
export function topPickSeeds(titles: readonly TitleAffinity[], limit = TOP_PICK_SEEDS): TitleAffinity[] {
  const pool = titles.filter((t) => t.score > 0)
  const chosen: TitleAffinity[] = []
  while (chosen.length < limit && pool.length > 0) {
    let best = 0
    let bestValue = -Infinity
    pool.forEach((t, i) => {
      const overlap = Math.max(0, ...chosen.map((c) => jaccard(c.genreIds, t.genreIds)))
      const value = t.score * (1 - SEED_OVERLAP_DISCOUNT * overlap)
      if (value > bestValue) {
        bestValue = value
        best = i
      }
    })
    chosen.push(pool.splice(best, 1)[0]!)
  }
  return chosen
}

/** The titles the user liked least, whose recommendations count against a candidate. */
export function antiSeeds(titles: readonly TitleAffinity[], limit = ANTI_SEEDS): TitleAffinity[] {
  return titles
    .filter((t) => t.score <= ANTI_SEED_THRESHOLD)
    .sort((a, b) => a.score - b.score || a.tmdbId - b.tmdbId)
    .slice(0, limit)
}

/**
 * How much more a recently watched title is worth as a "Because you" seed.
 *
 * Up to double for something watched today, fading over about six weeks.
 * "Because you watched" is most persuasive about what the user was just doing,
 * which is why every streaming service leads with it — and least persuasive
 * about a title from years ago that happens to be rated highly.
 */
const RECENCY_DAYS = 45
const DAY_MS = 86_400_000

function recencyBoost(lastActive: number, now: number): number {
  if (!lastActive) return 0
  const days = Math.max(0, (now - lastActive) / DAY_MS)
  return Math.exp(-days / RECENCY_DAYS)
}

/** A small deterministic PRNG (mulberry32), so a session seed means one page. */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Every eligible "Because you…" seed, in the order this session would use them.
 *
 * Only titles the user demonstrably watched or rated — "Because you watched"
 * about something merely saved would be false — and only ones with a name to
 * put in the heading. From the strongest dozen, the order is a random draw in
 * proportion to strength and recency, with draws that duplicate an earlier
 * one's genres moved to the back. Random so the page changes; weighted so it
 * changes between good answers; seeded so it does not change while the user is
 * looking at it.
 *
 * The plan walks down this list, passing over seeds TMDB has too little for.
 */
export function becauseCandidates(
  titles: readonly TitleAffinity[],
  names: ReadonlyMap<string, string>,
  seed: number,
  now = Date.now(),
): TitleAffinity[] {
  const pool = titles
    .filter((t) => t.score > 0)
    .filter((t) => t.verdict !== null || investment(t.engagement) > 0)
    .filter((t) => names.has(titleId(t.type, t.tmdbId)))
    .map((t) => ({ t, weight: t.score * (1 + recencyBoost(t.engagement.lastActive, now)) }))
    .sort((a, b) => b.weight - a.weight || a.t.tmdbId - b.t.tmdbId)
    .slice(0, BECAUSE_POOL)

  // A weighted shuffle of the whole pool: every draw takes one candidate with
  // probability proportional to its weight, until none are left.
  const random = prng(seed)
  const remaining = [...pool]
  const order: TitleAffinity[] = []
  while (remaining.length > 0) {
    let pick = random() * remaining.reduce((sum, c) => sum + c.weight, 0)
    let index = 0
    while (index < remaining.length - 1 && pick >= remaining[index]!.weight) {
      pick -= remaining[index]!.weight
      index += 1
    }
    order.push(remaining.splice(index, 1)[0]!.t)
  }

  // Then every draw that does not repeat an earlier draw's genres, followed by
  // the ones that do — so the head of the list is as varied as the pool
  // allows, and a narrow library still gets its rows, just similar ones.
  const redundant = (t: TitleAffinity, chosen: TitleAffinity[]): boolean =>
    chosen.some((c) => jaccard(c.genreIds, t.genreIds) >= MAX_SEED_OVERLAP)
  const distinct: TitleAffinity[] = []
  for (const t of order) {
    if (!redundant(t, distinct)) distinct.push(t)
  }
  return [...distinct, ...order.filter((t) => !distinct.includes(t))]
}

/** What a "Because you…" heading says, from the verdict behind it. */
export function becauseVerb(t: TitleAffinity): 'loved' | 'liked' | 'watched' {
  const v = t.verdict
  // "Loved" only for a 9 or 10 actually chosen on the scale. A converted
  // thumb is an 8 by construction and cannot claim more than "liked".
  if (v && !v.coarse && v.value >= 9) return 'loved'
  if (v && v.value >= 8) return 'liked'
  return 'watched'
}

/** At most this many pair shelves in a list, so single genres still anchor it. */
const MAX_PAIR_SHELVES = 2
/** How many shelves one concept may appear on. */
const MAX_CONCEPT_USES = 2

/**
 * Genre shelves, best first.
 *
 * Singles and pairs compete on one scale. The cap on uses per concept is what
 * keeps a profile from producing "Action & Adventure", "Action & Adventure ·
 * Comedy" and "Action & Adventure · Sci-Fi & Fantasy" — each individually
 * right, together a page about one thing. `allowed` drops concepts a lane
 * cannot show: Animation within anime says nothing, and a series-only genre
 * has no films.
 */
export function genreShelves(
  singles: readonly ConceptAffinity[],
  pairs: readonly ConceptAffinity[],
  limit: number,
  allowed: (concept: number) => boolean = () => true,
): ConceptAffinity[] {
  const candidates = [...singles, ...pairs]
    .filter((c) => c.score > 0 && c.concepts.every(allowed))
    .sort((a, b) => b.score - a.score || a.concepts.join().localeCompare(b.concepts.join()))

  const uses = new Map<number, number>()
  const chosen: ConceptAffinity[] = []
  let pairCount = 0

  for (const c of candidates) {
    if (chosen.length >= limit) break
    if (c.concepts.length > 1 && pairCount >= MAX_PAIR_SHELVES) continue
    if (c.concepts.some((x) => (uses.get(x) ?? 0) >= MAX_CONCEPT_USES)) continue
    chosen.push(c)
    if (c.concepts.length > 1) pairCount += 1
    for (const x of c.concepts) uses.set(x, (uses.get(x) ?? 0) + 1)
  }
  return chosen
}

/**
 * Favourites that seed a shelf: the strongest titles carrying every one of its
 * genres, chosen with the same diversity rule as Top picks.
 */
export const SHELF_SEEDS = 4

export function shelfSeeds(
  titles: readonly TitleAffinity[],
  concepts: readonly number[],
  limit = SHELF_SEEDS,
): TitleAffinity[] {
  const carries = (t: TitleAffinity): boolean => {
    const own = conceptsOf(t.genreIds)
    return concepts.every((c) => own.includes(c))
  }
  return topPickSeeds(titles.filter(carries), limit)
}
