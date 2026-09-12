/**
 * Signing in the way a television does.
 *
 * The app shows a short code, the user types it at `google.com/device` on
 * whatever device is already signed in, and that is the whole ceremony. It is
 * the same OAuth 2.0 device flow that signs a TV into YouTube — not a lookalike
 * — and it is here because it is the only mechanism that meets all three of the
 * constraints in `docs/SYNC.md` at once: no server of ours, no per-app user
 * cap, and no redirect.
 *
 * That last one carries more weight than it looks. Having no redirect means:
 *
 * - no embedded WebView for Google to refuse,
 * - no Play-services plugin and no platform branch, so this file is literally
 *   the same code on the desktop and on the phone, and
 * - **no APK signing fingerprint registered anywhere**, so a fork or a
 *   self-built APK keeps working. Google's Android client type binds to a
 *   package name plus a SHA-1 and would break every one of them.
 *
 * Everything here is `fetch` and arithmetic. `fetchImpl` and `sleep` are
 * injected so the tests can drive the awkward sequences — a slow_down, an
 * expiry, a denial — that a real flow will not produce on demand.
 */

import type { DeviceCodeChallenge, OAuthClient, OAuthTokens } from './types'

const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

/**
 * The one scope this app asks for, and the reason the whole design works.
 *
 * `drive.file` grants access to *only the files this app itself creates*. It
 * cannot see, and cannot ask to see, anything else in the user's Drive. Google
 * classifies it **non-sensitive**, which is what exempts the app from
 * verification and from the 100-user cap that applies to sensitive and
 * restricted scopes.
 *
 * Adding any sensitive scope to this string would silently reintroduce both.
 *
 * ## Why not `drive.appdata`, which this used to be
 *
 * Because Google rejects it here. `drive.appdata` is a *hidden* per-app folder
 * and would have been the tidier choice — Google's own documentation for this
 * flow lists it among the permitted scopes — but the endpoint disagrees with
 * the documentation:
 *
 *     POST https://oauth2.googleapis.com/device/code
 *     scope=https://www.googleapis.com/auth/drive.appdata
 *     -> {"error":"invalid_scope",
 *         "error_description":"Invalid device flow scope: ...drive.appdata"}
 *
 * Measured against a real client of type "TVs and Limited Input devices", along
 * with `drive.appfolder` (same rejection) and `drive` (rejected as restricted).
 * `drive.file`, `email`, `profile`, `openid` and the YouTube scopes are
 * accepted. The permission boundary is the same one that mattered; the only
 * thing lost is that the file is visible in the user's Drive rather than
 * hidden, which is arguably the more honest arrangement anyway.
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'

/** Treat a token as expired this early, so a slow request cannot straddle it. */
export const TOKEN_SKEW_MS = 60_000

export type FetchLike = typeof fetch

export class DeviceFlowError extends Error {
  constructor(
    message: string,
    /** The OAuth error code, when the server gave one. */
    readonly code: string | null = null,
  ) {
    super(message)
    this.name = 'DeviceFlowError'
  }
}

/** The user cancelled at Google's end, or the code went unused for too long. */
export class DeviceFlowAbandoned extends DeviceFlowError {}

async function postForm(
  fetchImpl: FetchLike,
  url: string,
  fields: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })

  // A non-JSON body here means something upstream of Google answered — a
  // captive portal, a proxy. Saying so beats "unexpected token < in JSON".
  let body: Record<string, unknown>
  try {
    body = (await response.json()) as Record<string, unknown>
  } catch {
    throw new DeviceFlowError(`${url} answered ${response.status} with a body that is not JSON`)
  }
  return { status: response.status, body }
}

/** Ask Google for a code to put on screen. */
export async function requestDeviceCode(
  client: OAuthClient,
  fetchImpl: FetchLike = fetch,
  now = Date.now(),
): Promise<DeviceCodeChallenge> {
  const { status, body } = await postForm(fetchImpl, DEVICE_CODE_URL, {
    client_id: client.clientId,
    scope: DRIVE_SCOPE,
  })

  if (status !== 200) {
    throw new DeviceFlowError(
      `Google refused to start sign-in: ${String(body.error_description ?? body.error ?? status)}`,
      typeof body.error === 'string' ? body.error : null,
    )
  }

  return {
    userCode: String(body.user_code),
    // `verification_url` is Google's spelling; the RFC says `verification_uri`.
    // Accepting both costs one `??` and survives them aligning with the RFC.
    verificationUrl: String(body.verification_url ?? body.verification_uri),
    deviceCode: String(body.device_code),
    expiresAt: now + Number(body.expires_in ?? 1800) * 1000,
    intervalSeconds: Number(body.interval ?? 5),
  }
}

