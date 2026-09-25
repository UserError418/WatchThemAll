/**
 * The personalised half of Browse: which rows to show, and what goes in them.
 *
 * Built once for both platforms — the desktop's IPC handler and the phone's
 * bridge both call this with their own network. Two copies of a ranking
 * heuristic drift, and nobody notices which one they are looking at. The
 * network is injected rather than imported for the same reason and one more:
 * it makes every decision here testable without one.
 *
 * ## The rows, top to bottom
 *
 * 1. **Top picks for you.** TMDB's `/recommendations` for the user's strongest
 *    titles, pooled. A candidate several favourites agree on beats one only a
 *    single favourite mentions, and candidates that the user's *least* liked
 *    titles also point at are pushed down.
 * 2. **Because you loved / liked / watched ‹Title›**, three of them. Each is
 *    one favourite's recommendations on its own, named — the most checkable
 *    claim a recommendation can make. Which three rotates per session among
 *    the user's top titles, weighted towards what they watched recently, so
 *    the page is not the same on every launch.
 * 3. **Genre shelves**, chosen and ordered by the genre profile — including
 *    pairs ("Animation · Sci-Fi & Fantasy"), which is where the granularity is.
 *    Each shelf is filled from the recommendations of the user's own favourites
 *    *in that genre*, and only topped up from TMDB's genre charts when that runs
 *    thin. See `genreShelf` for why the charts alone are not good enough.
 *
 * Every candidate in every row is re-scored against the profile rather than
 * shown in TMDB's order. TMDB knows what is *similar*; only the profile knows
 * what this user thinks of the ways in which it is similar.
 */

import type { MediaSummary, MediaType } from '@shared/types'
import type { ForYouPlan, ForYouRow, ForYouRowRequest, Paged } from '@shared/ipc'
import {
  avoidedConcepts,
  conceptAffinity,
  conceptsOf,
  genreFit,
  genresFor,
  investment,
  normalisedGenreFit,
  ownedTitles,
  titleAffinity,
  titleId,
  titleNames,
  type ConceptAffinity,
  type TasteStore,
  type TitleAffinity,
} from './taste'

export interface ForYouDeps {
  recommendations: (tmdbId: number, type: MediaType, page: number) => Promise<Paged<MediaSummary>>
  /**
   * `/discover` for one catalogue. `withGenres` and `withoutGenres` are in
   * TMDB's own syntax — `,` for AND, `|` for OR — because a shelf needs both.
   */
  discover: (
    type: MediaType,
    withGenres: string,
    withoutGenres: string,
    page: number,
  ) => Promise<Paged<MediaSummary>>
}

/* ── The profile, computed once per request ──────────────────────────────── */

export interface Profile {
  titles: TitleAffinity[]
  /** Concept → affinity scaled to ±1. */
  fit: Map<number, number>
  singles: ConceptAffinity[]
  pairs: ConceptAffinity[]
  avoided: number[]
  owned: Set<string>
  names: Map<string, string>
  /** The share of positive affinity held by films, clamped — see `FILM_SHARE`. */
  filmShare: number
}

/**
 * The least and most of a genre shelf that is films.
 *
 * Proportional to how the user's taste splits between films and series, so a
 * library that is nine-tenths anime series gets shelves that are mostly series.
 * Clamped rather than exact: at zero, someone who has never rated a film would
 * never be shown one, and the shelves would confirm the profile forever instead
 * of testing it.
 */
const FILM_SHARE = { min: 0.2, max: 0.8 } as const

export function buildProfile(store: TasteStore, now = Date.now()): Profile {
  const titles = titleAffinity(store, now)
  const { singles, pairs } = conceptAffinity(titles)

  let films = 0
  let total = 0
  for (const t of titles) {
    if (t.score <= 0) continue
    total += t.score
    if (t.type === 'movie') films += t.score
  }
  const raw = total > 0 ? films / total : 0.5

  return {
    titles,
    fit: normalisedGenreFit(singles),
    singles,
    pairs,
    avoided: avoidedConcepts(singles),
    owned: ownedTitles(store),
    names: titleNames(store),
    filmShare: Math.min(FILM_SHARE.max, Math.max(FILM_SHARE.min, raw)),
  }
}

/* ── Choosing seeds ──────────────────────────────────────────────────────── */

