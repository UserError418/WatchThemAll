/**
 * Which rows Browse shows, and in what order.
 *
 * ## The page, top to bottom
 *
 * 1. **The head: one Top picks row per lane**, strongest lane first. Every
 *    lane the user has a taste in is on the first screen, whatever its share
 *    of the library.
 * 2. **The body, in rounds.** Each round takes one row from each lane — a
 *    "Because you loved ‹Title›", a micro-genre, a genre shelf, in that
 *    rotation — then one discovery row that mixes the lanes ("New for you",
 *    "Hidden gems for you", "More like your watchlist", "Critically
 *    acclaimed"). The lane that leads each round rotates, so no two rows of
 *    one lane sit together while another lane still has rows.
 *
 * ## How many rows a lane gets
 *
 * Every lane gets `BODY_BASE` body rows, whatever its share: this is what
 * "equal at the top" buys (agreed with the owner, 2026-09-26). The `BODY_EXTRA`
 * rows after that go to the lanes the user likes most, but no lane takes more
 * than `BODY_EXTRA_CAP` of them. On the owner's library, three-quarters anime, the
 * anime lane ends with 6 of 15 lane rows instead of 12.
 */

import type { ForYouLane, ForYouRow } from '@shared/ipc'
import { titleId, type TitleAffinity } from '../taste'
import { LANE_NOUN, LANES, type Lane } from './lanes'
import type { Profile } from './profile'
import { conceptAllowed, laneTopConcepts, mixedLanes } from './rows'
import { becauseVerb, genreShelves, TOP_PICK_SEEDS, topPickSeeds } from './seeds'
import { themeTitle, type Theme } from './themes'

/** Body rows every lane gets, whatever its share of the user's taste. */
export const BODY_BASE = 3
/** Body rows shared out by taste after that. */
export const BODY_EXTRA = 4
/** The most of `BODY_EXTRA` one lane can take. */
export const BODY_EXTRA_CAP = 2

/** Most "Because you…" rows, micro-genres and genre shelves per lane. */
export const BECAUSE_PER_LANE = 3
export const THEMES_PER_LANE = 3
export const SHELVES_PER_LANE = 3

/** How many watchlist titles "More like your watchlist" pools. */
export const WATCHLIST_SEEDS = 6

/** Everything a plan is made from, already checked against TMDB. */
export interface PlanInputs {
  profile: Profile
  /** A concept's name, or undefined when it has none — a shelf with no name is dropped. */
  genreName: (concept: number) => string | undefined
  /** Each lane's viable "Because you" seeds, in this session's order. */
  because: Record<Lane, readonly TitleAffinity[]>
  /** Each lane's viable micro-genres, strongest first. */
  themes: Record<Lane, readonly Theme[]>
}

/** "Top TV show picks for you". */
const TOP_TITLE: Record<Lane, string> = {
  series: 'Top TV show picks for you',
  films: 'Top movie picks for you',
  anime: 'Top anime picks for you',
}

const MIXED: Array<{ flavour: 'new' | 'gems' | 'acclaimed'; title: string } | 'watchlist'> = [
  { flavour: 'new', title: 'New for you' },
  { flavour: 'gems', title: 'Hidden gems for you' },
  'watchlist',
  { flavour: 'acclaimed', title: 'Critically acclaimed' },
]

/**
 * Whether a lane has a taste to show: anime only once the user likes some,
 * series and films as soon as there is a genre to go on, their own or
 * borrowed.
 */
function hasTaste(profile: Profile, lane: Lane): boolean {
  if (lane === 'anime') return profile.lanes.anime.share > 0
  return profile.lanes[lane].titles.some((t) => t.score > 0) || laneTopConcepts(profile, lane).length > 0
}

/** The lanes with a taste, strongest first. */
export function laneOrder(profile: Profile): Lane[] {
  return LANES.filter((l) => hasTaste(profile, l)).sort(
    (a, b) => profile.lanes[b].share - profile.lanes[a].share || LANES.indexOf(a) - LANES.indexOf(b),
  )
}

/**
 * How many of the `BODY_EXTRA` rows each lane gets: one at a time to the lane
 * with the highest share per row already given (the D'Hondt rule, which is
 * proportional without letting rounding hand the last row to anyone), skipping
 * lanes at the cap or out of rows.
 */
