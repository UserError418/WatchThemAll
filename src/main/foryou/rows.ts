/**
 * What goes in each row: fetching candidates and ranking them against the
 * profile.
 *
 * Every candidate in every row is re-scored rather than shown in TMDB's order.
 * TMDB knows what is *similar*; only the profile knows what this user thinks of
 * the ways in which it is similar. A lane row is scored by its lane's taste
 * (`profile.ts`) and shows its lane only (`lanes.ts`).
 */

import type { MediaSummary, MediaType } from '@shared/types'
import type { ForYouRow, ForYouSeed, Paged } from '@shared/ipc'
import type { DiscoverQuery } from '../tmdb'
import { conceptsOf, genreFit, genresFor, titleId, type TitleAffinity } from '../taste'
import type { ForYouDeps } from './deps'
import { inLane, laneCatalogues, laneOf, laneQuery, LANES, type Lane } from './lanes'
import type { Profile } from './profile'
import { antiSeeds, shelfSeeds, topPickSeeds } from './seeds'

/* ── Scoring ─────────────────────────────────────────────────────────────── */

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
 * How much weight a recommendation carries by its position in a list.
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

type Tally = Map<string, { item: MediaSummary; total: number }>

/** Accumulate each candidate's recommendation weight across several lists. */
function tally(
  lists: ReadonlyArray<{ weight: number; items: readonly MediaSummary[] }>,
  owned: ReadonlySet<string>,
): Tally {
  const out: Tally = new Map()
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
 * Candidates recommended by disliked titles, for the penalty term.
 *
 * Always page 1: it is a reference list consulted by every row, and the TMDB
 * client caches it, so after the first row it costs nothing.
 */
async function penaltyTally(profile: Profile, deps: ForYouDeps): Promise<Tally> {
  const anti = antiSeeds(profile.titles)
  const pages = await Promise.all(anti.map((a) => deps.recommendations(a.tmdbId, a.type, 1)))
  return tally(
    pages.map((p, i) => ({ weight: Math.abs(anti[i]!.score), items: p.items })),
    profile.owned,
  )
}

function rank(candidates: Tally, penalties: Tally, fit: ReadonlyMap<number, number>): Scored[] {
  const norm = Math.max(1e-9, ...[...candidates.values()].map((c) => c.total))
  const scored: Scored[] = []
  for (const [id, { item, total }] of candidates) {
    const itemFit = genreFit(item.genreIds, fit)
    const penalty = penalties.get(id)?.total ?? 0
    // Pointed at more strongly by what the user dislikes than by what they
    // like: this is not a close call, it is a wrong answer. Drop it.
    if (penalty >= total) continue
    const score =
      total / norm - (SCORING.penalty * penalty) / norm + SCORING.fit * itemFit + qualityTerm(item)
    scored.push({ item, score, fit: itemFit })
  }
  return scored.sort((a, b) => b.score - a.score || a.item.tmdbId - b.item.tmdbId)
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

/**
 * Merge two lists so roughly `share` of the result comes from the second.
 *
 * Plain alternation gives a 50/50 row regardless of taste; this keeps the
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
 * Take one from each list in turn, until all are spent.
 *
 * How the mixed rows stay balanced: whatever each lane has, the row alternates
 * between them card by card, so no lane can fill the first screen of it.
 */
export function roundRobin<T>(lists: ReadonlyArray<readonly T[]>): T[] {
  const out: T[] = []
  for (let i = 0; lists.some((l) => i < l.length); i += 1) {
    for (const list of lists) if (i < list.length) out.push(list[i]!)
  }
  return out
}

/* ── Genres in TMDB's query syntax ───────────────────────────────────────── */

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

/** Any of several concepts, in one catalogue: what a lane's broad rows ask for. */
function anyOf(concepts: readonly number[], type: MediaType): string {
  return [...new Set(concepts.flatMap((c) => genresFor(c, type) ?? []))].join('|')
}

/** The genres to exclude in one catalogue: what the user avoids. */
function withoutGenres(concepts: readonly number[], profile: Profile, type: MediaType): string {
  const ids = profile.avoided
    .filter((c) => !concepts.includes(c))
    .flatMap((c) => genresFor(c, type) ?? [])
  // `|` rather than `,`: exclude anything carrying *any* of these, not only
  // titles carrying all of them at once.
  return [...new Set(ids)].join('|')
}

/**
 * The genres a lane likes best, for the rows that are about the lane as a
 * whole. Animation is left out of anime (it is the lane), and a genre the
 * lane's catalogues cannot show is left out of the others.
 */
export const LANE_TOP_CONCEPTS = 3

export function laneTopConcepts(profile: Profile, lane: Lane, limit = LANE_TOP_CONCEPTS): number[] {
  return profile.lanes[lane].singles
    .filter((s) => s.score > 0 && conceptAllowed(lane)(s.concepts[0]!))
    .sort((a, b) => b.score - a.score || a.concepts[0]! - b.concepts[0]!)
    .slice(0, limit)
    .map((s) => s.concepts[0]!)
}

/** Whether a genre concept can head a row in a lane. */
export function conceptAllowed(lane: Lane): (concept: number) => boolean {
  if (lane === 'anime') return (c) => c !== 16
  const type: MediaType = lane === 'films' ? 'movie' : 'tv'
  return (c) => genresFor(c, type) !== null
}

/* ── Building rows ───────────────────────────────────────────────────────── */

/** How far each kind of row pages before it stops. */
const MAX_PAGES = { topPicks: 2, because: 3, genre: 6, theme: 4, mixed: 3, watchlist: 2 } as const

export const EMPTY = (page: number): Paged<MediaSummary> => ({ items: [], page, totalPages: 0 })

/**
 * How many cards one page of Top picks shows.
 *
 * Six favourites' recommendations pool to a hundred candidates, and the first
 * version showed them all. Every title belongs to the first row that shows it,
 * so a hundred-card Top picks left the rows below it with a handful each —
 * measured: six cards under "Because you liked Hell's Paradise". Thirty is a
 * screen and a half of the strongest; the rest are the other rows' to show,
 * with their reason attached.
 */
export const TOP_PICKS_PER_PAGE = 30

/**
 * Fewer recommended candidates than this on a page, and a row is topped up
 * from `/discover` in the lane's favourite genres. What a thin lane gets — a
 * user with two rated films still sees a full movie row.
 */
const ENOUGH = 12

/** Seeded pages per genre shelf; past this the shelf is TMDB's chart alone. */
const SEEDED_PAGES = 3

export async function buildRow(
  row: ForYouRow,
  page: number,
  profile: Profile,
  deps: ForYouDeps,
  now = Date.now(),
): Promise<Paged<MediaSummary>> {
  switch (row.kind) {
    case 'topPicks':
      return topPicks(row.lane, row.seeds, page, profile, deps)
    case 'because':
      return because(row.lane, row.seed, page, profile, deps)
    case 'genre':
      return genreShelf(row.lane, row.concepts, page, profile, deps)
    case 'theme':
      return themeRow(row.lane, row.keyword, page, profile, deps)
    case 'mixed':
      return mixedRow(row.flavour, page, profile, deps, now)
    case 'watchlist':
      return watchlistRow(row.seeds, page, profile, deps)
  }
}

/** The planned seeds, weighted by what the profile says of them *now*. */
function currentSeeds(planned: readonly ForYouSeed[], profile: Profile): TitleAffinity[] {
  const byId = new Map(profile.titles.map((t) => [titleId(t.type, t.tmdbId), t]))
  return planned
    .map((s) => byId.get(titleId(s.type, s.tmdbId)))
    .filter((t): t is TitleAffinity => !!t && t.score > 0)
}

/** Remove what an earlier list already holds, and repeats within the list. */
function after(taken: readonly MediaSummary[], more: readonly MediaSummary[]): MediaSummary[] {
  const seen = new Set(taken.map((m) => titleId(m.type, m.tmdbId)))
  return more.filter((m) => {
    const id = titleId(m.type, m.tmdbId)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/**
 * Top picks for one lane: its favourites' recommendations, pooled.
 *
 * A candidate several favourites agree on beats one only a single favourite
 * mentions, and candidates the user's *least* liked titles point at are pushed
 * down. A lane with few favourites of its own is topped up from its favourite
 * genres, and one with none is made of them.
 */
async function topPicks(
  lane: Lane,
  planned: readonly ForYouSeed[],
  page: number,
  profile: Profile,
  deps: ForYouDeps,
): Promise<Paged<MediaSummary>> {
  if (page > MAX_PAGES.topPicks) return EMPTY(page)
  const seeds = currentSeeds(planned, profile)

  const [pages, penalties] = await Promise.all([
    Promise.all(seeds.map((s) => deps.recommendations(s.tmdbId, s.type, page))),
    penaltyTally(profile, deps),
  ])
  const candidates = tally(
    pages.map((p, i) => ({ weight: seeds[i]!.score, items: p.items.filter(inLane(lane)) })),
    profile.owned,
  )
  const ranked = withExploration(rank(candidates, penalties, profile.lanes[lane].fit))
  const more = pages.some((p) => p.totalPages > page)

  if (ranked.length >= ENOUGH) {
    return {
      items: ranked.slice(0, TOP_PICKS_PER_PAGE),
      page,
      totalPages: more ? Math.min(MAX_PAGES.topPicks, page + 1) : page,
    }
  }

  const concepts = laneTopConcepts(profile, lane)
  const chart = await laneChart(lane, page, profile, deps, (type) => {
    // Anime is asked for whole and ranked by the lane's taste: AND-ing one
    // genre onto Animation would make it a genre shelf.
    const genres = lane === 'anime' ? '' : anyOf(concepts, type)
    if (!genres && lane !== 'anime') return null
    return withAvoided(laneQuery(lane, genres), concepts, profile, type)
  })
  return {
    items: [...ranked, ...after(ranked, chart.items)].slice(0, TOP_PICKS_PER_PAGE),
    page,
    totalPages: more || chart.totalPages > page ? Math.min(MAX_PAGES.topPicks, page + 1) : page,
  }
}

/** One favourite's recommendations, in its lane: the most checkable claim a row can make. */
async function because(
  lane: Lane,
  seed: ForYouSeed,
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
  const candidates = tally([{ weight: 1, items: res.items.filter(inLane(lane)) }], profile.owned)
  return {
    items: rank(candidates, penalties, profile.lanes[lane].fit).map((r) => r.item),
    page,
    totalPages: Math.min(res.totalPages, MAX_PAGES.because),
  }
}

/**
 * A genre shelf in one lane: the user's own favourites in that genre and lane,
 * then the chart.
 *
 * A genre id alone cannot tell a user's kind of "Animation" from TMDB's — the
 * first version, charts only, filled an anime fan's Animation shelf with Toy
 * Story and Pokémon. The recommendations of the user's own favourites
 * in the genre can, because they inherit everything about those titles a genre
 * does not capture. So a shelf pools its seeds' recommendations, keeps only
 * candidates that carry every genre of the shelf and belong to its lane (the
 * heading has to stay true), and only tops up from the chart when that runs
 * thin.
 */
async function genreShelf(
  lane: Lane,
  concepts: readonly number[],
  page: number,
  profile: Profile,
  deps: ForYouDeps,
): Promise<Paged<MediaSummary>> {
  if (page > MAX_PAGES.genre) return EMPTY(page)

  const seeds = page <= SEEDED_PAGES ? shelfSeeds(profile.lanes[lane].titles, concepts) : []
  const [seeded, penalties] = await Promise.all([
    Promise.all(seeds.map((s) => deps.recommendations(s.tmdbId, s.type, page))),
    penaltyTally(profile, deps),
  ])

  const inShelf = (m: MediaSummary): boolean => {
    const own = conceptsOf(m.genreIds)
    return concepts.every((c) => own.includes(c)) && laneOf(m) === lane
  }
  const candidates = tally(
    seeded.map((p, i) => ({ weight: seeds[i]!.score, items: p.items.filter(inShelf) })),
    profile.owned,
  )
  const ranked = rank(candidates, penalties, profile.lanes[lane].fit).map((r) => r.item)
  const seededMore = page < SEEDED_PAGES && seeded.some((p) => p.totalPages > page)

  if (ranked.length >= ENOUGH) {
    return { items: ranked, page, totalPages: Math.min(MAX_PAGES.genre, page + 1) }
  }

  const chart = await laneChart(lane, page, profile, deps, (type) => {
    const genres = shelfGenres(concepts, type)
    return genres === null ? null : withAvoided(laneQuery(lane, genres), concepts, profile, type)
  })
  const more = seededMore || chart.totalPages > page
  return {
    items: [...ranked, ...after(ranked, chart.items)],
    page,
    totalPages: more ? Math.min(MAX_PAGES.genre, page + 1) : page,
  }
}

/**
 * The vote floor for a themed row. Lower than a shelf's: a keyword is already
 * a narrow filter, and a floor of 80 empties most of them.
 */
const THEME_MIN_VOTES = 20

/** A micro-genre: TMDB's titles carrying one keyword, in one lane. */
export async function themeRow(
  lane: Lane,
  keyword: number,
  page: number,
  profile: Profile,
  deps: ForYouDeps,
): Promise<Paged<MediaSummary>> {
  if (page > MAX_PAGES.theme) return EMPTY(page)
  return laneChart(lane, page, profile, deps, (type) =>
    withAvoided(laneQuery(lane, '', { withKeywords: String(keyword), minVotes: THEME_MIN_VOTES }), [], profile, type),
  )
}

/**
 * The three discovery flavours, each as a test on a title and as the same
 * test put to `/discover`.
 *
 * - **new**: first released in the last year.
 * - **gems**: rated highly by few. The vote ceiling is the point: below it, a
 *   title is one the user has probably not been told about already.
 * - **acclaimed**: rated highly by many.
 *
 * Vote counts differ by an order of magnitude between catalogues, so the
 * thresholds come in two scales. Films outside anime collect the most votes;
 * series and anime of either type, far fewer.
 */
type VoteScale = 'high' | 'low'

interface Flavour {
  minVotes: Record<VoteScale, number>
  maxVotes?: Record<VoteScale, number>
  minRating?: number
  /** How recent, in days, when recency is the point. */
  withinDays?: number
  sortBy: DiscoverQuery['sortBy']
}

const FLAVOURS: Record<'new' | 'gems' | 'acclaimed', Flavour> = {
  new: { minVotes: { high: 10, low: 10 }, withinDays: 365, sortBy: 'popularity.desc' },
  gems: {
    minVotes: { high: 50, low: 20 },
    maxVotes: { high: 700, low: 250 },
    minRating: 7.4,
    sortBy: 'vote_average.desc',
  },
  acclaimed: { minVotes: { high: 2500, low: 400 }, minRating: 7.8, sortBy: 'vote_average.desc' },
}

const DAY_MS = 86_400_000

function voteScale(lane: Lane, type: MediaType): VoteScale {
  return type === 'movie' && lane !== 'anime' ? 'high' : 'low'
}

function flavourQuery(f: Flavour, scale: VoteScale, now: number): DiscoverQuery {
  return {
    minVotes: f.minVotes[scale],
    ...(f.maxVotes ? { maxVotes: f.maxVotes[scale] } : {}),
    ...(f.minRating !== undefined ? { minRating: f.minRating } : {}),
    ...(f.withinDays ? { releasedAfter: new Date(now - f.withinDays * DAY_MS).toISOString().slice(0, 10) } : {}),
    sortBy: f.sortBy,
  }
}

function flavourAccepts(f: Flavour, lane: Lane, m: MediaSummary, now: number): boolean {
  const scale = voteScale(lane, m.type)
  const votes = m.voteCount ?? 0
  if (votes < f.minVotes[scale]) return false
  if (f.maxVotes && votes > f.maxVotes[scale]) return false
  if (f.minRating !== undefined && m.rating < f.minRating) return false
  if (f.withinDays) {
    const released = m.releaseDate ? Date.parse(m.releaseDate) : NaN
    if (!(released >= now - f.withinDays * DAY_MS)) return false
  }
  return true
}

/**
 * The lanes a mixed row draws from: those the user has a taste in.
 *
 * Anime only for someone who likes some. Series and films whenever there is a
 * genre to ask for, their own or borrowed — which is how a user who has rated
 * no films still finds some in "New for you".
 */
export function mixedLanes(profile: Profile): Lane[] {
  return LANES.filter((lane) =>
    lane === 'anime' ? profile.lanes.anime.share > 0 : laneTopConcepts(profile, lane).length > 0,
  )
}

/** How many cards a page of a row that mixes several sources shows. */
export const MIXED_PER_PAGE = 30

/** How many of a lane's favourites a discovery row asks for recommendations. */
const DISCOVERY_SEEDS = 8

/**
 * A discovery row across the lanes, taking them in turn card by card. Which
 * lane leads rotates with the page.
 *
 * Each lane's part comes first from its favourites' recommendations that pass
 * the flavour: a hidden gem the user's own favourites point at, not just any
 * obscure title in a genre they like. The first version asked `/discover`
 * alone, in each lane's top genres. On a real library those were Drama and
 * Comedy, and "New for you" opened with whatever romance was popular that
 * week. The chart now only tops up a lane whose favourites turned up too
 * little.
 */
async function mixedRow(
  flavour: 'new' | 'gems' | 'acclaimed',
  page: number,
  profile: Profile,
  deps: ForYouDeps,
  now: number,
): Promise<Paged<MediaSummary>> {
  if (page > MAX_PAGES.mixed) return EMPTY(page)
  const f = FLAVOURS[flavour]
  const lanes = mixedLanes(profile)
  const penalties = await penaltyTally(profile, deps)

  const perLane = await Promise.all(
    lanes.map(async (lane) => {
      const seeds = topPickSeeds(profile.lanes[lane].titles, DISCOVERY_SEEDS)
      const pages = await Promise.all(seeds.map((s) => deps.recommendations(s.tmdbId, s.type, page)))
      const passes = (m: MediaSummary): boolean => laneOf(m) === lane && flavourAccepts(f, lane, m, now)
      const ranked = rank(
        tally(pages.map((p, i) => ({ weight: seeds[i]!.score, items: p.items.filter(passes) })), profile.owned),
        penalties,
        profile.lanes[lane].fit,
      ).map((r) => r.item)
      if (ranked.length >= ENOUGH) return { items: ranked, more: pages.some((p) => p.totalPages > page) }

      const concepts = laneTopConcepts(profile, lane)
      const chart = await laneChart(lane, page, profile, deps, (type) => {
        // Anime is asked for as a whole — Animation in Japanese is already
        // narrow — and ranked by the lane's taste afterwards.
        const genres = lane === 'anime' ? '' : anyOf(concepts, type)
        if (!genres && lane !== 'anime') return null
        return withAvoided(laneQuery(lane, genres, flavourQuery(f, voteScale(lane, type), now)), concepts, profile, type)
      })
      return { items: [...ranked, ...after(ranked, chart.items)], more: chart.totalPages > page }
    }),
  )

  const shift = (page - 1) % Math.max(1, lanes.length)
  const ordered = [...perLane.slice(shift), ...perLane.slice(0, shift)]
  return {
    items: after([], roundRobin(ordered.map((l) => l.items))).slice(0, MIXED_PER_PAGE),
    page,
    totalPages: perLane.some((l) => l.more) ? Math.min(MAX_PAGES.mixed, page + 1) : page,
  }
}

/**
 * More like the watchlist: what the user plans to watch says what they want
 * now, which their history cannot. Pooled like Top picks, then taken lane by
 * lane in turn, so a watchlist of anime does not make it an anime row.
 */
async function watchlistRow(
  planned: readonly ForYouSeed[],
  page: number,
  profile: Profile,
  deps: ForYouDeps,
): Promise<Paged<MediaSummary>> {
  if (page > MAX_PAGES.watchlist) return EMPTY(page)
  const [pages, penalties] = await Promise.all([
    Promise.all(planned.map((s) => deps.recommendations(s.tmdbId, s.type, page))),
    penaltyTally(profile, deps),
  ])
  const ranked = rank(
    tally(pages.map((p) => ({ weight: 1, items: p.items })), profile.owned),
    penalties,
    profile.fit,
  ).map((r) => r.item)
  const byLane = LANES.map((lane) => ranked.filter(inLane(lane)))
  const more = pages.some((p) => p.totalPages > page)
  return {
    items: roundRobin(byLane).slice(0, MIXED_PER_PAGE),
    page,
    totalPages: more ? Math.min(MAX_PAGES.watchlist, page + 1) : page,
  }
}

/** Add the user's avoided genres to a query, except the ones the row is about. */
function withAvoided(
  query: DiscoverQuery,
  concepts: readonly number[],
  profile: Profile,
  type: MediaType,
): DiscoverQuery {
  const without = withoutGenres(concepts, profile, type)
  return without ? { ...query, withoutGenres: without } : query
}

/**
 * One page of `/discover` held to a lane: every catalogue the lane spans,
 * blended in the lane's own proportion, filtered to the lane, the user's own
 * titles removed, and reordered by the lane's taste.
 *
 * `ask` builds the query for one catalogue, or returns null when that
 * catalogue cannot answer the row. Discover's own order is kept as the
 * backbone — it is what makes a chart feel current — and the profile reorders
 * within the page.
 */
async function laneChart(
  lane: Lane,
  page: number,
  profile: Profile,
  deps: ForYouDeps,
  ask: (type: MediaType) => DiscoverQuery | null,
): Promise<Paged<MediaSummary>> {
  const types = laneCatalogues(lane)
  const pages = await Promise.all(
    types.map((type) => {
      const query = ask(type)
      return query ? deps.discover(type, query, page) : Promise.resolve(EMPTY(page))
    }),
  )
  const fresh = (items: readonly MediaSummary[]): MediaSummary[] =>
    after([], items.filter(inLane(lane)).filter((m) => !profile.owned.has(titleId(m.type, m.tmdbId))))

  const merged =
    pages.length === 1
      ? fresh(pages[0]!.items)
      : blend(fresh(pages[0]!.items), fresh(pages[1]!.items), profile.lanes[lane].filmShare)
  const fit = profile.lanes[lane].fit
  const items = merged
    .map((item, index) => ({
      item,
      score: positionWeight(index, merged.length) + SCORING.fit * genreFit(item.genreIds, fit) + qualityTerm(item),
    }))
    .sort((a, b) => b.score - a.score || a.item.tmdbId - b.item.tmdbId)
    .map((r) => r.item)

  return { items, page, totalPages: Math.max(0, ...pages.map((p) => p.totalPages)) }
}
