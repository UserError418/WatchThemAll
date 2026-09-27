/**
 * Auto-next: at the end of an episode, count down five seconds and play the
 * next one, unless the viewer says otherwise.
 *
 * Asked for by the owner (2026-09-27): series only, never films; the next
 * episode of the season, then the first of the next season once it has aired;
 * nothing after the last aired episode. A countdown with Cancel rather than
 * an instant jump, and a Settings switch, on by default. It works the same in
 * the mini player and while casting, where the television is sent the next
 * episode when it finishes the current one.
 *
 * Both apps drive the same `UpNextController`: the desktop's main process and
 * the phone's bridge each feed it "this ended", and it tells them what to
 * show and when to move. The countdown itself lives here rather than in a
 * screen, because the screen that would show it may be the mini player, the
 * full chrome, or nothing at all while the phone is in a pocket.
 */

import type { EpisodeStub, Season } from '@shared/types'
import { localMidnight } from '@shared/aired'
import { lengthVerdict } from './runtimecheck'

/** How long the offer stands before the next episode starts. */
export const UP_NEXT_COUNTDOWN_MS = 5_000

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

/** What the screens show while the countdown runs. */
export interface UpNextOffer {
  season: number
  episode: number
  /** The episode's title, when TMDB has one. */
  name: string | null
  /** Epoch ms at which it plays by itself. */
  at: number
  /** True when it will be sent to the television, not played here. */
  onTv: boolean
}

/** Where the viewer is, for the controller to count on from. */
export interface UpNextPlace {
  tmdbId: number
  season: number
  episode: number
  /** How many seasons the series has, per TMDB. */
  seasonCount: number
}

export interface UpNextDeps {
  /** Whether the owner's switch is on; read at each end, not captured. */
  enabled(): boolean
  /** The next aired episode after `place`; see `nextAiredEpisode`. */
  resolve(place: UpNextPlace): Promise<NextEpisode | null>
  /** Show this offer, or take it down with null. */
  announce(offer: UpNextOffer | null): void
  /** Play it: here, or on the television when `onTv`. */
  advance(next: NextEpisode, onTv: boolean): void
  now?(): number
  setTimeout?(callback: () => void, ms: number): unknown
  clearTimeout?(handle: unknown): void
}

/**
 * One countdown at a time, and never twice for the same end.
 *
 * `ended` is called on every reading that looks like the end, which is
 * several per end: the last polls, the video's own `ended`, the television's
 * FINISHED. Only the first counts. `reset` is for anything that moves the
 * viewer — opening a title, stepping episode by hand, closing — and makes the
 * next end count again. `cancel` is the viewer saying no, and holds until the
 * episode changes, so the next poll of the same end does not start it again.
 */
export class UpNextController {
  private offer: UpNextOffer | null = null
  private timer: unknown = null
  /** The episode whose end has been handled, by key, until `reset`. */
  private handled: string | null = null
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly deps: UpNextDeps) {
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimeout ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer = deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  /** The offer on screen, for a screen that opens while one runs. */
  current(): UpNextOffer | null {
    return this.offer
  }

  async ended(place: UpNextPlace, onTv: boolean): Promise<void> {
    const key = `${place.tmdbId}:${place.season}:${place.episode}`
    if (this.handled === key || !this.deps.enabled()) return
    this.handled = key

    const next = await this.deps.resolve(place)
    // Moved on while TMDB answered: the end being handled is no longer this one.
    if (this.handled !== key || next === null) return

    this.offer = { ...next, at: this.now() + UP_NEXT_COUNTDOWN_MS, onTv }
    this.deps.announce(this.offer)
    this.timer = this.setTimer(() => this.playNow(), UP_NEXT_COUNTDOWN_MS)
  }

  /** "Play now", or the countdown running out. */
  playNow(): void {
    const offer = this.offer
    if (offer === null) return
    this.stop()
    this.deps.advance({ season: offer.season, episode: offer.episode, name: offer.name }, offer.onTv)
  }

  /** The viewer said no. This end stays handled; the next one counts. */
  cancel(): void {
    this.stop()
  }

  /** The viewer moved: a new episode, a new title, or the player closed. */
  reset(): void {
    this.stop()
    this.handled = null
  }

  private stop(): void {
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    if (this.offer !== null) {
      this.offer = null
      this.deps.announce(null)
    }
  }
}
