/**
 * The sign-in sequences that only happen to somebody else.
 *
 * A device flow is almost all error handling, and none of the interesting
 * branches can be produced on demand against the real endpoint: you cannot ask
 * Google for a `slow_down`, and waiting out an `expired_token` takes half an
 * hour. So `fetch`, the clock and the sleep are all injected, and every branch
 * gets driven directly.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  DRIVE_SCOPE,
  DeviceFlowAbandoned,
  DeviceFlowError,
  NetworkUnreachable,
  awaitAuthorization,
  isExpired,
  pollOnce,
  refreshAccessToken,
  requestDeviceCode,
  type FetchLike,
} from './devicecode'
import type { OAuthClient } from './types'

const CLIENT: OAuthClient = { clientId: 'client-id', clientSecret: 'client-secret' }

/** A `fetch` that answers a scripted queue, and records what it was asked. */
function scriptedFetch(
  script: { status: number; body: unknown }[],
): { fetchImpl: FetchLike; calls: { url: string; fields: URLSearchParams }[] } {
  const calls: { url: string; fields: URLSearchParams }[] = []
  let index = 0

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), fields: new URLSearchParams(String(init?.body ?? '')) })
    const next = script[Math.min(index++, script.length - 1)]
    if (next === undefined) throw new Error('scripted fetch ran out of answers')
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      json: async () => next.body,
    } as Response
  }) as FetchLike

  return { fetchImpl, calls }
}

describe('asking for a code', () => {
  it('requests exactly one scope, and it is the non-sensitive one', async () => {
    // The whole design rests on this string. Any additional scope — even one
    // that looks harmless — makes the app verification-bound and reinstates the
    // 100-user cap, silently and at user 101.
    const { fetchImpl, calls } = scriptedFetch([
      {
        status: 200,
        body: {
          device_code: 'dc',
          user_code: 'WDJB-MJHT',
          verification_url: 'https://www.google.com/device',
          expires_in: 1800,
          interval: 5,
        },
      },
    ])

    await requestDeviceCode(CLIENT, fetchImpl, 1_000)
    expect(calls[0]?.fields.get('scope')).toBe(DRIVE_SCOPE)
    // Pinned to the literal, because this is also the one string the device
    // endpoint is fussy about: `drive.appdata` is documented as permitted here
    // and is rejected in practice. See the note in `devicecode.ts`.
    expect(DRIVE_SCOPE).toBe('https://www.googleapis.com/auth/drive.file')
  })

  it('never sends the client secret when asking for a code', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { status: 200, body: { device_code: 'dc', user_code: 'X', verification_url: 'u' } },
    ])
    await requestDeviceCode(CLIENT, fetchImpl, 0)
    expect(calls[0]?.fields.get('client_secret')).toBeNull()
  })

  it('turns expires_in into a deadline on our clock', async () => {
    const { fetchImpl } = scriptedFetch([
      {
        status: 200,
        body: { device_code: 'dc', user_code: 'X', verification_url: 'u', expires_in: 600 },
      },
    ])
    const challenge = await requestDeviceCode(CLIENT, fetchImpl, 10_000)
    expect(challenge.expiresAt).toBe(10_000 + 600_000)
  })

  it('accepts the RFC spelling of the verification URL as well as Google\'s', async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 200, body: { device_code: 'dc', user_code: 'X', verification_uri: 'rfc-url' } },
    ])
    expect((await requestDeviceCode(CLIENT, fetchImpl, 0)).verificationUrl).toBe('rfc-url')
  })

  it('reports what the server said when it refuses', async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 403, body: { error: 'access_denied', error_description: 'Client is disabled' } },
    ])
    await expect(requestDeviceCode(CLIENT, fetchImpl, 0)).rejects.toThrow(/Client is disabled/)
  })

  it('says so plainly when something that is not Google answers', async () => {
    // A captive portal or a proxy. "Unexpected token < in JSON" helps nobody.
    const fetchImpl = (async () =>
      ({
        status: 200,
        ok: true,
        json: async () => {
          throw new Error('not json')
        },
      }) as unknown as Response) as FetchLike

    await expect(requestDeviceCode(CLIENT, fetchImpl, 0)).rejects.toThrow(/not JSON/)
  })
})