/**
 * One poll. Returns tokens, or `null` meaning "keep waiting".
 *
 * Split out from the loop so the interesting decision — which server answers
 * are worth retrying — can be tested without a clock.
 */
export async function pollOnce(
  client: OAuthClient,
  deviceCode: string,
  fetchImpl: FetchLike = fetch,
  now = Date.now(),
): Promise<{ tokens: OAuthTokens } | { retryAfterExtraSeconds: number }> {
  const { status, body } = await postForm(fetchImpl, TOKEN_URL, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  })

  if (status === 200) {
    return {
      tokens: {
        accessToken: String(body.access_token),
        refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
        expiresAt: now + Number(body.expires_in ?? 3600) * 1000,
      },
    }
  }

  const code = typeof body.error === 'string' ? body.error : null
  switch (code) {
    case 'authorization_pending':
      return { retryAfterExtraSeconds: 0 }
    case 'slow_down':
      // The server is telling us we are too eager. The spec's remedy is to add
      // five seconds to the interval and keep it there.
      return { retryAfterExtraSeconds: 5 }
    case 'access_denied':
      throw new DeviceFlowAbandoned('Sign-in was declined.', code)
    case 'expired_token':
      throw new DeviceFlowAbandoned('The code expired before it was entered.', code)
    default:
      throw new DeviceFlowError(
        `Sign-in failed: ${String(body.error_description ?? code ?? status)}`,
        code,
      )
  }
}

export interface PollOptions {
  fetchImpl?: FetchLike
  /** Injected so tests do not wait, and so a caller can cancel. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  signal?: AbortSignal
}

/**
 * Poll until the user finishes, gives up, or the code dies.
 *
 * The interval only ever grows — a `slow_down` is permanent for the rest of the
 * attempt. Backing off and then speeding up again invites the same rebuke a
 * second time, and there is nothing to gain: the user is typing at human speed
 * either way.
 */
export async function awaitAuthorization(
  client: OAuthClient,
  challenge: DeviceCodeChallenge,
  options: PollOptions = {},
): Promise<OAuthTokens> {
  const {
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    signal,
  } = options

  let intervalSeconds = challenge.intervalSeconds

  for (;;) {
    if (signal?.aborted) throw new DeviceFlowAbandoned('Sign-in was cancelled.')
    if (now() >= challenge.expiresAt) {
      throw new DeviceFlowAbandoned('The code expired before it was entered.', 'expired_token')
    }

    await sleep(intervalSeconds * 1000)
    if (signal?.aborted) throw new DeviceFlowAbandoned('Sign-in was cancelled.')

    const result = await pollOnce(client, challenge.deviceCode, fetchImpl, now())
    if ('tokens' in result) return result.tokens
    intervalSeconds += result.retryAfterExtraSeconds
  }
}

/**
 * Trade a refresh token for a fresh access token.
 *
 * Refresh tokens do not expire on their own once the consent screen is in
 * **Production**. In "Testing" they die after seven days and sync would quietly
 * stop working every week — which is why `docs/SYNC.md` insists on Production
 * and why that is not a detail to leave to whoever sets up the project.
 */
export async function refreshAccessToken(
  client: OAuthClient,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
  now = Date.now(),
): Promise<OAuthTokens> {
  const { status, body } = await postForm(fetchImpl, TOKEN_URL, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })

  if (status !== 200) {
    const code = typeof body.error === 'string' ? body.error : null
    // `invalid_grant` means the user revoked access, or Google did. There is no
    // retry for it — the app has to ask to be paired again — so it is raised as
    // abandonment rather than as a transient failure.
    if (code === 'invalid_grant') {
      throw new DeviceFlowAbandoned('Access was revoked; sign in again to resume syncing.', code)
    }
    throw new DeviceFlowError(
      `Could not refresh access: ${String(body.error_description ?? code ?? status)}`,
      code,
    )
  }

  return {
    accessToken: String(body.access_token),
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresAt: now + Number(body.expires_in ?? 3600) * 1000,
  }
}

/** Whether a token is close enough to expiry that it should be replaced first. */
export function isExpired(tokens: OAuthTokens, now = Date.now()): boolean {
  return now >= tokens.expiresAt - TOKEN_SKEW_MS
}
