/**
 * Sync, as the rest of the desktop app sees it.
 *
 * Five verbs and a status. Everything underneath — the device flow, the Drive
 * backend, the merge, the coalescing — is in `@shared/sync` and `@shared/store`
 * and is shared with the phone. What is here is the part that is genuinely
 * about *this* process: the OS credential store, the access-token lifecycle,
 * and turning all of it into one status object a Svelte component can render.
 *
 * ## Where the access token is kept, and where it is not
 *
 * In memory, refreshed on demand, never handed to the renderer. The renderer
 * has no reason to hold a Google credential and every reason not to: it runs
 * third-party artwork and its own bugs, and a token that never crosses the IPC
 * boundary cannot leak across it.
 */

import { shell } from 'electron'

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

import type { TokenStore } from './synctokens'

export interface SyncServiceOptions {
  host: SyncHost
  tokens: TokenStore
  /** Called whenever the status changes, so main can push it to the renderer. */
  onStatus: (status: SyncStatus) => void
}

export class SyncService {
  private credentials: StoredCredentials | null = null
  private access: OAuthTokens | null = null
  private runner: SyncRunner | null = null
  private pairing: AbortController | null = null

  private state: SyncStatus = {
    state: 'off',
    accountEmail: null,
    lastSyncedAt: null,
    error: null,
    challenge: null,
  }

  constructor(private readonly options: SyncServiceOptions) {}

  status(): SyncStatus {
    return { ...this.state }
  }

  private update(patch: Partial<SyncStatus>): void {
    this.state = { ...this.state, ...patch }
    this.options.onStatus(this.status())
  }

  /**
   * Pick up a previous sign-in, if there is one.
   *
   * Deliberately does not sync. Startup has enough to do, and a sync that runs
   * before the window is up delays the thing the user is waiting for to no
   * benefit — `syncSoon` is called once the app is actually usable.
   */
  async load(): Promise<void> {
    if (oauthClient() === null) {
      this.update({ state: 'off', error: NO_CLIENT_REASON })
      return
    }

    this.credentials = await this.options.tokens.read()
    if (this.credentials === null) {
      this.update({ state: 'off', error: null })
      return
    }

    this.access = { accessToken: this.credentials.accessToken, expiresAt: this.credentials.expiresAt }
    this.update({ state: 'idle', accountEmail: this.credentials.accountEmail, error: null })
  }

  /**
   * A valid access token, refreshed if it is close to expiry.
   *
   * The refresh response usually omits the refresh token, so the stored one is
   * kept unless a new one actually arrives — writing `undefined` over it would
   * sign the user out on the next launch, silently and an hour later.
   */
  private async accessToken(): Promise<string> {
    const client = oauthClient()
    if (client === null) throw new Error(NO_CLIENT_REASON)
    if (this.credentials === null) throw new Error('Not signed in.')

    if (this.access !== null && !isExpired(this.access)) return this.access.accessToken

    const fresh = await refreshAccessToken(client, this.credentials.refreshToken)
    this.access = fresh
    this.credentials = {
      ...this.credentials,
      accessToken: fresh.accessToken,
      expiresAt: fresh.expiresAt,
      refreshToken: fresh.refreshToken ?? this.credentials.refreshToken,
    }
    await this.options.tokens.write(this.credentials)
    return fresh.accessToken
  }

  private backendRunner(): SyncRunner {
    this.runner ??= new SyncRunner(
      this.options.host,
      createDriveBackend({ accessToken: () => this.accessToken() }),
    )
    return this.runner
  }

  /**
   * Pair this device.
   *
   * Resolves only when the user has finished at Google, declined, or let the
   * code expire — which can be minutes. The code itself reaches the screen long
   * before that, through the status event, so nothing is waiting on this
   * promise except the caller that wants to know how it ended.
   */
  async connect(): Promise<{ ok: boolean; error?: string }> {
    const client = oauthClient()
    if (client === null) return { ok: false, error: NO_CLIENT_REASON }
    if (this.state.state === 'pairing') return { ok: false, error: 'Already pairing.' }

    this.pairing = new AbortController()

    try {
      const challenge = await requestDeviceCode(client)
      this.update({
        state: 'pairing',
        error: null,
        challenge: {
          userCode: challenge.userCode,
          verificationUrl: challenge.verificationUrl,
          expiresAt: challenge.expiresAt,
        },
      })

      // Opening the page is a convenience, not the mechanism: the whole point
      // of this flow is that the user can type the code on a *different*
      // device. A failure to launch a browser must not fail the pairing.
      void shell.openExternal(challenge.verificationUrl).catch(() => undefined)

      const tokens = await awaitAuthorization(client, challenge, { signal: this.pairing.signal })
      if (tokens.refreshToken === undefined) {
        throw new Error('Google returned no refresh token; sync would stop working within the hour.')
      }

      this.access = tokens
      const accountEmail = await fetchAccountEmail(tokens.accessToken)
      this.credentials = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        accountEmail,
      }
      await this.options.tokens.write(this.credentials)

      this.update({ state: 'idle', accountEmail, challenge: null, error: null })
      await this.now()
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Abandonment is the user's decision, not a fault, so it returns the app
      // to plain "off" rather than lighting up an error the user has to dismiss.
      const abandoned = error instanceof DeviceFlowAbandoned
      this.update({
        state: abandoned ? 'off' : 'error',
        challenge: null,
        error: abandoned ? null : message,
      })
      return { ok: false, error: message }
    } finally {
      this.pairing = null
    }
  }

  cancel(): void {
    this.pairing?.abort()
  }

  async disconnect(): Promise<void> {
    this.cancel()
    this.credentials = null
    this.access = null
    this.runner = null
    await this.options.tokens.clear()
    this.update({ state: 'off', accountEmail: null, error: null, challenge: null })
  }

  /** Sync now. Safe to call from several triggers at once; the runner coalesces. */
  async now(): Promise<{ ok: boolean; error?: string }> {
    if (this.credentials === null) return { ok: false, error: 'Not signed in.' }

    this.update({ state: 'syncing', error: null })
    try {
      const outcome = await this.backendRunner().request()
      this.update({ state: 'idle', lastSyncedAt: outcome.at, error: null })
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      /**
       * A revoked grant is not a transient failure.
       *
       * Retrying it forever would burn the token endpoint and leave the user
       * looking at a spinner that can never finish, so the account is dropped
       * and the screen asks them to sign in again.
       */
      if (error instanceof DeviceFlowAbandoned) {
        await this.disconnect()
        this.update({ state: 'error', error: message })
        return { ok: false, error: message }
      }

      this.update({ state: 'error', error: message })
      return { ok: false, error: message }
    }
  }

  /**
   * Sync in the background, swallowing failures.
   *
   * For the automatic triggers — launch, focus, a settled write — where there
   * is no user waiting and being offline is normal. The status still records
   * the error; it just does not interrupt anybody.
   */
  syncSoon(): void {
    if (this.credentials === null) return
    void this.now()
  }
}
