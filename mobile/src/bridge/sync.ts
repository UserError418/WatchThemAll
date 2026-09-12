/**
 * Cross-device sync on the phone.
 *
 * Almost nothing here, and that is the point. The device flow, the Drive
 * backend, the merge and the coalescing are `@shared/sync` and `@shared/store`,
 * byte for byte the same modules the desktop runs. What this file supplies is
 * the two things that genuinely differ on Android: where the refresh token
 * lives, and how a link gets opened.
 *
 * That the sign-in code ports unchanged is not luck. It is the payoff of the
 * device flow having no redirect: there is no WebView for Google to refuse, no
 * Play-services plugin, and no APK signing fingerprint registered anywhere — so
 * a self-built or forked APK signs in exactly as the released one does.
 *
 * ## Where the token is kept, and the honest caveat
 *
 * Capacitor's Preferences API, which is Android `SharedPreferences` in the
 * app's private storage. That is readable by this app and by root, and it is
 * **not** the Android keystore: reaching the keystore needs native Kotlin, and
 * this project has no native module. On an unrooted device the private data
 * directory is the boundary, which is the same boundary the library file itself
 * sits behind — so the token is no less protected than the data it protects.
 *
 * `mobile/BACKLOG.md` carries this as the one real gap against the desktop,
 * which stores the same token in the OS credential store.
 */

import { Preferences } from '@capacitor/preferences'
import { Browser } from '@capacitor/browser'

import {
  DeviceFlowAbandoned,
  awaitAuthorization,
  isExpired,
  refreshAccessToken,
  requestDeviceCode,
} from '@shared/sync/devicecode'
import { NO_CLIENT_REASON, oauthClient } from '@shared/sync/credentials'
import { createDriveBackend, fetchAccountEmail } from '@shared/sync/drive'
import { SyncRunner, type SyncHost } from '@shared/sync/engine'
import type { OAuthTokens, StoredCredentials, SyncStatus } from '@shared/sync/types'

const TOKEN_KEY = 'sync.credentials'

async function readCredentials(): Promise<StoredCredentials | null> {
  const { value } = await Preferences.get({ key: TOKEN_KEY })
  if (value === null) return null
  try {
    return JSON.parse(value) as StoredCredentials
  } catch {
    // Unparseable is indistinguishable from absent for something this small,
    // and one sign-in beats a permanent error.
    await Preferences.remove({ key: TOKEN_KEY })
    return null
  }
}

export interface MobileSyncOptions {
  host: SyncHost
  onStatus: (status: SyncStatus) => void
}

/**
 * The same five verbs the desktop's `SyncService` exposes.
 *
 * Written as a factory rather than a class purely to match the shape of the
 * rest of this bridge, which is closures over a `Signal`.
 */
export function createMobileSync(options: MobileSyncOptions) {
  let credentials: StoredCredentials | null = null
  let access: OAuthTokens | null = null
  let runner: SyncRunner | null = null
  let pairing: AbortController | null = null

  let state: SyncStatus = {
    state: 'off',
    accountEmail: null,
    lastSyncedAt: null,
    error: oauthClient() === null ? NO_CLIENT_REASON : null,
    challenge: null,
  }

  const update = (patch: Partial<SyncStatus>): void => {
    state = { ...state, ...patch }
    options.onStatus({ ...state })
  }

  const accessToken = async (): Promise<string> => {
    const client = oauthClient()
    if (client === null) throw new Error(NO_CLIENT_REASON)
    if (credentials === null) throw new Error('Not signed in.')

    if (access !== null && !isExpired(access)) return access.accessToken

    const fresh = await refreshAccessToken(client, credentials.refreshToken)
    access = fresh
    // A refresh response usually omits the refresh token; keeping the old one
    // unless a new one actually arrives is what stops the app signing itself
    // out an hour later.
    credentials = {
      ...credentials,
      accessToken: fresh.accessToken,
      expiresAt: fresh.expiresAt,
      refreshToken: fresh.refreshToken ?? credentials.refreshToken,
    }
    await Preferences.set({ key: TOKEN_KEY, value: JSON.stringify(credentials) })
    return fresh.accessToken
  }

  const currentRunner = (): SyncRunner => {
    runner ??= new SyncRunner(options.host, createDriveBackend({ accessToken }))
    return runner
  }

  const now = async (): Promise<{ ok: boolean; error?: string }> => {
    if (credentials === null) return { ok: false, error: 'Not signed in.' }

    update({ state: 'syncing', error: null })
    try {
      const outcome = await currentRunner().request()
      update({ state: 'idle', lastSyncedAt: outcome.at, error: null })
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof DeviceFlowAbandoned) {
        await disconnect()
        update({ state: 'error', error: message })
        return { ok: false, error: message }
      }
      update({ state: 'error', error: message })
      return { ok: false, error: message }
    }
  }

  const disconnect = async (): Promise<void> => {
    pairing?.abort()
    credentials = null
    access = null
    runner = null
    await Preferences.remove({ key: TOKEN_KEY })
    update({ state: 'off', accountEmail: null, error: null, challenge: null })
  }

  return {
    /** Pick up a previous sign-in. Does not sync; the caller decides when. */
    async load(): Promise<void> {
      if (oauthClient() === null) return
      credentials = await readCredentials()
      if (credentials === null) return
      access = { accessToken: credentials.accessToken, expiresAt: credentials.expiresAt }
      update({ state: 'idle', accountEmail: credentials.accountEmail, error: null })
    },

    status: (): SyncStatus => ({ ...state }),

    async connect(): Promise<{ ok: boolean; error?: string }> {
      const client = oauthClient()
      if (client === null) return { ok: false, error: NO_CLIENT_REASON }
      if (state.state === 'pairing') return { ok: false, error: 'Already pairing.' }

      pairing = new AbortController()
      try {
        const challenge = await requestDeviceCode(client)
        update({
          state: 'pairing',
          error: null,
          challenge: {
            userCode: challenge.userCode,
            verificationUrl: challenge.verificationUrl,
            expiresAt: challenge.expiresAt,
          },
        })

        /**
         * Deliberately *not* opened automatically here.
         *
         * On the desktop the browser opens as a convenience. On a phone it
         * would replace the screen showing the code, which is the one thing the
         * user has to read — the code is on this device and has to be typed on
         * another one, or in a browser they can switch back from. The address
         * is on screen; `Browser` stays imported for the button that offers it.
         */
        void Browser

        const tokens = await awaitAuthorization(client, challenge, { signal: pairing.signal })
        if (tokens.refreshToken === undefined) {
          throw new Error('Google returned no refresh token; sync would stop working within the hour.')
        }

        access = tokens
        const accountEmail = await fetchAccountEmail(tokens.accessToken)
        credentials = {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          accountEmail,
        }
        await Preferences.set({ key: TOKEN_KEY, value: JSON.stringify(credentials) })

        update({ state: 'idle', accountEmail, challenge: null, error: null })
        await now()
        return { ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const abandoned = error instanceof DeviceFlowAbandoned
        update({
          state: abandoned ? 'off' : 'error',
          challenge: null,
          error: abandoned ? null : message,
        })
        return { ok: false, error: message }
      } finally {
        pairing = null
      }
    },

    cancel(): void {
      pairing?.abort()
    },

    disconnect,
    now,

    /** For the automatic triggers, where nobody is waiting and offline is normal. */
    soon(): void {
      if (credentials !== null) void now()
    },
  }
}
