/**
 * Where a series should pick up, derived rather than stored.
 *
 * ## Why this is not just `lastSeason`/`lastEpisode`
 *
 * Those two fields mean "the last episode that was *started*", and they are the
 * right thing to store: they are written the moment a player opens, they merge
 * cleanly across devices, and they are in the frozen export format. What they
 * are not is an answer to "where do I resume", because the last episode started
 * is very often one that was then finished — and a finished episode is not a
 * place to resume. Reading them straight out is what left the Resume button
 * offering an episode the user had already watched to the end, with the "you
 * are here" highlight stuck on the same row.
 *
 * Deriving the target instead of storing it also removes a write race that no
 * amount of care at the call sites would have fixed. Leaving an episode settles
 * it in the main process and leaving is *also* what happens when the user picks
 * the next one, so "E1 finished" and "E2 started" are two writes to one field
 * with no guaranteed order. A derived target does not care which arrived last.
 *
 * ## The rule
 *
 * Resume the last episode started unless it is finished; if it is, take the
 * next unfinished one, crossing into the following season when the current one
 * is done. Nothing left to watch means the last episode, so the button still
 * works as a re-watch.
 */

export interface EpisodeRef {
  season: number
  episode: number
}

export interface ResumeTargetArgs {
  /**
   * Episodes of the season the overlay currently has loaded.
   *
   * Each carries its own season number, and only the ones matching
   * `lastSeason` are considered — the user may well be looking at season 4
   * while their position is in season 1.
   */
  episodes: readonly EpisodeRef[]
  /** The last episode started. 1-based, as everywhere else. */
  lastSeason: number
  lastEpisode: number
  /** How many seasons the series has, so the last one does not roll over. */
  seasonCount: number
  isWatched: (season: number, episode: number) => boolean
}

export function resumeTarget(args: ResumeTargetArgs): EpisodeRef {
  const { episodes, lastSeason, lastEpisode, seasonCount, isWatched } = args
  const here: EpisodeRef = { season: lastSeason, episode: lastEpisode }

  // Started and not finished: that is exactly where to go back to.
  if (!isWatched(lastSeason, lastEpisode)) return here

  const rest = episodes
    .filter((e) => e.season === lastSeason && e.episode > lastEpisode)
    .sort((a, b) => a.episode - b.episode)

  const next = rest.find((e) => !isWatched(e.season, e.episode))
  if (next) return { season: next.season, episode: next.episode }

  /*
   * Nothing left in this season. Crossing over is only safe when the season
   * really is exhausted, which needs the episode list — with no list loaded
   * there is no way to tell "finished the season" from "have not been told
   * what is in it", and guessing forward would offer an episode that may not
   * exist.
   */
  const seasonIsKnown = episodes.some((e) => e.season === lastSeason)
  if (seasonIsKnown && lastSeason < seasonCount) return { season: lastSeason + 1, episode: 1 }

  return here
}

/**
 * What to hand the player for a resume target: the listed episode when a
 * loaded season has it, the bare position otherwise.
 *
 * Never a *different* episode. The detail view used to fall back to the first
 * episode of whichever season was on screen, so a button reading "Resume
 * S02E01" played S01E01. A bare position plays just as well — providers need
 * only the numbers — and loses nothing but the episode's own runtime.
 */
export function episodeToPlay<T extends EpisodeRef>(
  target: EpisodeRef,
  listings: ReadonlyArray<readonly T[]>,
): T | EpisodeRef {
  for (const listing of listings) {
    const found = listing.find((e) => e.season === target.season && e.episode === target.episode)
    if (found) return found
  }
  return { season: target.season, episode: target.episode }
}
