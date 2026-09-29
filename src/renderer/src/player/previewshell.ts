/**
 * The player shell's preview mode: the detail view's stream preview on the
 * desktop, running inside a `<webview>` in the app's page.
 *
 * The page holding the webview decides everything that is seen; this only
 * drives the film (`PreviewFilm`) and reports it upward with
 * `ipcRenderer.sendToHost` (`PREVIEW_STATE`). The film starts muted, and the
 * page says straight away whether it should be (`PREVIEW_MUTED`), so the
 * first second of a preview can never be louder than the page asked for.
 */

import type { WtaPlayerApi } from '@shared/ipc'
import { FilmLink } from './filmlink'
import { PreviewFilm } from './previewfilm'

/** As often as the player asks its frames for a report. */
const HEARTBEAT_MS = 2_000

export function runPreviewShell(startSeconds: number): () => void {
  const api = (window as unknown as { wtaPlayer?: WtaPlayerApi }).wtaPlayer
  const frame = document.getElementById('provider') as HTMLIFrameElement | null
  if (!api?.preview || frame === null) return () => {}
  const preview = api.preview

  const link = new FilmLink((message) => frame.contentWindow?.postMessage(message, '*'))
  const film = new PreviewFilm(link, startSeconds, true)

  let last = ''
  const act = (): void => {
    const state = film.step()
    // The cover in `player.html` is for the player; the page does the
    // hiding here, and a started film should not sit behind it.
    if (state.started) document.getElementById('cover')?.remove()
    const report = JSON.stringify(state)
    if (report === last) return
    last = report
    preview.report(state)
  }

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow) return
    if (link.receive(event.data)) act()
  }
  window.addEventListener('message', onMessage)
  const stopMuted = preview.onMuted((muted) => {
    film.setMuted(muted)
    act()
  })
  const stopPaused = preview.onPaused((paused) => {
    film.setPaused(paused)
    act()
  })
  const stopSeek = preview.onSeek((seconds) => film.seekTo(seconds))
  link.watch()
  const heartbeat = setInterval(() => {
    link.watch()
    act()
  }, HEARTBEAT_MS)

  return () => {
    clearInterval(heartbeat)
    stopMuted()
    stopPaused()
    stopSeek()
    window.removeEventListener('message', onMessage)
  }
}
