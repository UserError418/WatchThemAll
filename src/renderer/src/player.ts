/**
 * Entry point for the `/__player` shell's own controls (v2).
 *
 * The shell is the player view's main frame, and the source plays in its
 * `#provider` iframe; see `player.html` and `PlayerOverlay.svelte`.
 *
 * With `?preview=1` it is the detail view's stream preview instead, inside a
 * `<webview>` in the app's page: none of our controls, only `PreviewFilm`
 * driving the film and reporting to the page (`player/previewshell.ts`).
 */

import { mount } from 'svelte'
import PlayerOverlay from './player/PlayerOverlay.svelte'
import { runPreviewShell } from './player/previewshell'

const params = new URLSearchParams(location.search)
const target = document.getElementById('overlay')
if (target === null) throw new Error('player.html is missing its mount point')

export default params.get('preview') === '1'
  ? runPreviewShell(Number(params.get('start')) || 0)
  : mount(PlayerOverlay, { target })
