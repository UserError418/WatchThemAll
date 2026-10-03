/**
 * What a web page may ask the browser for, and what it gets.
 *
 * Electron grants every permission a page asks for unless the app installs a
 * handler: no prompt, nothing on screen. Measured 2026-10-03 with a page on
 * 127.0.0.1 and no handler: notifications, geolocation, microphone, camera
 * and reading the clipboard all came back "granted" (the microphone failed to
 * open only because that machine has no sound card). Until then the app set no
 * handler anywhere, so any source's page, or any advert inside one, could have
 * listened through the microphone or read whatever the user had copied.
 *
 * So every session starts closed, and each kind of page is given exactly what
 * it uses:
 *
 * - the app's own window: fullscreen for the trailers, and writing to the
 *   clipboard for the copy button beside Drive's sign-in code;
 * - everything else, which is a source's page (the player, the stream
 *   preview, the source tests): fullscreen only, in case a source's own
 *   button asks for it. Our controls never need anything from the page.
 *
 * Applied from `app.on('session-created')`, which reaches every partition the
 * moment it exists, so a new kind of surface cannot be added without it.
 */

import type { Session } from 'electron'

/** The permissions the app's own pages use. */
export const APP_PERMISSIONS: ReadonlySet<string> = new Set(['fullscreen', 'clipboard-sanitized-write'])

/** The permissions a source's page may have. */
export const SOURCE_PERMISSIONS: ReadonlySet<string> = new Set(['fullscreen'])

/**
 * Answer every permission request and check on `target` from `allowed`.
 *
 * Both handlers, because they are separate doors: the request handler answers
 * `getUserMedia`, `Notification.requestPermission` and the like, the check
 * handler answers `navigator.permissions.query` and the synchronous checks
 * Chromium makes before some features (device lists, the clipboard).
 */
export function restrictPermissions(target: Session, allowed: ReadonlySet<string>): void {
  target.setPermissionRequestHandler((_contents, permission, callback) => {
    const granted = allowed.has(permission)
    if (!granted) console.log(`[permissions] refused ${permission}`)
    callback(granted)
  })
  target.setPermissionCheckHandler((_contents, permission) => allowed.has(permission))
}