export function extraRows(profile: Profile, lanes: readonly Lane[], available: Record<Lane, number>): Record<Lane, number> {
  const given: Record<Lane, number> = { series: 0, films: 0, anime: 0 }
  for (let slot = 0; slot < BODY_EXTRA; slot += 1) {
    const open = lanes.filter(
      (l) => given[l] < BODY_EXTRA_CAP && BODY_BASE + given[l] < available[l] && profile.lanes[l].share > 0,
    )
    if (open.length === 0) break
    const next = open.reduce((best, l) =>
      profile.lanes[l].share / (given[l] + 1) > profile.lanes[best].share / (given[best] + 1) ? l : best,
    )
    given[next] += 1
  }
  return given
}

/** Rows from several queues in turn: one from each, then the next one from each. */
function alternate<T>(queues: ReadonlyArray<readonly T[]>): T[] {
  const out: T[] = []
  for (let i = 0; queues.some((q) => i < q.length); i += 1) {
    for (const q of queues) if (i < q.length) out.push(q[i]!)
  }
  return out
}

/** The personalised rows, in display order. */
export function planRows({ profile, genreName, because, themes }: PlanInputs): ForYouRow[] {
  const lanes = laneOrder(profile)
  if (lanes.length === 0) return []

  // Top picks pools favourites that head no "Because you" row, in any lane.
  // Every title belongs to the first row that shows it, and Top picks is
  // above them: when one favourite seeded both, Top picks took that
  // favourite's best recommendations and its own row came up empty —
  // measured, "Because you watched Liar Game" over nothing while TMDB had 535.
  const heading = new Set(LANES.flatMap((l) => because[l].map((t) => titleId(t.type, t.tmdbId))))

  const head: ForYouRow[] = lanes.map((lane) => ({
    kind: 'topPicks',
    key: `for-you:top:${lane}`,
    title: TOP_TITLE[lane],
    lane,
    seeds: topPickSeeds(profile.lanes[lane].titles.filter((t) => !heading.has(titleId(t.type, t.tmdbId))))
      .map((t) => ({ tmdbId: t.tmdbId, type: t.type })),
  }))

  // Built strongest lane first, sharing what is already used: a genre heads
  // one shelf on the page and a keyword one micro-genre. Drama is the top
  // genre of every lane on the owner's library, and "Drama TV shows", "Drama
  // movies" and "Drama anime" was one idea three times.
  const used: Used = { concepts: new Set(), keywords: new Set() }
  const queues = Object.fromEntries(
    lanes.map((lane) => [lane, laneQueue(profile, lane, genreName, because[lane], themes[lane], used)]),
  ) as Record<Lane, ForYouRow[]>
  const available = { series: 0, films: 0, anime: 0, ...Object.fromEntries(lanes.map((l) => [l, queues[l].length])) }
  const extra = extraRows(profile, lanes, available)
  for (const lane of lanes) queues[lane] = queues[lane].slice(0, BODY_BASE + extra[lane])

  const mixed = mixedRows(profile)
  const body: ForYouRow[] = []
  let last: Lane | null = null
  for (let round = 0; lanes.some((l) => queues[l].length > 0); round += 1) {
    const shift = round % lanes.length
    let order = [...lanes.slice(shift), ...lanes.slice(0, shift)].filter((l) => queues[l].length > 0)
    // Rotating the lead alone can still end one round and start the next with
    // the same lane: always with two lanes, and with three once one runs out.
    // Sending that lane to the back of the round keeps the two rows apart.
    if (order.length > 1 && order[0] === last) order = [...order.slice(1), order[0]!]
    for (const lane of order) {
      body.push(queues[lane].shift()!)
      last = lane
    }
    const discovery = mixed.shift()
    if (discovery) {
      body.push(discovery)
      last = null
    }
  }
  return [...head, ...body, ...mixed]
}

/** Genre concepts and keywords already heading a row further up the page. */
interface Used {
  concepts: Set<number>
  keywords: Set<number>
}

/**
 * One lane's body rows, best first: a "Because you" row, a micro-genre and a
 * genre shelf, then the next of each. Alternating kinds is what makes three
 * rows of one lane three different reasons rather than one reason three times.
 */
