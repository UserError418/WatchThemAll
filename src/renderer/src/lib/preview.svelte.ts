/**
 * Which preview surface currently owns the sound.
 *
 * Previews became audible by default, and that turns an ordering question into
 * an audible bug: the browse billboard starts its trailer 2.6s after the page
 * settles, and a card hovered a moment later starts its own. Both are playing,
 * both are unmuted, and the user hears two soundtracks over each other.
 *
 * The rule is deliberately the simplest one that is still correct: **the most
 * recent preview to start owns the sound, and everything else mutes itself.**
 * When the owner stops, ownership is released and any preview still running can
 * take it — which is what lets the billboard come back after the pointer leaves
 * a card, without either surface knowing the other exists.
 *
 * Muting rather than pausing is the point. A muted trailer keeps playing, so
 * moving off a card does not restart the billboard from frame one.
 */
class PreviewAudio {
  /** The id of the surface currently allowed to make noise, or null. */
  owner = $state<string | null>(null)

  /** Take the sound. Always succeeds — the newest preview is the one the user is looking at. */
  claim(id: string): void {
    this.owner = id
  }

  /**
   * Give it up.
   *
   * A no-op unless the caller actually holds it, so a surface stopping after it
   * has already been superseded cannot silence the one that took over.
   */
  release(id: string): void {
    if (this.owner === id) this.owner = null
  }

  /** Whether this surface may play with sound right now. */
  holds(id: string): boolean {
    return this.owner === id
  }

  /** True when nothing holds the sound, so a running preview may take it. */
  get free(): boolean {
    return this.owner === null
  }
  /**
   * Previews are suspended entirely while something is actually playing.
   *
   * Not muted — stopped. A trailer that keeps running behind the player is not
   * a volume problem the user can solve, because the surface playing it is no
   * longer on screen: there is nothing to move the pointer off and nothing to
   * click. It just plays, forever, under the film.
   *
   * A single flag rather than each surface listening for a player event,
   * because the surfaces that need to stop are the ones the user has already
   * navigated away from, and those are exactly the ones not thinking about
   * playback.
   */
  suspended = $state(false)

  /** Called when playback starts, and again when it ends. */
  setSuspended(value: boolean): void {
    this.suspended = value
    if (value) this.owner = null
  }
}

export const previewAudio = new PreviewAudio()

/** Distinct ids per component instance, so two cards never collide. */
let counter = 0
export function previewId(surface: string): string {
  counter += 1
  return `${surface}-${counter}`
}
