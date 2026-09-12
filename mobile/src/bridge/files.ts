/**
 * Getting files in and out of the app on a phone.
 *
 * The desktop app uses Electron's native dialogs. Android has no equivalent the
 * WebView can call, so both directions go through platform affordances instead:
 * a hidden `<input type="file">` for reading — Android WebView routes it to the
 * system document picker, which is the same chooser the user sees everywhere
 * else — and a written file plus the share sheet for writing, because an app
 * cannot drop a file into shared storage on modern Android without either the
 * Storage Access Framework or a permission the user would rightly refuse.
 */

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

/**
 * Ask the user for one file and return its text.
 *
 * Null when they cancelled, which is a normal outcome and not an error — the
 * desktop dialogs report cancellation the same way and the callers already
 * handle it.
 *
 * The input is created per call and removed afterwards rather than kept in the
 * document. A persistent hidden input holds on to the last chosen file, and the
 * second import of the same session then silently re-reads the first file if
 * the user cancels.
 */
export function pickTextFile(accept: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'

    const done = (value: string | null): void => {
      input.remove()
      resolve(value)
    }

    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return done(null)
      file
        .text()
        .then(done)
        .catch((err) => {
          console.error('[files] could not read the chosen file:', err)
          done(null)
        })
    })

    /**
     * Cancellation has no reliable event in an Android WebView.
     *
     * `cancel` on file inputs is recent and not dispatched by every WebView
     * build, so the promise is also settled when the window regains focus with
     * no file chosen. Without this an aborted picker leaves the caller awaiting
     * forever, and the MAL import dialog sits on a spinner with no way out.
     */
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => {
          if (input.isConnected && !input.files?.length) done(null)
        }, 600)
      },
      { once: true },
    )

    document.body.append(input)
    input.click()
  })
}

/**
 * Write a file into app storage and offer it to the share sheet.
 *
 * Cache rather than Data: this copy exists to be handed to another app, and
 * leaving successive exports in permanent storage would accumulate the user's
 * whole library once per export with nothing ever cleaning them up.
 */
export async function shareTextFile(
  name: string,
  contents: string,
  title: string,
): Promise<void> {
  await Filesystem.writeFile({
    path: name,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
    data: contents,
  })
  const { uri } = await Filesystem.getUri({ path: name, directory: Directory.Cache })
  await Share.share({ title, url: uri, dialogTitle: title })
}
