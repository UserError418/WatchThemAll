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

/** Aired by the viewer's calendar. An episode with no date has not. */
function hasAired(episode: Pick<EpisodeStub, 'airDate'>, now: number): boolean {
  if (!episode.airDate) return false
  const at = localMidnight(episode.airDate)
  return Number.isFinite(at) && at <= now
}

/**
 * Whether a step may land on episode `episode` of season `season`: aired by
 * the viewer's calendar, and no later than TMDB's own last aired episode when
 * that is known.
 *
 * The calendar alone was the rule until 2026-10-03, and it is early. An air
 * date is the broadcast day where the show is made, and its local midnight
 * here put a US evening broadcast "out" about a day before any source had it
 * for a viewer in Europe: measured at 16:30 UTC that day, three US shows'
 * episodes dated that day were still TMDB's next episode, while Central
 * European midnight had counted them out since 22:00 UTC the day before.
 * Auto-next then loaded an episode nothing could play. TMDB's last aired
 * episode is what source tests already go by (`airedEpisode`), so the steps
 * follow it too. Unknown, or a special, which says nothing about how far the
 * numbered seasons have got, and the calendar decides alone.
 */
function canStepTo(
  season: number,
  episode: Pick<EpisodeStub, 'episode' | 'airDate'>,
  now: number,
  lastAired: Pick<EpisodeStub, 'season' | 'episode'> | null,
): boolean {
  if (!hasAired(episode, now)) return false
  if (!lastAired || lastAired.season < 1) return true
  return season < lastAired.season || (season === lastAired.season && episode.episode <= lastAired.episode)
}

/**
 * The episode after this one that can be watched now, or null.
 *
 * The next one in the season, else the first of the next season — only if
 * it has come out (`canStepTo`). Asks for at most two seasons. Any failure to
 * ask answers null: an auto-next that guesses would send the viewer to an
 * episode that does not exist, and the manual next button is still there.
 *
 * `seasonCount` may be `Infinity` where it is not known: asking for a season
 * that does not exist fails, and a failure answers null.
 *
 * `lastAired` is TMDB's last aired episode (`MediaDetail.lastEpisode`), where
 * the caller has the title's details; without it the calendar decides alone.
 */
export async function nextAiredEpisode(
  at: { season: number; episode: number },
  seasonCount: number,
  season: (number: number) => Promise<Season | null>,
  now = Date.now(),
  lastAired: Pick<EpisodeStub, 'season' | 'episode'> | null = null,
): Promise<NextEpisode | null> {
  try {
    const current = await season(at.season)
    const later = (current?.episodes ?? [])
      .filter((e) => e.episode > at.episode)
      .sort((a, b) => a.episode - b.episode)[0]
    if (later) {
      return canStepTo(at.season, later, now, lastAired) ? { season: at.season, episode: later.episode, name: later.name || null } : null
    }

    if (at.season >= seasonCount) return null
    const following = await season(at.season + 1)
    const first = (following?.episodes ?? []).filter((e) => e.episode >= 1).sort((a, b) => a.episode - b.episode)[0]
    return first && canStepTo(at.season + 1, first, now, lastAired)
      ? { season: at.season + 1, episode: first.episode, name: first.name || null }
      : null
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
