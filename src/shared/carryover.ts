/**
 * Resume, carried over from the preview (the owner, 2026-09-28).
 *
 * When the detail view's stream preview is on screen and Resume is pressed,
 * the preview does not stop: it grows to fill the player's place and keeps
 * playing, with sound, while the real player loads behind it, hidden and
 * silent ("held"). When the real player's film is playing at the preview's
 * live second, the player is shown and the preview goes. So Resume shows the
 * film at once, where it was, instead of a black screen for the seconds the
 * source's page takes to start.
 *
 * Agreed costs: for those seconds there are no player controls (pause and
 * mute still work, on the preview), the stream is fetched twice, and the
 * swap may repeat or skip about a second (`CARRY_TOLERANCE_S`).
 *
 * Sharing the preview's cache with the player was measured first (2.0.2) and
 * saved nothing: the time goes into the source's page starting its own
 * player, not into the video bytes. Hence this.
 *
 * This module is the decision alone, the same on both platforms: given where
 * the preview is and where the held player's film is, wait, move the film,
 * or let the player be seen. Main (`playerview.ts`) and the phone's bridge
 * do the hiding, the seeking and the showing.
 */

/** Where the preview was when it last said, by the receiver's clock. */
export interface CarriedPlace {
  seconds: number
  paused: boolean
  /** The preview's sound was off: the player starts muted too. */
  muted: boolean
  /** When this was heard, epoch ms. */
  at: number
}

/** The held player's film, as last read. */
export interface HeldFilm {
  seconds: number
  duration: number
  playing: boolean
  /** Buffering, where the reader can tell (the film relay can; the desktop's poll cannot). */
  waiting?: boolean
}

export type CarryMove = { kind: 'wait' } | { kind: 'seek'; to: number } | { kind: 'release' }

/** Near enough to swap: a second repeated or skipped, as agreed. */
export const CARRY_TOLERANCE_S = 1
/**
 * Aimed this far past the preview's second, because the preview keeps
 * playing while the film seeks and buffers.
 */
export const CARRY_SEEK_LEAD_S = 0.6
/** Time for a seek to land and the film to report from there. */
export const CARRY_SEEK_SETTLE_MS = 1_500
/** Seeks tried before the player is shown wherever its film is. */
export const CARRY_MAX_SEEKS = 3
/**
 * The longest the preview stands in. A source slower than this would keep
 * the viewer on a picture without controls; the player is shown instead,
 * loading as it would have without the preview.
 */
export const CARRY_GIVE_UP_MS = 15_000
/** Shorter than any episode and longer than any advert (`PLAY_MIN_FILM_SECONDS`). */
const MIN_FILM_SECONDS = 120

export class CarryOver {
  private place: CarriedPlace | null = null
  /** The reading before this one, to see the film move; forgotten across a seek. */
  private previous: { seconds: number; at: number } | null = null
  private seeks = 0
  private lastSeekAt = Number.NEGATIVE_INFINITY
  private released = false

  constructor(private readonly openedAt: number) {}

  /** The preview reported where it is. */
  update(place: CarriedPlace): void {
    this.place = place
  }

  /** What the player should start as when it is shown: paused or not, muted or not. */
  last(): CarriedPlace | null {
    return this.place
  }

  /** Where the preview is now, projected from its last report. */
  target(now: number): number | null {
    if (this.place === null) return null
    return this.place.paused ? this.place.seconds : this.place.seconds + (now - this.place.at) / 1000
  }

  /**
   * Act on the held player's film. Call on every reading of it; each call
   * asks for at most one thing. Once it has said `release`, it keeps saying
   * so.
   */
  step(film: HeldFilm | null, now: number): CarryMove {
    if (this.released) return { kind: 'release' }
    if (now - this.openedAt >= CARRY_GIVE_UP_MS) return this.release()
    // Not the film yet (nothing, an advert, loaded and not playing, or buffering).
    if (film === null || film.duration < MIN_FILM_SECONDS || !film.playing || film.waiting) {
      this.previous = null
      return { kind: 'wait' }
    }
    /*
     * Shown only while its time is seen moving, not merely at the right
     * second: straight after a seek the film reports the new second while it
     * is still buffering there, and the source's own poster is what would be
     * on screen (measured on the phone, VidRock, 2026-09-29).
     */
    const before = this.previous
    this.previous = { seconds: film.seconds, at: now }
    const moving = before !== null && film.seconds - before.seconds > 0.2 && film.seconds - before.seconds < (now - before.at) / 1000 + 2
    const target = this.target(now)
    // No word from the preview: the film playing is all there is to wait for.
    if (target === null) return moving ? this.release() : { kind: 'wait' }
    if (Math.abs(film.seconds - target) <= CARRY_TOLERANCE_S) return moving ? this.release() : { kind: 'wait' }
    if (now - this.lastSeekAt < CARRY_SEEK_SETTLE_MS) return { kind: 'wait' }
    if (this.seeks >= CARRY_MAX_SEEKS) return this.release()
    this.seeks += 1
    this.lastSeekAt = now
    this.previous = null
    return { kind: 'seek', to: target + (this.place?.paused ? 0 : CARRY_SEEK_LEAD_S) }
  }

  /** The player is being shown now, whatever the film says: a key, a tap, the preview gone. */
  release(): CarryMove {
    this.released = true
    return { kind: 'release' }
  }

  get done(): boolean {
    return this.released
  }
}
