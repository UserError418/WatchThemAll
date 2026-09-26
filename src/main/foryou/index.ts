/**
 * The personalised half of Browse: which rows to show, and what goes in them.
 *
 * Built once for both platforms — the desktop's IPC handler and the phone's
 * bridge both call `forYouPlan` and `forYouRow` with the same network
 * (`network.ts`). Two copies of a ranking heuristic drift, and nobody notices
 * which one they are looking at.
 *
 * - `lanes.ts` — series, films and anime, and which one a title is.
 * - `profile.ts` — the user's taste, overall and per lane.
 * - `seeds.ts` — which favourites a row recommends from.
 * - `themes.ts` — micro-genres from TMDB keywords.
 * - `plan.ts` — which rows, how many per lane, in what order.
 * - `rows.ts` — what goes in each row, and how it is ranked.
 */

import type { MediaSummary } from '@shared/types'
import type { ForYouPlan, ForYouRowRequest, Paged } from '@shared/ipc'
import { titleAffinity, titleId, type TasteStore, type TitleAffinity } from '../taste'
import type { ForYouDeps, ForYouNetwork } from './deps'
import { inLane, LANES, libraryLanes, type Lane } from './lanes'
import { planRows, isForYouRow, BECAUSE_PER_LANE, THEMES_PER_LANE } from './plan'
import { buildProfile, tasteSources, type Profile } from './profile'
import { buildRow, EMPTY, themeRow } from './rows'
import { becauseCandidates } from './seeds'
import { themeCandidates, type Theme } from './themes'

export type { ForYouDeps, ForYouNetwork } from './deps'
export type { Profile, LaneProfile } from './profile'
export type { Theme } from './themes'
export { buildProfile, MIN_LANE_TITLES, tasteSources } from './profile'
export { laneOf, libraryLanes, guessLanes, laneQuery, LANES, LANE_NOUN, type Lane } from './lanes'
export {
  becauseCandidates,
  becauseVerb,
  genreShelves,
  shelfSeeds,
  topPickSeeds,
  antiSeeds,
  TOP_PICK_SEEDS,
} from './seeds'
export { themeCandidates, themeTitle, THEME_MIN_TITLES } from './themes'
export {
  planRows,
  isForYouRow,
  laneOrder,
  extraRows,
  BODY_BASE,
  BODY_EXTRA,
  BODY_EXTRA_CAP,
  type PlanInputs,
} from './plan'
export {
  buildRow,
  blend,
  roundRobin,
  shelfGenres,
  withExploration,
  qualityTerm,
  laneTopConcepts,
  mixedLanes,
  SCORING,
  EXPLORE_EVERY,
  TOP_PICKS_PER_PAGE,
} from './rows'

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

/** The profile, with the user's animated titles placed by asking TMDB where needed. */
export async function resolveProfile(store: TasteStore, deps: ForYouDeps, now = Date.now()): Promise<Profile> {
  const lanes = await libraryLanes(titleAffinity(store, now), store, deps.originalLanguage)
  return buildProfile(store, now, lanes)
}

/**
 * The plan for Browse.
 *
 * Genre names failing to load costs the genre shelves and nothing else: every
 * other row is named after a title, a keyword or a lane.
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

  const profile = await resolveProfile(store, net, now)
  const perLane = async <T>(fn: (lane: Lane) => Promise<T[]>): Promise<Record<Lane, T[]>> =>
    Object.fromEntries(await Promise.all(LANES.map(async (l) => [l, await fn(l)]))) as Record<Lane, T[]>

  const [because, themes] = await Promise.all([
    perLane((lane) => viableBecauseSeeds(lane, profile, seed, now, net)),
    perLane((lane) => viableThemes(lane, profile, net)),
  ])
  return { rows: planRows({ profile, genreName: namer, because, themes }) }
}

/**
 * How many candidates to try per lane for the "Because you" rows, and how many
 * fresh recommendations *in that lane* a seed needs to be worth a row.
 *
 * A title TMDB knows little about — a new or obscure series — has a
 * recommendation list that is empty, or that the user has already seen most
 * of, and its row would be a heading over nothing. Lanes make this commoner:
 * Liar Game is a live-action series whose recommendations are mostly anime,
 * so as a TV-show row it may have little left. The first page is fetched here
 * for the head of the list (the row fetches exactly that page next, and the
 * client caches it, so this costs nothing extra for the seeds kept).
 */
const BECAUSE_TRIES = 5
const BECAUSE_MIN_ITEMS = 8

async function viableBecauseSeeds(
  lane: Lane,
  profile: Profile,
  seed: number,
  now: number,
  net: ForYouDeps,
): Promise<TitleAffinity[]> {
  const tried = becauseCandidates(profile.lanes[lane].titles, profile.names, seed, now).slice(0, BECAUSE_TRIES)
  const pages = await Promise.all(tried.map((t) => net.recommendations(t.tmdbId, t.type, 1)))
  return tried
    .filter((_, i) => {
      const fresh = pages[i]!.items
        .filter(inLane(lane))
        .filter((m) => !profile.owned.has(titleId(m.type, m.tmdbId)))
      return fresh.length >= BECAUSE_MIN_ITEMS
    })
    .slice(0, BECAUSE_PER_LANE)
}

/**
 * A lane's micro-genres that can fill a row. Each candidate's first page is
 * fetched here — the same request the row makes next, so the kept ones cost
 * nothing extra — and a keyword with too few titles in the lane is passed over.
 */
const THEME_TRIES = 6
const THEME_MIN_ITEMS = 8

async function viableThemes(lane: Lane, profile: Profile, net: ForYouDeps): Promise<Theme[]> {
  const sources = tasteSources(profile, lane)
  if (sources.length === 0) return []
  const candidates = (await themeCandidates(sources, net.keywords)).slice(0, THEME_TRIES)
  const firstPages = await Promise.all(candidates.map((t) => themeRow(lane, t.keyword, 1, profile, net)))
  return candidates.filter((_, i) => firstPages[i]!.items.length >= THEME_MIN_ITEMS).slice(0, THEMES_PER_LANE)
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
  return buildRow(req.row, page, await resolveProfile(store, net, now), net, now)
}