describe('polling', () => {
  it('keeps waiting while the user has not finished', async () => {
    const { fetchImpl } = scriptedFetch([{ status: 428, body: { error: 'authorization_pending' } }])
    expect(await pollOnce(CLIENT, 'dc', fetchImpl, 0)).toEqual({ retryAfterExtraSeconds: 0 })
  })

  it('slows down permanently when told to', async () => {
    const { fetchImpl } = scriptedFetch([{ status: 403, body: { error: 'slow_down' } }])
    expect(await pollOnce(CLIENT, 'dc', fetchImpl, 0)).toEqual({ retryAfterExtraSeconds: 5 })
  })

  it('gives up when the user declines', async () => {
    const { fetchImpl } = scriptedFetch([{ status: 403, body: { error: 'access_denied' } }])
    await expect(pollOnce(CLIENT, 'dc', fetchImpl, 0)).rejects.toBeInstanceOf(DeviceFlowAbandoned)
  })

  it('gives up when the code expires', async () => {
    const { fetchImpl } = scriptedFetch([{ status: 400, body: { error: 'expired_token' } }])
    await expect(pollOnce(CLIENT, 'dc', fetchImpl, 0)).rejects.toBeInstanceOf(DeviceFlowAbandoned)
  })

  it('treats an unrecognised error as a failure rather than as patience', async () => {
    // The dangerous default would be "keep polling", which turns one unexpected
    // response into an infinite loop against Google's token endpoint.
    const { fetchImpl } = scriptedFetch([{ status: 500, body: { error: 'internal' } }])
    const failure = pollOnce(CLIENT, 'dc', fetchImpl, 0)
    await expect(failure).rejects.toBeInstanceOf(DeviceFlowError)
    await expect(failure).rejects.not.toBeInstanceOf(DeviceFlowAbandoned)
  })

  it('returns tokens with a deadline on our clock', async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3599 } },
    ])
    const result = await pollOnce(CLIENT, 'dc', fetchImpl, 5_000)
    expect(result).toEqual({
      tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: 5_000 + 3_599_000 },
    })
  })
})

describe('waiting for the user', () => {
  const challenge = {
    userCode: 'WDJB-MJHT',
    verificationUrl: 'https://www.google.com/device',
    deviceCode: 'dc',
    expiresAt: 1_000_000,
    intervalSeconds: 5,
  }

  it('polls until the user finishes', async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 428, body: { error: 'authorization_pending' } },
      { status: 428, body: { error: 'authorization_pending' } },
      { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } },
    ])
    const sleep = vi.fn(async () => undefined)

    const tokens = await awaitAuthorization(CLIENT, challenge, {
      fetchImpl,
      sleep,
      now: () => 0,
    })

    expect(tokens.accessToken).toBe('at')
    expect(sleep).toHaveBeenCalledTimes(3)
  })

  it('widens the interval after a slow_down and never narrows it again', async () => {
    const { fetchImpl } = scriptedFetch([
      { status: 403, body: { error: 'slow_down' } },
      { status: 428, body: { error: 'authorization_pending' } },
      { status: 200, body: { access_token: 'at', expires_in: 3600 } },
    ])
    const waits: number[] = []

    await awaitAuthorization(CLIENT, challenge, {
      fetchImpl,
      sleep: async (ms) => void waits.push(ms),
      now: () => 0,
    })

    // Backing off and then speeding up again invites the same rebuke, and buys
    // nothing: the user types at human speed regardless.
    expect(waits).toEqual([5_000, 10_000, 10_000])
  })

  it('stops once the code is past its deadline', async () => {
    const { fetchImpl } = scriptedFetch([{ status: 428, body: { error: 'authorization_pending' } }])
    const attempt = awaitAuthorization(CLIENT, challenge, {
      fetchImpl,
      sleep: async () => undefined,
      now: () => challenge.expiresAt + 1,
    })
    await expect(attempt).rejects.toBeInstanceOf(DeviceFlowAbandoned)
  })

  it('can be cancelled', async () => {
    const { fetchImpl } = scriptedFetch([{ status: 428, body: { error: 'authorization_pending' } }])
    const controller = new AbortController()
    controller.abort()

    const attempt = awaitAuthorization(CLIENT, challenge, {
      fetchImpl,
      sleep: async () => undefined,
      now: () => 0,
      signal: controller.signal,
    })
    await expect(attempt).rejects.toBeInstanceOf(DeviceFlowAbandoned)
  })
})

describe('refreshing', () => {
  it('exchanges a refresh token for a new access token', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { status: 200, body: { access_token: 'fresh', expires_in: 3600 } },
    ])
    const tokens = await refreshAccessToken(CLIENT, 'rt', fetchImpl, 1_000)

    expect(tokens.accessToken).toBe('fresh')
    expect(calls[0]?.fields.get('grant_type')).toBe('refresh_token')
    // A refresh response usually omits the refresh token; the caller must keep
    // the one it already has rather than storing `undefined` over it.
    expect(tokens.refreshToken).toBeUndefined()
  })

  it('treats a revoked grant as needing a new sign-in, not as a retry', async () => {
    const { fetchImpl } = scriptedFetch([{ status: 400, body: { error: 'invalid_grant' } }])
    await expect(refreshAccessToken(CLIENT, 'rt', fetchImpl, 0)).rejects.toBeInstanceOf(
      DeviceFlowAbandoned,
    )
  })

  it('treats anything else as transient', async () => {
    const { fetchImpl } = scriptedFetch([{ status: 503, body: { error: 'backend_error' } }])
    const failure = refreshAccessToken(CLIENT, 'rt', fetchImpl, 0)
    await expect(failure).rejects.toBeInstanceOf(DeviceFlowError)
    await expect(failure).rejects.not.toBeInstanceOf(DeviceFlowAbandoned)
  })
})

