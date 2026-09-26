/**
 * Micro-genres: rows about a theme several of the user's favourites share.
 *
 * Genres are too coarse to say what someone likes about a title. Twenty
 * genres cover the whole catalogue, so "Sci-Fi & Fantasy" puts Frieren next to
 * Star Trek. TMDB's keywords are the finer layer underneath: "time travel",
 * "isekai", "survival game", "heist". A keyword that several of the user's
 * favourites carry is a taste they have not named but demonstrably have, and
 * a row built on it can say so in its heading: "Survival game anime".
 */

import type { TitleAffinity } from '../taste'
import type { ForYouDeps } from './deps'
import { LANE_NOUN, type Lane } from './lanes'

export interface Theme {
  keyword: number
  name: string
  /** Summed affinity of the favourites that carry it. */
  weight: number
  /** How many of the favourites carry it. */
  titles: number
}

/**
 * How many of a lane's favourites are asked for their keywords.
 *
 * Eight requests a lane at plan time, cached after that. More finds rarer
 * themes, but a theme carried only by the user's twentieth favourite is not a
 * taste worth a row.
 */
export const THEME_SOURCES = 8

/** A keyword carried by fewer favourites than this is a coincidence, not a taste. */
export const THEME_MIN_TITLES = 2

/**
 * Keywords that describe how a title was made or sold rather than what it is
 * about. "Based on manga" is on nearly every anime and is true of Frieren and
 * of Berserk alike, so a row built on it is just the lane again.
 */
const GENERIC = new RegExp(
  [
    '^anime$',
    '^animation$',
    '^adult animation$',
    '^cartoon$',
    '^based on (manga|light novel|novel or book|comic|web ?comic|webtoon|video game|anime|cartoon|children\'s book|short story|play or musical|tv series)$',
    '^manga$',
    '^light novel$',
    '^(shounen|shonen|seinen|shoujo|shojo|josei)$',
    'stinger$',
    '^woman director$',
    '^(sequel|prequel|remake|reboot|spin ?off|miniseries|mini-series|anthology)$',
    '^live action',
    '^(male|female) protagonist$',
    '^(japan|tokyo, japan)$',
    '^(tv|web) series$',
    '^original video animation',
    // True of too much to be a taste: a row of "Friendship movies" opened with
    // The Shawshank Redemption, Django Unchained and Toy Story 2.
    '^(friendship|love|family|romance|death|violence|drama|comedy)$',
    'relationship$',
  ].join('|'),
  'i',
)

/**
 * A lane's themes, strongest first: keywords carried by at least two of its
 * favourites, weighted by how much the user likes the titles that carry them.
 *
 * `sources` are the titles whose keywords are read. That is the lane's own
 * titles, or, for a lane with too few of its own, the titles its genre taste is
 * borrowed from (`profile.ts`).
 */
export async function themeCandidates(
  sources: readonly TitleAffinity[],
  keywords: ForYouDeps['keywords'],
): Promise<Theme[]> {
  const favourites = sources
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score || a.tmdbId - b.tmdbId)
    .slice(0, THEME_SOURCES)
  const lists = await Promise.all(favourites.map((t) => keywords(t.tmdbId, t.type)))

  const tally = new Map<number, Theme>()
  lists.forEach((list, i) => {
    const score = favourites[i]!.score
    // A title that lists a keyword twice still carries it once.
    for (const k of new Map(list.map((k) => [k.id, k])).values()) {
      if (GENERIC.test(k.name.trim())) continue
      const theme = tally.get(k.id) ?? { keyword: k.id, name: k.name.trim(), weight: 0, titles: 0 }
      theme.weight += score
      theme.titles += 1
      tally.set(k.id, theme)
    }
  })

  return [...tally.values()]
    .filter((t) => t.titles >= THEME_MIN_TITLES)
    .sort((a, b) => b.weight - a.weight || a.keyword - b.keyword)
}

/** "Isekai anime", "Time travel TV shows": the keyword, then the lane. */
export function themeTitle(name: string, lane: Lane): string {
  const words = name.trim()
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} ${LANE_NOUN[lane]}`
}