function laneQueue(
  profile: Profile,
  lane: Lane,
  genreName: (concept: number) => string | undefined,
  because: readonly TitleAffinity[],
  themes: readonly Theme[],
  used: Used,
): ForYouRow[] {
  const becauseRows: ForYouRow[] = because.slice(0, BECAUSE_PER_LANE).flatMap((t) => {
    const name = profile.names.get(titleId(t.type, t.tmdbId))
    if (!name) return []
    return [{
      kind: 'because' as const,
      key: `for-you:because:${lane}:${t.type}:${t.tmdbId}`,
      title: `Because you ${becauseVerb(t)} ${name}`,
      lane,
      seed: { tmdbId: t.tmdbId, type: t.type },
    }]
  })

  const themeRows: ForYouRow[] = themes
    .filter((theme) => !used.keywords.has(theme.keyword))
    .slice(0, THEMES_PER_LANE)
    .map((theme) => {
      used.keywords.add(theme.keyword)
      return {
        kind: 'theme' as const,
        key: `for-you:theme:${lane}:${theme.keyword}`,
        title: themeTitle(theme.name, lane),
        lane,
        keyword: theme.keyword,
      }
    })

  const own = profile.lanes[lane]
  const allowed = conceptAllowed(lane)
  const fresh = (c: number): boolean => allowed(c) && !used.concepts.has(c)
  const shelves = genreShelves(own.singles, own.pairs, SHELVES_PER_LANE, fresh)
  for (const shelf of shelves) for (const c of shelf.concepts) used.concepts.add(c)
  const shelfRows: ForYouRow[] = shelves
    .flatMap((shelf) => {
      const names = shelf.concepts.map(genreName)
      if (names.some((n) => !n)) return []
      return [{
        kind: 'genre' as const,
        key: `for-you:genre:${lane}:${shelf.concepts.join('+')}`,
        title: `${names.join(' · ')} ${LANE_NOUN[lane]}`,
        lane,
        concepts: shelf.concepts,
      }]
    })

  return alternate([becauseRows, themeRows, shelfRows])
}

/** The discovery rows that mix the lanes, in the order they are dealt into the body. */
function mixedRows(profile: Profile): ForYouRow[] {
  if (mixedLanes(profile).length === 0) return []
  return MIXED.flatMap((m): ForYouRow[] => {
    if (m !== 'watchlist') {
      return [{ kind: 'mixed', key: `for-you:mixed:${m.flavour}`, title: m.title, flavour: m.flavour }]
    }
    const seeds = profile.watchlist.slice(0, WATCHLIST_SEEDS).map((w) => ({ tmdbId: w.tmdbId, type: w.type }))
    return seeds.length === 0
      ? []
      : [{ kind: 'watchlist', key: 'for-you:watchlist', title: 'More like your watchlist', seeds }]
  })
}

/* ── Checking a row the renderer hands back ─────────────────────────────── */

const isLane = (x: unknown): x is ForYouLane => LANES.includes(x as Lane)
const positiveInt = (x: unknown): boolean => Number.isInteger(x) && (x as number) > 0

function isSeed(x: unknown): boolean {
  const seed = x as Record<string, unknown> | undefined
  return !!seed && positiveInt(seed.tmdbId) && (seed.type === 'tv' || seed.type === 'movie')
}

function isSeedList(x: unknown, min: number, max: number): boolean {
  return Array.isArray(x) && x.length >= min && x.length <= max && x.every(isSeed)
}

/**
 * Whether something the renderer handed back is a row main could have planned.
 *
 * The row round-trips through the renderer, so it is input like any other.
 * What it can make main fetch is already narrow — ids, genre and keyword
 * numbers, never a URL — but a malformed one should be refused here rather
 * than turned into a TMDB request that 404s.
 */
export function isForYouRow(value: unknown): value is ForYouRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  if (typeof row.key !== 'string' || typeof row.title !== 'string') return false

  switch (row.kind) {
    case 'topPicks':
      // Empty is allowed: a lane with no favourites of its own is made from
      // its genres alone.
      return isLane(row.lane) && isSeedList(row.seeds, 0, TOP_PICK_SEEDS)
    case 'because':
      return isLane(row.lane) && isSeed(row.seed)
    case 'genre':
      return (
        isLane(row.lane) &&
        Array.isArray(row.concepts) &&
        row.concepts.length >= 1 &&
        row.concepts.length <= 2 &&
        row.concepts.every(positiveInt)
      )
    case 'theme':
      return isLane(row.lane) && positiveInt(row.keyword)
    case 'mixed':
      return row.flavour === 'new' || row.flavour === 'gems' || row.flavour === 'acclaimed'
    case 'watchlist':
      return isSeedList(row.seeds, 1, WATCHLIST_SEEDS)
    default:
      return false
  }
}
