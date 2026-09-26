/**
 * Browse's three lanes: series, films and anime.
 *
 * A library that is three-quarters anime produced a page that was four-fifths
 * anime — measured on the owner's after his MyAnimeList import: 81% of the cards in
 * the personal rows were animation, Top picks all of them. Scores can't fix
 * that on their own, because a profile that loves anime ranks anime first,
 * correctly. So the lanes are kept apart structurally: every lane row shows
 * one lane only, and the plan decides how many rows each lane gets
 * (`plan.ts`), not the scores.
 *
 * **Anime is Japanese animation**, films included — TMDB's Animation genre and
 * an original language of `ja`. Western animation is a series or a film like
 * any other: Arcane belongs with Severance more than with Frieren.
 */

import type { MediaType } from '@shared/types'
import type { ForYouLane } from '@shared/ipc'
import type { DiscoverQuery } from '../tmdb'
import { titleId, type TasteStore, type TitleAffinity } from '../taste'

export type Lane = ForYouLane

/** Every lane, in the order ties between them are broken. */
export const LANES: readonly Lane[] = ['series', 'films', 'anime']

/** TMDB's Animation genre, the same id for films and series. */
export const ANIMATION = 16
const JAPANESE = 'ja'

/** Enough of a title to put it in a lane. */
export interface Classifiable {
  type: MediaType
  genreIds: readonly number[]
  originalLanguage?: string
}

export function laneOf(m: Classifiable): Lane {
  if (m.genreIds.includes(ANIMATION) && m.originalLanguage === JAPANESE) return 'anime'
  return m.type === 'movie' ? 'films' : 'series'
}

export function inLane(lane: Lane): (m: Classifiable) => boolean {
  return (m) => laneOf(m) === lane
}

/** What a lane is called in a row's heading, in the words the owner used for them. */
export const LANE_NOUN: Record<Lane, string> = {
  series: 'TV shows',
  films: 'movies',
  anime: 'anime',
}

/** Language answers already known, by title. A title's language never changes. */
export type LanguageCache = Map<string, string>

const LANGUAGES: LanguageCache = new Map()

/**
 * The lane of each of the user's own titles.
 *
 * The library does not store a language, so most titles are placed without
 * one: anything not animated goes by its type, and an animated title that came
 * from a MyAnimeList import is anime by definition. Only the rest — animated,
 * added by hand — are asked about, through `language`. That is a handful of
 * requests, and the detail view makes the same one, so often none.
 *
 * A lookup that fails places the title by its type. Calling a title anime
 * needs evidence; the cost of being wrong is one seed in the wrong lane.
 */
export async function libraryLanes(
  titles: readonly TitleAffinity[],
  store: TasteStore,
  language: (tmdbId: number, type: MediaType) => Promise<string | null>,
  cache: LanguageCache = LANGUAGES,
): Promise<Map<string, Lane>> {
  const fromMal = malTitles(store)
  const out = placeWithout(titles, fromMal)
  const unknown = titles.filter(
    (t) => t.genreIds.includes(ANIMATION) && !fromMal.has(titleId(t.type, t.tmdbId)),
  )

  await Promise.all(
    unknown.map(async (t) => {
      const id = titleId(t.type, t.tmdbId)
      let lang = cache.get(id)
      if (lang === undefined) {
        const answer = await language(t.tmdbId, t.type)
        if (answer) {
          lang = answer
          cache.set(id, answer)
        }
      }
      out.set(id, laneOf({ ...t, originalLanguage: lang }))
    }),
  )
  return out
}

/**
 * The lanes that can be told without asking anyone: `libraryLanes` before its
 * lookups. What a profile falls back to when built without a network.
 */
export function guessLanes(titles: readonly TitleAffinity[], store: TasteStore): Map<string, Lane> {
  return placeWithout(titles, malTitles(store))
}

function placeWithout(titles: readonly TitleAffinity[], fromMal: ReadonlySet<string>): Map<string, Lane> {
  const out = new Map<string, Lane>()
  for (const t of titles) {
    const id = titleId(t.type, t.tmdbId)
    const anime = t.genreIds.includes(ANIMATION) && fromMal.has(id)
    out.set(id, anime ? 'anime' : laneOf({ type: t.type, genreIds: [] }))
  }
  return out
}

function malTitles(store: TasteStore): Set<string> {
  return new Set(store.watched.filter((w) => w.source === 'mal').map((w) => titleId(w.type, w.tmdbId)))
}

/** The catalogues a lane is asked for. Anime is both. */
export function laneCatalogues(lane: Lane): MediaType[] {
  if (lane === 'series') return ['tv']
  if (lane === 'films') return ['movie']
  return ['tv', 'movie']
}

/**
 * A `/discover` query held to one lane.
 *
 * Anime can be asked for directly: Animation, AND-ed with the row's own genres,
 * in Japanese. The other two lanes cannot exclude anime in TMDB's syntax, so
 * they are asked for plainly and filtered afterwards with `inLane`.
 *
 * `genres` is a genre string in TMDB's syntax, or empty. Anime AND-s only its
 * first alternative: "Animation and (Sci-Fi or Fantasy)" is not something the
 * syntax can say reliably, and "Animation and Sci-Fi" is the truer half.
 */
export function laneQuery(lane: Lane, genres: string, rest: DiscoverQuery = {}): DiscoverQuery {
  if (lane !== 'anime') return { ...rest, ...(genres ? { withGenres: genres } : {}) }
  const first = genres.split('|')[0]
  return {
    ...rest,
    withGenres: first ? `${ANIMATION},${first}` : String(ANIMATION),
    language: JAPANESE,
  }
}
