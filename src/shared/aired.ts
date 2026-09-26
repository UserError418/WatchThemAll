/**
 * What a source test may be pointed at: something that has come out.
 *
 * A test asks each provider for one film or one episode, and no provider can
 * have what has not aired — so testing it paints every working source red.
 * That happened whenever the user had finished the latest season: a test asks
 * for where the user is, which is then the first episode of a season still to
 * come (reported 2026-09-26).
 *
 * Shared because both ends need it: the main process moves a test onto an
 * aired episode, and the detail view says "not out yet" instead of offering a
 * test that could only fail.
 */

import type { EpisodeStub } from './types'

/**
 * Whether a TMDB date (`YYYY-MM-DD`) is still to come.
 *
 * False when there is no date: an unknown date is not a known future one, and
 * refusing to test every title TMDB has no date for would block tests that
 * would have worked. The background tester is stricter on purpose — it only
 * spends a test on what is known to be out; see `TitleFacts.released`.
 */
export function notOutYet(releaseDate: string | null | undefined, now: number): boolean {
  if (!releaseDate) return false
  const at = Date.parse(releaseDate)
  return Number.isFinite(at) && at > now
}

/**
 * The episode to test: the one wanted, or the last aired one when the wanted
 * one comes after it.
 *
 * The last aired episode is the nearest to where the user is that a provider
 * can have. It leaves the wanted episode alone when there is no last aired
 * episode to go by — TMDB was not asked, or the series has none — and when
 * TMDB's latest is a special (season 0), which says nothing about how far the
 * numbered seasons have got.
 */
export function airedEpisode(
  wanted: { season: number; episode: number },
  lastAired: Pick<EpisodeStub, 'season' | 'episode'> | null | undefined,
): { season: number; episode: number } {
  if (!lastAired || lastAired.season < 1) return wanted
  const later =
    wanted.season > lastAired.season ||
    (wanted.season === lastAired.season && wanted.episode > lastAired.episode)
  return later ? { season: lastAired.season, episode: lastAired.episode } : wanted
}
