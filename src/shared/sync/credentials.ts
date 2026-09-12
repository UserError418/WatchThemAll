/**
 * Where the OAuth client comes from, and why it is not in this file.
 *
 * The client secret for a device-flow app is not a secret in the usual sense —
 * Google's own documentation says that "since the applications that use this
 * flow are distributed to individual devices, it is assumed that the apps
 * cannot keep secrets", and anyone can read it out of a released binary. So the
 * argument for keeping it out of the repository is not confidentiality.
 *
 * It is that **GitHub scans public repositories for exactly this pattern and
 * Google is one of its scanning partners**, which can get a committed client
 * secret revoked automatically. A credential that stops working for every user
 * because it was pushed is a worse outcome than one extra build step.
 *
 * So the values are injected at build time from an untracked `.env`, and this
 * module is the single place that knows that. See `.env.example`.
 *
 * A fork that wants its own client — for its own quota, or because it does not
 * want to depend on ours — sets the same two variables and rebuilds. That works
 * *because* the device flow registers no redirect URI and no APK signing
 * fingerprint; there is nothing else to keep in step.
 */

import type { OAuthClient } from './types'

/**
 * Replaced at build time by both Vite configs.
 *
 * Declared as possibly-undefined rather than assumed present: a source build
 * without a `.env` is an ordinary situation, and it should disable sync with an
 * explanation rather than crash on startup with a ReferenceError.
 */
declare const __WTA_GOOGLE_CLIENT_ID__: string | undefined
declare const __WTA_GOOGLE_CLIENT_SECRET__: string | undefined

function defined(value: string | undefined): string | null {
  // The empty string is what an unset variable becomes after substitution, and
  // it is not a usable credential.
  return value === undefined || value === '' ? null : value
}

/**
 * The app's OAuth client, or `null` when this build has none.
 *
 * `null` is a supported state, not an error: the Settings screen says sync is
 * unavailable in this build and why, which is far more useful to somebody who
 * cloned the repo than a failed sign-in with a server error.
 */
export function oauthClient(): OAuthClient | null {
  const clientId = defined(
    typeof __WTA_GOOGLE_CLIENT_ID__ === 'string' ? __WTA_GOOGLE_CLIENT_ID__ : undefined,
  )
  const clientSecret = defined(
    typeof __WTA_GOOGLE_CLIENT_SECRET__ === 'string' ? __WTA_GOOGLE_CLIENT_SECRET__ : undefined,
  )

  if (clientId === null || clientSecret === null) return null
  return { clientId, clientSecret }
}

/** Why sync is unavailable, for the Settings screen. */
export const NO_CLIENT_REASON =
  'This build has no Google client configured, so sync is switched off. ' +
  'Copy .env.example to .env, fill in a client of type "TVs and Limited Input devices", and rebuild.'
