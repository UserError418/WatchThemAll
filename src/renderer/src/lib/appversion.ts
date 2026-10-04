/**
 * Which release this is, as Settings shows it.
 *
 * The version from `package.json`, written into the bundle at build time
 * (`__WTA_VERSION__`, defined by `electron.vite.config.ts` for the desktop's
 * renderer and by `mobile/vite.config.ts` for the phone): one number for both
 * ports, and the same one the desktop's About dialog reads from Electron. The
 * phone has no About dialog, so until Settings said it, nothing in the app
 * told the owner which release was installed there.
 *
 * Empty where nothing defined it (the unit tests), so a test never fails on a
 * missing global.
 */
declare const __WTA_VERSION__: string | undefined

export const APP_VERSION: string = typeof __WTA_VERSION__ === 'string' ? __WTA_VERSION__ : ''
