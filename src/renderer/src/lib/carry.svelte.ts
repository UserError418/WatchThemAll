/**
 * Whether the detail view's preview is standing in for the player: Resume
 * carried over (`shared/carryover.ts`). While it does, the player is held
 * out of sight behind it, and whatever the page draws for the player must
 * let the preview show through.
 *
 * One flag the detail view sets and the player's frame reads, as
 * `previewAudio` is for the sound.
 */
class CarryState {
  active = $state(false)
}

export const carrying = new CarryState()