describe('expiry', () => {
  it('calls a token expired a minute early', () => {
    // So a request that starts just before the deadline cannot finish after it.
    const tokens = { accessToken: 'a', expiresAt: 100_000 }
    expect(isExpired(tokens, 38_999)).toBe(false)
    expect(isExpired(tokens, 40_001)).toBe(true)
  })
})


/**
 * A `fetch` that fails to connect a given number of times, then answers.
 *
 * `fetch` rejecting is how every platform reports "the request never left" —
 * `TypeError: Failed to fetch` in a browser, Android's
 * `UnknownHostException` text through Capacitor's native HTTP. The class of the
 * rejection carries no information, so the tests use a plain `Error` with the
 * Android wording, which is the one a user actually saw.
 */
function flakyFetch(
  failures: number,
  answer: { status: number; body: unknown } = { status: 200, body: {} },
): { fetchImpl: FetchLike; attempts: () => number } {
  let seen = 0
  const fetchImpl = (async () => {
    seen += 1
    if (seen <= failures) {
      throw new Error(
        'Unable to resolve host "oauth2.googleapis.com": No address associated with hostname',
      )
    }
    return {
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      json: async () => answer.body,
    } as Response
  }) as FetchLike
  return { fetchImpl, attempts: () => seen }
}

const noSleep = async (): Promise<void> => {}

describe('a request that never reaches Google', () => {
  const CHALLENGE_BODY = {
    device_code: 'dc',
    user_code: 'WDJB-MJHT',
    verification_url: 'https://www.google.com/device',
    expires_in: 1800,
    interval: 5,
  }

  it('retries the transport rather than reporting the platform error', async () => {
    // The complaint this exists for: one bad moment on mobile data put a raw
    // `UnknownHostException` message under the Connect button.
    const { fetchImpl, attempts } = flakyFetch(2, { status: 200, body: CHALLENGE_BODY })
    const challenge = await requestDeviceCode(CLIENT, fetchImpl, 0, noSleep)

    expect(challenge.userCode).toBe('WDJB-MJHT')
    expect(attempts()).toBe(3)
  })

  it('gives up after the retries, with a message about the network', async () => {
    const { fetchImpl, attempts } = flakyFetch(99)
    const failure = requestDeviceCode(CLIENT, fetchImpl, 0, noSleep)

    await expect(failure).rejects.toBeInstanceOf(NetworkUnreachable)
    // Named so the caller can tell "never arrived" from "Google said no", and
    // worded so the user is told which of the two it was.
    await expect(failure).rejects.toThrow(/Could not reach oauth2\.googleapis\.com/)
    // The platform text is kept, because it is what distinguishes a captive
    // portal from a dead resolver when this is reported from a phone.
    await expect(failure).rejects.toThrow(/No address associated with hostname/)
    expect(attempts()).toBe(3)
  })

  it('does not retry an answer, however unwelcome', async () => {
    // Retrying an `invalid_client` only fails three times more slowly.
    const { fetchImpl, calls } = scriptedFetch([{ status: 401, body: { error: 'invalid_client' } }])
    await expect(requestDeviceCode(CLIENT, fetchImpl, 0, noSleep)).rejects.toBeInstanceOf(
      DeviceFlowError,
    )
    expect(calls).toHaveLength(1)
  })

  it('keeps a pairing alive through a tunnel', async () => {
    // The code is on screen and the user is typing it on another device; a few
    // seconds without signal must not throw that away.
    let poll = 0
    const fetchImpl = (async () => {
      poll += 1
      if (poll <= 3) throw new Error('Failed to fetch')
      return {
        status: 200,
        ok: true,
        json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
      } as Response
    }) as FetchLike

    const tokens = await awaitAuthorization(
      CLIENT,
      {
        userCode: 'WDJB-MJHT',
        verificationUrl: 'https://www.google.com/device',
        deviceCode: 'dc',
        expiresAt: 1_800_000,
        intervalSeconds: 5,
      },
      { fetchImpl, sleep: noSleep, now: () => 0 },
    )

    expect(tokens.accessToken).toBe('at')
  })

  it('stops pairing once the silence is sustained', async () => {
    // Otherwise a phone in flight mode sits on "pairing" for half an hour.
    const { fetchImpl } = flakyFetch(Number.MAX_SAFE_INTEGER)

    await expect(
      awaitAuthorization(
        CLIENT,
        {
          userCode: 'WDJB-MJHT',
          verificationUrl: 'https://www.google.com/device',
          deviceCode: 'dc',
          expiresAt: 1_800_000,
          intervalSeconds: 5,
        },
        { fetchImpl, sleep: noSleep, now: () => 0 },
      ),
    ).rejects.toBeInstanceOf(NetworkUnreachable)
  })
})
