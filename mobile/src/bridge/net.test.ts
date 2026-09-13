/**
 * The fallback is the whole point, so it is the thing worth testing.
 *
 * It cannot be exercised on a device without breaking Android's resolver on
 * purpose, and the emulator's works — so the branch that matters is driven here
 * by making the native `fetch` reject, which is exactly what the phone did.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { dualStackFetch } from './net'

type Patched = typeof globalThis & { CapacitorWebFetch?: typeof fetch }

const answer = (status: number): Response => ({ status, ok: status < 400 }) as Response

/** Android's own words when the native stack cannot resolve a name. */
const unresolvable = (): Error =>
  new Error('Unable to resolve host "oauth2.googleapis.com": No address associated with hostname')

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as Patched).CapacitorWebFetch
})

describe('the phone has two ways out', () => {
  it('uses the native stack when it works, and does not touch the other one', async () => {
    const native = vi.fn(async () => answer(200))
    const browser = vi.fn(async () => answer(200))
    vi.stubGlobal('fetch', native)
    vi.stubGlobal('CapacitorWebFetch', browser)

    expect((await dualStackFetch('https://oauth2.googleapis.com/token')).status).toBe(200)
    expect(browser).not.toHaveBeenCalled()
  })

  it('falls back to the WebView when the native stack cannot connect', async () => {
    const native = vi.fn(async () => {
      throw unresolvable()
    })
    let relayed: RequestInit | undefined
    const browser = vi.fn(async (_input: unknown, init?: RequestInit) => {
      relayed = init
      return answer(200)
    })
    vi.stubGlobal('fetch', native)
    vi.stubGlobal('CapacitorWebFetch', browser)

    const response = await dualStackFetch('https://oauth2.googleapis.com/token', { method: 'POST' })

    expect(response.status).toBe(200)
    expect(browser).toHaveBeenCalledOnce()
    // The same request, not a rebuilt one: an OAuth POST without its body would
    // fail in a way that looks like a server problem.
    expect(relayed).toEqual({ method: 'POST' })
  })

  it('does not second-guess an answer, however unwelcome', async () => {
    // A 401 means the request arrived. Asking a second stack the same question
    // could only hide that.
    const browser = vi.fn(async () => answer(200))
    vi.stubGlobal('fetch', vi.fn(async () => answer(401)))
    vi.stubGlobal('CapacitorWebFetch', browser)

    expect((await dualStackFetch('https://oauth2.googleapis.com/token')).status).toBe(401)
    expect(browser).not.toHaveBeenCalled()
  })

  it('reports the native failure when there is no fallback to take', async () => {
    // A desktop build, or a Capacitor version that stops parking the original.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw unresolvable()
      }),
    )

    await expect(dualStackFetch('https://oauth2.googleapis.com/token')).rejects.toThrow(
      /No address associated with hostname/,
    )
  })

  it('reports the native failure, not the browser one, when both fail', async () => {
    // "Failed to fetch" names neither the host nor the reason; the Java message
    // names both, and is the only thing worth putting in a bug report.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw unresolvable()
      }),
    )
    vi.stubGlobal(
      'CapacitorWebFetch',
      vi.fn(async () => {
        throw new Error('Failed to fetch')
      }),
    )

    await expect(dualStackFetch('https://oauth2.googleapis.com/token')).rejects.toThrow(
      /No address associated with hostname/,
    )
  })
})
