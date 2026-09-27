/**
 * Where "next episode" and "previous episode" go.
 *
 * One rule for every place that steps through a series: auto-next at the end
 * of an episode (`main/upnext.ts`, in both apps) and the cast remote's ⏮ and
 * ⏭ (`PlayerChrome.svelte`). The remote used to count on its own, which let
 * ⏭ walk onto an episode that had not aired and let ⏮ land on episode 1 of
 * the previous season, because without the list it could not know how long
 * that season was. Two rules for one gesture meant the countdown and the
 * button could disagree about what came next.
 *
 * Both ask TMDB through the `season` function they are given, so the caller
 * decides the transport (IPC, the phone's fetch, a test's table).
 */

import type { EpisodeStub, Season } from './types'
import { localMidnight } from './aired'

export interface NextEpisode {
  season: number
  episode: number
  name: string | null
}

/** Aired by the viewer's own calendar. An episode with no date has not. */
function hasAired(episode: Pick<EpisodeStub, 'airDate'>, now: number): boolean {
  if (!episode.airDate) return false
  const at = localMidnight(episode.airDate)
  return Number.isFinite(at) && at <= now
}

/**
 * The episode after this one that can be watched now, or null.
 *
 * The next one in the season, else the first of the next season — only if
 * aired. Asks for at most two seasons. Any failure to ask answers null: an
 * auto-next that guesses would send the viewer to an episode that does not
 * exist, and the manual next button is still there.
 *
 * `seasonCount` may be `Infinity` where it is not known: asking for a season
 * that does not exist fails, and a failure answers null.
 */
export async function nextAiredEpisode(
  at: { season: number; episode: number },
  seasonCount: number,
  season: (number: number) => Promise<Season | null>,
  now = Date.now(),
): Promise<NextEpisode | null> {
  try {
    const current = await season(at.season)
    const later = (current?.episodes ?? [])
      .filter((e) => e.episode > at.episode)
      .sort((a, b) => a.episode - b.episode)[0]
    if (later) return hasAired(later, now) ? { season: at.season, episode: later.episode, name: later.name || null } : null

    if (at.season >= seasonCount) return null
    const following = await season(at.season + 1)
    const first = (following?.episodes ?? []).filter((e) => e.episode >= 1).sort((a, b) => a.episode - b.episode)[0]
    return first && hasAired(first, now) ? { season: at.season + 1, episode: first.episode, name: first.name || null } : null
  } catch {
    return null
  }
}

/**
 * The episode before this one, or null at the very beginning.
 *
 * The one before it in the season, else the **last** episode of the previous
 * season. No aired check: everything before the episode being watched is out,
 * and old seasons are where TMDB most often has no dates, so a check would
 * only refuse episodes that exist.
 *
 * When TMDB cannot be asked, one step back within the season is still safe
 * arithmetic, so it is taken. Across a season boundary it is not, because the
 * previous season's length is exactly what is missing, so the answer is null.
 */
export async function previousEpisode(
  at: { season: number; episode: number },
  season: (number: number) => Promise<Season | null>,
): Promise<NextEpisode | null> {
  const arithmetic = at.episode > 1 ? { season: at.season, episode: at.episode - 1, name: null } : null
  try {
    const current = await season(at.season)
    const earlier = (current?.episodes ?? [])
      .filter((e) => e.episode >= 1 && e.episode < at.episode)
      .sort((a, b) => b.episode - a.episode)[0]
    if (earlier) return { season: at.season, episode: earlier.episode, name: earlier.name || null }
    // An unknown list, rather than a list with nothing before this episode.
    if (current === null && arithmetic) return arithmetic

    if (at.season <= 1) return null
    const before = await season(at.season - 1)
    const last = (before?.episodes ?? []).filter((e) => e.episode >= 1).sort((a, b) => b.episode - a.episode)[0]
    return last ? { season: at.season - 1, episode: last.episode, name: last.name || null } : null
  } catch {
    return arithmetic
  }
}
