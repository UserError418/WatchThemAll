/**
 * Auto-next: at the end of an episode, play the next one.
 *
 * Asked for by the owner (2026-09-27): series only, never films; the next
 * episode of the season, then the first of the next season once it has aired;
 * nothing after the last aired episode; a Settings switch, on by default. It
 * works the same in the mini player and while casting, where the television
 * is sent the next episode when it finishes the current one.
 *
 * The owner again (2026-09-29): "automatically, without countdown or a
 * prompt". Until 2.0.6 the end raised a five second countdown with Cancel
 * and Play now; there is no offer any more, the end is the move.
 *
 * Both apps drive the same `UpNextController`: the desktop's main process and
 * the phone's bridge each feed it "this ended", and it tells them when to
 * move. It lives here rather than in a screen, because the screen that saw
 * the end may be the mini player, the full chrome, or nothing at all while
 * the phone is in a pocket.
 */

import type { NextEpisode } from '@shared/episodesteps'
import { lengthVerdict } from './runtimecheck'

/**
 * How close to the end counts as the end, in seconds.
 *
 * A second and a half: the owner asked for "the last second", and the
 * position is read every 2 to 2.5 seconds, so a tighter window could step
 * over the end without a reading inside it. The video's own `ended` is
 * taken whatever the window says.
 */
const END_WINDOW_SECONDS = 1.5

export interface EndReading {
  seconds: number
  duration: number | null
  ended: boolean
}

/**
 * Whether a reading says the episode is over.
 *
 * The length has to fit the episode, because an advert ends too, and so does
 * a provider's intro clip: without the check, the last second of a thirty
 * second advert would skip the viewer to the next episode before this one had
 * begun. With TMDB's runtime the check is against it; without one, anything
 * under ten minutes is taken for an advert. See `lengthVerdict`.
 */
export function isEpisodeEnd(reading: EndReading, expectedMinutes: number | null): boolean {
  const duration = reading.duration
  if (duration === null || !Number.isFinite(duration) || duration <= 0) return false
  if (lengthVerdict(duration, expectedMinutes) === 'implausible') return false
  return reading.ended || reading.seconds >= duration - END_WINDOW_SECONDS
}

/** Where the viewer is, for the controller to count on from. */
export interface UpNextPlace {
  tmdbId: number
  season: number
  episode: number
}

export interface UpNextDeps {
  /** Whether the owner's switch is on; read at each end, not captured. */
  enabled(): boolean
  /** The next aired episode after `place`; see `nextAiredEpisode`. */
  resolve(place: UpNextPlace): Promise<NextEpisode | null>
  /** Play it: here, or on the television when `onTv`. */
  advance(next: NextEpisode, onTv: boolean): void
}

/**
 * One move per end.
 *
 * `ended` is called on every reading that looks like the end, which is
 * several per end: the last polls, the video's own `ended`, the television's
 * FINISHED. Only the first counts. `reset` is for anything that moves the
 * viewer — opening a title, stepping episode by hand, closing — and makes the
 * next end count again; it also drops a move whose TMDB answer is still out.
 */
export class UpNextController {
  /** The episode whose end has been handled, by key, until `reset`. */
  private handled: string | null = null

  constructor(private readonly deps: UpNextDeps) {}

  async ended(place: UpNextPlace, onTv: boolean): Promise<void> {
    const key = `${place.tmdbId}:${place.season}:${place.episode}`
    if (this.handled === key || !this.deps.enabled()) return
    this.handled = key

    const next = await this.deps.resolve(place)
    // Moved on while TMDB answered: the end being handled is no longer this one.
    if (this.handled !== key || next === null) return
    this.deps.advance(next, onTv)
  }

  /** The viewer moved: a new episode, a new title, or the player closed. */
  reset(): void {
    this.handled = null
  }
}
