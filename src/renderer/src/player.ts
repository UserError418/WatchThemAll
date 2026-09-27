/**
 * Entry point for the `/__player` shell's own controls (v2).
 *
 * The shell is the player view's main frame, and the source plays in its
 * `#provider` iframe; see `player.html` and `PlayerOverlay.svelte`.
 */

import { mount } from 'svelte'
import PlayerOverlay from './player/PlayerOverlay.svelte'

const target = document.getElementById('overlay')
if (target === null) throw new Error('player.html is missing its mount point')

export default mount(PlayerOverlay, { target })
