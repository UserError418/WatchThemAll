/**
 * What a player action does on the phone.
 *
 * On the desktop the main process routes them (`InlinePlayer.action`): the
 * transport ones to our overlay, which plays, seeks and sets the volume
 * itself, and the rest to the player around it. On the phone,
 * `wta.player.action` did nothing at all, while `PlayerFrame` still took every
 * player key it recognised off the page (`preventDefault`), so a keyboard, a
 * remote or DeX had no player keys, and the overlay's own keys none of the
 * transport ones.
 */

import { isTransportAction, type PlayerAction, type TransportAction } from '@shared/playerkeys'

export interface PlayerActionHandlers {
  transport(action: TransportAction): void
  fullscreen(): void
  openPanel(panel: 'episodes' | 'sources' | 'cast'): void
  /** Into the mini player, as the chrome's ← does. */
  shrink(): void
  reload(): void
}

/**
 * Carry out `action`. `from` says who asked: our overlay, or a key on the page
 * (`PlayerFrame`). Back and Escape from a key are left to Android's back
 * button, which already takes the player down one layer at a time, and which
 * closes our controls' menu by dispatching an Escape on the window. That
 * Escape reaches `PlayerFrame` too, and acting on it there would shrink the
 * player under the menu being closed.
 */
export function routePlayerAction(action: PlayerAction, from: 'overlay' | 'keys', handlers: PlayerActionHandlers): void {
  if (isTransportAction(action)) {
    handlers.transport(action)
    return
  }
  switch (action) {
    case 'fullscreen':
      handlers.fullscreen()
      return
    case 'episodes':
    case 'sources':
    case 'cast':
      handlers.openPanel(action)
      return
    case 'back':
    case 'escape':
      if (from === 'overlay') handlers.shrink()
      return
    case 'reload':
      handlers.reload()
      return
  }
}
