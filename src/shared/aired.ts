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
  const at = localMidnight(releaseDate)
  return Number.isFinite(at) && at > now
}

/**
 * When a TMDB date (`YYYY-MM-DD`) begins where the user is: local midnight.
 *
 * The rule the rest of the app follows (`format.ts`, `schedule.ts`,
 * `releases.ts`). `Date.parse` alone reads a bare date as UTC midnight, which
 * here made a title "not out yet" for the first hours of its release day
 * (and, west of UTC, "out" hours early). NaN for anything unparseable.
 */
export function localMidnight(date: string): number {
  return new Date(`${date}T00:00:00`).getTime()
}

/**
 * A release tracker's bookmark for "checked, and nothing has aired yet".
 *
 * `ReleaseTracker.lastNotified` null means "never checked", and the first
 * check then takes whatever has aired as the bookmark without a word, so that
 * tracking a series does not announce last week's episode. A series tracked
 * before its premiere needs the other answer. Without it the premiere was the
 * first thing any check ever saw, and was taken silently as the bookmark: the
 * one episode a user tracks an upcoming series for was the one never
 * announced (found 2026-10-03, with a real library tracking a season that
 * drops all at once later in the month).
 *
 * Season 0, episode 0 comes before every real episode, which is how the
 * sweep's comparison and the sync merge's `laterEpisode` already order it,
 * and the ReelVault export already writes an unknown position as 0/0.
 */
export const NOTHING_AIRED_YET: Readonly<EpisodeStub> = Object.freeze({ season: 0, episode: 0, name: '', airDate: null })

export function isNothingAiredYet(stub: Pick<EpisodeStub, 'season' | 'episode'> | null | undefined): boolean {
  return stub !== null && stub !== undefined && stub.season === 0 && stub.episode === 0
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