/** How many favourites Top picks pools, and how many dislikes it consults. */
export const TOP_PICK_SEEDS = 6
export const ANTI_SEEDS = 2
/** Below this a title is not disliked enough to argue against anything. */
const ANTI_SEED_THRESHOLD = -0.8

/** How many "Because you…" rows, chosen from how many candidates. */
export const BECAUSE_ROWS = 3
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
 * The favourites Top picks is built from.
 *
 * The strongest titles, but not blindly: six seasons of near-identical shows
 * would make a row that is one taste six times. Each pick is discounted by how
 * much it overlaps the ones already chosen (maximal marginal relevance, in the
 * literature), so a runner-up from a different corner of the library can win a
 * place over a stronger title that adds nothing new.
 */
/**
 * How much a seed identical in genre to one already chosen is discounted.
 *
 * At a half, a redundant favourite needs about twice the strength of a novel
 * one to win the slot — so a second 10 from the same corner of the library
 * loses to a 9 from a different one, which is the trade the row wants: six
 * seeds are few, and each should widen the pool.
 */
const SEED_OVERLAP_DISCOUNT = 0.5

export function topPickSeeds(profile: Profile, limit = TOP_PICK_SEEDS): TitleAffinity[] {
  const pool = profile.titles.filter((t) => t.score > 0)
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
export function antiSeeds(profile: Profile, limit = ANTI_SEEDS): TitleAffinity[] {
  return profile.titles
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
function prng(seed: number): () => number {
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
 * The titles this session's "Because you…" rows are about.
 *
 * Only titles the user demonstrably watched or rated — "Because you watched"
 * about something merely saved would be false — and only ones with a name to
 * put in the heading. From the strongest dozen, three are drawn at random in
 * proportion to strength and recency, with a draw skipped when it would
 * duplicate an already-chosen seed's genres. Random so the page changes;
 * weighted so it changes between good answers; seeded so it does not change
 * while the user is looking at it.
 */
export function becauseSeeds(
  profile: Profile,
  seed: number,
  now = Date.now(),
  limit = BECAUSE_ROWS,
): TitleAffinity[] {
  return becauseCandidates(profile, seed, now).slice(0, limit)
}

/**
 * Every eligible "Because you…" seed, in the order this session would use them.
 *
 * `becauseSeeds` takes the head of this; `forYouPlan` walks further down it
 * when a head seed turns out to have nothing TMDB can recommend.
 */
export function becauseCandidates(profile: Profile, seed: number, now = Date.now()): TitleAffinity[] {
  const pool = profile.titles
    .filter((t) => t.score > 0)
    .filter((t) => t.verdict !== null || investment(t.engagement) > 0)
    .filter((t) => profile.names.has(titleId(t.type, t.tmdbId)))
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

/* ── Choosing genre shelves ──────────────────────────────────────────────── */

export const GENRE_SHELVES = 4
/** At most this many pair shelves, so single genres still anchor the page. */
const MAX_PAIR_SHELVES = 2
/** How many shelves one concept may appear on. */
const MAX_CONCEPT_USES = 2

/**
 * The genre shelves, best first.
 *
 * Singles and pairs compete on one scale. The cap on uses per concept is what
 * keeps an anime-heavy profile from producing "Animation", "Animation · Action
 * & Adventure", "Animation · Comedy" and "Animation · Sci-Fi & Fantasy" — each
 * individually right, together a page about one thing.
 */
export function genreShelves(profile: Profile, limit = GENRE_SHELVES): ConceptAffinity[] {
  const candidates = [...profile.singles, ...profile.pairs]
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.concepts.join().localeCompare(b.concepts.join()))

  const uses = new Map<number, number>()
  const chosen: ConceptAffinity[] = []
  let pairs = 0

  for (const c of candidates) {
    if (chosen.length >= limit) break
    if (c.concepts.length > 1 && pairs >= MAX_PAIR_SHELVES) continue
    if (c.concepts.some((x) => (uses.get(x) ?? 0) >= MAX_CONCEPT_USES)) continue
    chosen.push(c)
    if (c.concepts.length > 1) pairs += 1
    for (const x of c.concepts) uses.set(x, (uses.get(x) ?? 0) + 1)
  }
  return chosen
}

/* ── The plan ─────────────────────────────────────────────────────────────── */

/** What a "Because you…" heading says, from the verdict behind it. */
export function becauseVerb(t: TitleAffinity): 'loved' | 'liked' | 'watched' {
  const v = t.verdict
  // "Loved" only for a 9 or 10 actually chosen on the scale. A converted
  // thumb is an 8 by construction and cannot claim more than "liked".
  if (v && !v.coarse && v.value >= 9) return 'loved'
  if (v && v.value >= 8) return 'liked'
  return 'watched'
}

/**
 * The personalised rows, in display order.
 *
 * `genreName` names a concept, or returns undefined when it cannot — a shelf
 * with no name is dropped rather than headed with a number.
 */
export function planRows(
  profile: Profile,
  seed: number,
  genreName: (concept: number) => string | undefined,
  now = Date.now(),
  because: readonly TitleAffinity[] = becauseSeeds(profile, seed, now),
): ForYouRow[] {
  const rows: ForYouRow[] = []

  if (topPickSeeds(profile).length > 0) {
    rows.push({ kind: 'topPicks', key: 'for-you:top', title: 'Top picks for you' })
  }

  for (const t of because) {
    const name = profile.names.get(titleId(t.type, t.tmdbId))
    if (!name) continue
    rows.push({
      kind: 'because',
      key: `for-you:because:${t.type}:${t.tmdbId}`,
      title: `Because you ${becauseVerb(t)} ${name}`,
      seed: { tmdbId: t.tmdbId, type: t.type },
    })
  }

  for (const shelf of genreShelves(profile)) {
    const names = shelf.concepts.map(genreName)
    if (names.some((n) => !n)) continue
    rows.push({
      kind: 'genre',
      key: `for-you:genre:${shelf.concepts.join('+')}`,
      title: names.join(' · '),
      concepts: shelf.concepts,
    })
  }

  return rows
}

/**
 * Whether something the renderer handed back is a row main could have planned.
 *
 * The row round-trips through the renderer, so it is input like any other.
 * What it can make main fetch is already narrow — ids and genre numbers, never
 * a URL — but a malformed one should be refused here rather than turned into a
 * TMDB request that 404s.
 */
export function isForYouRow(value: unknown): value is ForYouRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  if (typeof row.key !== 'string' || typeof row.title !== 'string') return false
  const positiveInt = (x: unknown): boolean => Number.isInteger(x) && (x as number) > 0

  switch (row.kind) {
    case 'topPicks':
      return true
    case 'because': {
      const seed = row.seed as Record<string, unknown> | undefined
      return !!seed && positiveInt(seed.tmdbId) && (seed.type === 'tv' || seed.type === 'movie')
    }
    case 'genre':
      return (
        Array.isArray(row.concepts) &&
        row.concepts.length >= 1 &&
        row.concepts.length <= 2 &&
        row.concepts.every(positiveInt)
      )
    default:
      return false
  }
}

/* ── Scoring candidates ──────────────────────────────────────────────────── */

/**
 * How the terms of a candidate's score are weighed against each other.
 *
 * `support` — how strongly the user's favourites recommend it — is normalised
 * to 0..1 per row and is the backbone. The rest adjust it:
 *
 * - `fit`: genre fit, −1..1. Enough to reorder close calls, not enough to let a
 *   perfect genre match that no favourite recommends outrank one they all do.
 * - `penalty`: how strongly disliked titles recommend it, on the same scale as
 *   support. Weighted fully — "people who watch the thing you hated also watch
 *   this" is as informative as the positive case.
 * - `quality`: TMDB's score, shrunk towards the catalogue's typical 6.8 by its
 *   vote count, so a 9.1 from 40 votes is not taken at its word. Small: it
 *   breaks ties between equally personal candidates, and nothing more.
 */
export const SCORING = {
  fit: 0.35,
  penalty: 1,
  qualityPerPoint: 0.12,
  qualityPrior: 6.8,
  qualityPriorVotes: 150,
} as const

/** TMDB's score as a small adjustment, shrunk towards the catalogue's mean. */
export function qualityTerm(media: MediaSummary): number {
  const votes = media.voteCount ?? 0
  const { qualityPrior: prior, qualityPriorVotes: k } = SCORING
  const shrunk = (media.rating * votes + prior * k) / (votes + k)
  return (shrunk - prior) * SCORING.qualityPerPoint
}

/**
 * How much weight a recommendation carries by its position in a seed's list.
 *
 * TMDB orders `/recommendations` by relevance; the twentieth is still related,
 * just less so. Halving across a page keeps the order meaningful without
 * letting position alone decide.
 */
function positionWeight(index: number, perPage = 20): number {
  return 1 - (0.5 * Math.min(index, perPage)) / perPage
}

interface Scored {
  item: MediaSummary
  score: number
  fit: number
}

/** Accumulate each candidate's recommendation weight across several lists. */
function tally(
  lists: ReadonlyArray<{ weight: number; items: readonly MediaSummary[] }>,
  owned: ReadonlySet<string>,
): Map<string, { item: MediaSummary; total: number }> {
  const out = new Map<string, { item: MediaSummary; total: number }>()
  for (const { weight, items } of lists) {
    items.forEach((item, index) => {
      const id = titleId(item.type, item.tmdbId)
      if (owned.has(id)) return
      const add = weight * positionWeight(index)
      const existing = out.get(id)
      if (existing) existing.total += add
      else out.set(id, { item, total: add })
    })
  }
  return out
}

/**
 * Put one outsider in every so many slots.
 *
 * A row sorted purely by genre fit converges on the user's narrowest taste and
 * then stays there — the filter bubble, built one sort at a time. So every
 * `every`th slot goes to the best-scoring candidate whose genre fit is below
 * the row's median: still recommended by the user's own favourites, just from
 * the edge of their taste rather than its centre. It costs one card in six and
 * is the only way the profile ever learns it was wrong.
 */
export const EXPLORE_EVERY = 6

export function withExploration(ranked: readonly Scored[], every = EXPLORE_EVERY): MediaSummary[] {
  if (ranked.length < every) return ranked.map((r) => r.item)
  const fits = ranked.map((r) => r.fit).sort((x, y) => x - y)
  const median = fits[Math.floor(fits.length / 2)]!

  const used = new Set<Scored>()
  const nextWhere = (accept: (r: Scored) => boolean): Scored | undefined =>
    ranked.find((r) => !used.has(r) && accept(r))

  const out: MediaSummary[] = []
  while (out.length < ranked.length) {
    const exploring = (out.length + 1) % every === 0
    // An exploring slot with no outsider left simply takes the next best.
    const next = (exploring ? nextWhere((r) => r.fit < median) : undefined) ?? nextWhere(() => true)!
    used.add(next)
    out.push(next.item)
  }
  return out
}

/* ── Building rows ───────────────────────────────────────────────────────── */

/** How far each kind of row pages before it stops. */
const MAX_PAGES = { topPicks: 2, because: 3, genre: 6 } as const

const EMPTY = (page: number): Paged<MediaSummary> => ({ items: [], page, totalPages: 0 })

/**
 * How many cards one page of Top picks shows.
 *
 * Six favourites' recommendations pool to a hundred candidates, and the first
 * version showed them all. Every title belongs to the first row that shows it,
 * so a hundred-card Top picks left the "Because you" rows below it with a
 * handful each — measured: six cards under "Because you liked Hell's Paradise".
 * Thirty is a screen and a half of the strongest; the rest are the Because
 * rows' to show, with their reason attached.
 */
export const TOP_PICKS_PER_PAGE = 30

/**
 * Candidates recommended by disliked titles, for the penalty term.
 *
 * Always page 1: it is a reference list consulted by every row, and the TMDB
 * client caches it, so after the first row it costs nothing.
 */
async function penaltyTally(profile: Profile, deps: ForYouDeps) {
  const anti = antiSeeds(profile)
  const pages = await Promise.all(anti.map((a) => deps.recommendations(a.tmdbId, a.type, 1)))
  return tally(
    pages.map((p, i) => ({ weight: Math.abs(anti[i]!.score), items: p.items })),
    profile.owned,
  )
}

function rank(
  candidates: Map<string, { item: MediaSummary; total: number }>,
  penalties: Map<string, { total: number }>,
  profile: Profile,
): Scored[] {
  const norm = Math.max(1e-9, ...[...candidates.values()].map((c) => c.total))
  const scored: Scored[] = []
  for (const [id, { item, total }] of candidates) {
    const fit = genreFit(item.genreIds, profile.fit)
    const penalty = penalties.get(id)?.total ?? 0
    // Pointed at more strongly by what the user dislikes than by what they
    // like: this is not a close call, it is a wrong answer. Drop it.
    if (penalty >= total) continue
    const score =
      total / norm - (SCORING.penalty * penalty) / norm + SCORING.fit * fit + qualityTerm(item)
    scored.push({ item, score, fit })
  }
  return scored.sort((a, b) => b.score - a.score || a.item.tmdbId - b.item.tmdbId)
}

export async function buildRow(
  row: ForYouRow,
  page: number,
  profile: Profile,
  deps: ForYouDeps,
): Promise<Paged<MediaSummary>> {
  switch (row.kind) {
    case 'topPicks':
      return topPicks(page, profile, deps)
    case 'because':
      return because(row.seed, page, profile, deps)
    case 'genre':
      return genreShelf(row.concepts, page, profile, deps)
  }
}

async function topPicks(page: number, profile: Profile, deps: ForYouDeps): Promise<Paged<MediaSummary>> {
  if (page > MAX_PAGES.topPicks) return EMPTY(page)
  const seeds = topPickSeeds(profile)
  if (seeds.length === 0) return EMPTY(page)

  const [pages, penalties] = await Promise.all([
    Promise.all(seeds.map((s) => deps.recommendations(s.tmdbId, s.type, page))),
    penaltyTally(profile, deps),
  ])
  const candidates = tally(
    pages.map((p, i) => ({ weight: seeds[i]!.score, items: p.items })),
    profile.owned,
  )
  const more = pages.some((p) => p.totalPages > page)
  return {
    items: withExploration(rank(candidates, penalties, profile)).slice(0, TOP_PICKS_PER_PAGE),
    page,
    totalPages: more ? Math.min(MAX_PAGES.topPicks, page + 1) : page,
  }
}

async function because(
  seed: { tmdbId: number; type: MediaType },
  page: number,
  profile: Profile,
  deps: ForYouDeps,
): Promise<Paged<MediaSummary>> {
  if (page > MAX_PAGES.because) return EMPTY(page)
  const [res, penalties] = await Promise.all([
    deps.recommendations(seed.tmdbId, seed.type, page),
    penaltyTally(profile, deps),
  ])
  // One list, so support is just its position — but it goes through the same
  // ranking so fit, penalty and quality apply exactly as they do on Top picks.
  const candidates = tally([{ weight: 1, items: res.items }], profile.owned)
  return {
    items: rank(candidates, penalties, profile).map((r) => r.item),
    page,
    totalPages: Math.min(res.totalPages, MAX_PAGES.because),
  }
}

/**
 * The genre ids to send for a shelf in one catalogue, or null when that
 * catalogue cannot answer it.
 *
 * A single concept may map to several film genres ("Sci-Fi & Fantasy" is two),
 * which are OR-ed. A pair is AND-ed, and there each side contributes its first
 * film genre only: TMDB's syntax cannot express "A and (B or C)" reliably, and
 * "Animation and Action" is a truer reading of the pair than dropping the pair.
 */
export function shelfGenres(concepts: readonly number[], type: MediaType): string | null {
  const mapped = concepts.map((c) => genresFor(c, type))
  if (mapped.some((m) => m === null)) return null
  if (mapped.length === 1) return mapped[0]!.join('|')
  return mapped.map((m) => m![0]).join(',')
}

/** The genres to exclude from a shelf in one catalogue: what the user avoids. */
function withoutGenres(concepts: readonly number[], profile: Profile, type: MediaType): string {
  const ids = profile.avoided
    .filter((c) => !concepts.includes(c))
    .flatMap((c) => genresFor(c, type) ?? [])
  // `|` rather than `,`: exclude anything carrying *any* of these, not only
  // titles carrying all of them at once.
  return [...new Set(ids)].join('|')
}

/**
 * Merge two lists so roughly `share` of the result comes from the second.
 *
 * Plain alternation gives a 50/50 shelf regardless of taste; this keeps the
 * running proportion near the target instead.
 */
export function blend<T>(first: readonly T[], second: readonly T[], share: number): T[] {
  const out: T[] = []
  let i = 0
  let j = 0
  while (i < first.length || j < second.length) {
    const takeSecond =
      j < second.length && (i >= first.length || j / (out.length + 1) < share)
    if (takeSecond) out.push(second[j++]!)
    else out.push(first[i++]!)
  }
  return out
}

/**
 * Favourites that seed a shelf: the user's strongest titles carrying every one
 * of its genres, chosen with the same diversity rule as Top picks.
 */
const SHELF_SEEDS = 4
/** Seeded pages per shelf; past this the shelf is TMDB's genre chart alone. */
const SEEDED_PAGES = 3
/** Fewer seeded matches than this on a page, and the chart tops it up. */
const SHELF_ENOUGH = 12

export function shelfSeeds(profile: Profile, concepts: readonly number[], limit = SHELF_SEEDS): TitleAffinity[] {
  const carries = (t: TitleAffinity): boolean => {
    const own = conceptsOf(t.genreIds)
    return concepts.every((c) => own.includes(c))
  }
  return topPickSeeds({ ...profile, titles: profile.titles.filter(carries) }, limit)
}

/**
 * A genre shelf: the user's own favourites in that genre, then the chart.
 *
 * The first version asked TMDB's genre chart alone, re-ranked, and on a real
 * library it showed exactly the problem it was meant to solve. The user's
 * "Animation" is anime; TMDB's Animation chart is Toy Story, The Simpsons and
 * Pokémon. A genre id cannot tell those apart — but the recommendations of the
 * anime the user rated highest can, because they inherit everything about those
 * titles a genre does not capture: origin, tone, audience.
 *
 * So a shelf pools its seeds' recommendations, keeps only candidates that carry
 * every genre of the shelf (the row's heading has to stay true), and ranks them
 * like Top picks. The chart — films and series blended in the user's own
 * proportion, avoided genres excluded — only tops up a page that came back
 * thin, which is what a new user with three ratings gets.
 */
async function genreShelf(
  concepts: readonly number[],
  page: number,
  profile: Profile,
  deps: ForYouDeps,
): Promise<Paged<MediaSummary>> {
  if (page > MAX_PAGES.genre) return EMPTY(page)

  const seeds = page <= SEEDED_PAGES ? shelfSeeds(profile, concepts) : []
  const [seeded, penalties] = await Promise.all([
    Promise.all(seeds.map((s) => deps.recommendations(s.tmdbId, s.type, page))),
    penaltyTally(profile, deps),
  ])

  const inShelf = (m: MediaSummary): boolean => {
    const own = conceptsOf(m.genreIds)
    return concepts.every((c) => own.includes(c))
  }
  const candidates = tally(
    seeded.map((p, i) => ({ weight: seeds[i]!.score, items: p.items.filter(inShelf) })),
    profile.owned,
  )
  const ranked = rank(candidates, penalties, profile).map((r) => r.item)
  const seededMore = page < SEEDED_PAGES && seeded.some((p) => p.totalPages > page)

  if (ranked.length >= SHELF_ENOUGH) {
    return { items: ranked, page, totalPages: Math.min(MAX_PAGES.genre, page + 1) }
  }

  const chart = await chartPage(concepts, page, profile, deps)
  // Never the same title twice — not from the two sources, and not within the
  // chart, whose two catalogues are asked separately.
  const taken = new Set(ranked.map((m) => titleId(m.type, m.tmdbId)))
  const filler = chart.items.filter((m) => {
    const id = titleId(m.type, m.tmdbId)
    if (taken.has(id)) return false
    taken.add(id)
    return true
  })
  const more = seededMore || chart.totalPages > page

  return {
    items: [...ranked, ...filler],
    page,
    totalPages: more ? Math.min(MAX_PAGES.genre, page + 1) : page,
  }
}

/**
 * One page of TMDB's genre chart for a shelf, both catalogues blended.
 *
 * Discover returns popularity order. It is kept as the backbone — it is what
 * makes a chart feel current — and the profile reorders within the page.
 */
async function chartPage(
  concepts: readonly number[],
  page: number,
  profile: Profile,
  deps: ForYouDeps,
): Promise<Paged<MediaSummary>> {
  const ask = (type: MediaType): Promise<Paged<MediaSummary>> => {
    const genres = shelfGenres(concepts, type)
    return genres === null
      ? Promise.resolve(EMPTY(page))
      : deps.discover(type, genres, withoutGenres(concepts, profile, type), page)
  }
  const [tv, movie] = await Promise.all([ask('tv'), ask('movie')])

  const fresh = (items: readonly MediaSummary[]): MediaSummary[] =>
    items.filter((m) => !profile.owned.has(titleId(m.type, m.tmdbId)))

  const merged = blend(fresh(tv.items), fresh(movie.items), profile.filmShare)
  const items = merged
    .map((item, index) => ({
      item,
      score:
        positionWeight(index, merged.length) +
        SCORING.fit * genreFit(item.genreIds, profile.fit) +
        qualityTerm(item),
    }))
    .sort((a, b) => b.score - a.score || a.item.tmdbId - b.item.tmdbId)
    .map((r) => r.item)

  return { items, page, totalPages: Math.max(tv.totalPages, movie.totalPages) }
}

/* ── Entry points for the two platforms ─────────────────────────────────── */

/** Everything a platform supplies: the network, including genre names. */
export interface ForYouNetwork extends ForYouDeps {
  genres: (type: MediaType) => Promise<Array<{ id: number; name: string }>>
}

/**
 * A namer for genre concepts, from TMDB's two genre lists.
 *
 * The series list wins where both have a name, because concepts are series ids
 * wherever a series genre exists — "Sci-Fi & Fantasy", not "Science Fiction".
 */
export function conceptNamer(
  tv: ReadonlyArray<{ id: number; name: string }>,
  movie: ReadonlyArray<{ id: number; name: string }>,
): (concept: number) => string | undefined {
  const names = new Map<number, string>()
  for (const g of movie) names.set(g.id, g.name)
  for (const g of tv) names.set(g.id, g.name)
  return (concept) => names.get(concept)
}

/**
 * The plan for Browse. What the desktop's IPC handler and the phone's bridge
 * both call, so neither can drift from the other.
 *
 * Genre names failing to load costs the genre shelves and nothing else: Top
 * picks and the "Because you" rows are named after titles, not genres.
 */
export async function forYouPlan(
  store: TasteStore,
  seed: number,
  net: ForYouNetwork,
  now = Date.now(),
): Promise<ForYouPlan> {
  let namer: (concept: number) => string | undefined = () => undefined
  try {
    const [tv, movie] = await Promise.all([net.genres('tv'), net.genres('movie')])
    namer = conceptNamer(tv, movie)
  } catch (err) {
    console.error('[for-you] genre names unavailable, planning without shelves:', err)
  }
  const profile = buildProfile(store, now)
  const because = await viableBecauseSeeds(becauseCandidates(profile, seed, now), profile, net)
  return { rows: planRows(profile, seed, namer, now, because) }
}

/**
 * How many candidates to try for the "Because you" rows, and how many fresh
 * recommendations a seed needs to be worth a row.
 *
 * Measured on the owner's library: "Because you watched Liar Game" rendered as a
 * heading over nothing — TMDB has almost no recommendations for it. The first
 * page is fetched here for the head of the list (the row would fetch exactly
 * that page next, and the client caches it, so this costs nothing extra for
 * the seeds kept), and a seed that cannot fill a row is passed over for the
 * next one.
 */
const BECAUSE_TRIES = 6
const BECAUSE_MIN_ITEMS = 8

async function viableBecauseSeeds(
  candidates: readonly TitleAffinity[],
  profile: Profile,
  net: ForYouDeps,
): Promise<TitleAffinity[]> {
  const tried = candidates.slice(0, BECAUSE_TRIES)
  const pages = await Promise.all(tried.map((t) => net.recommendations(t.tmdbId, t.type, 1)))
  return tried
    .filter((_, i) => {
      const fresh = pages[i]!.items.filter((m) => !profile.owned.has(titleId(m.type, m.tmdbId)))
      return fresh.length >= BECAUSE_MIN_ITEMS
    })
    .slice(0, BECAUSE_ROWS)
}

/** One page of a planned row, or an empty page for a row main did not plan. */
export async function forYouRow(
  store: TasteStore,
  req: ForYouRowRequest,
  net: ForYouNetwork,
  now = Date.now(),
): Promise<Paged<MediaSummary>> {
  const page = Number.isInteger(req.page) && req.page >= 1 ? req.page : 1
  if (!isForYouRow(req.row)) return EMPTY(page)
  return buildRow(req.row, page, buildProfile(store, now), net)
}
