/**
 * How long the title a source test asks for runs, by TMDB.
 *
 * A test asked only whether a stream exists until 2026-10, so it was given no
 * runtime, and its length checks fell back on "at least ten minutes"
 * (`lengthVerdict`). Since then a test also asks whether the stream is the
 * film (`rightfilm.ts`) and finds the film's ladder by its length
 * (`findLadder`), and for both the runtime is what tells a clip, or another
 * programme, from the title.
 *
 * The episode's own runtime where TMDB has one, else the show's (a film's
 * own): a special or a double-length finale held to the show's usual length
 * would read as something else. TMDB's episode runtimes come with its season
 * listing, which the detail view has usually fetched (and `tmdb.ts` keeps for
 * ten minutes), so this is mostly a cache hit. On both platforms: the phone
 * reaches `tmdb.ts` too.
 */

import type { Season } from '@shared/types'

/** The part of the TMDB client this needs: a season's episode listing. */
export interface SeasonLookUp {
  season(tmdbId: number, season: number): Promise<Season>
}

/** A runtime TMDB actually gave: a positive number of minutes. */
function given(minutes: number | null | undefined): number | null {
  return typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? minutes : null
}

/**
 * The runtime to test `episode` of `tmdbId` against, in minutes; null when
 * TMDB gives none. `showRuntime` is the title's own (`MediaDetail.runtime`).
 * A season TMDB cannot answer for is only the show's runtime, never a failure.
 */
export async function testRuntime(
  tmdb: SeasonLookUp,
  tmdbId: number,
  showRuntime: number | null | undefined,
  episode: { season: number; episode: number } | null,
): Promise<number | null> {
  if (episode !== null) {
    const season = await tmdb.season(tmdbId, episode.season).catch(() => null)
    const own = given(season?.episodes.find((e) => e.episode === episode.episode)?.runtime)
    if (own !== null) return own
  }
  return given(showRuntime)
}
