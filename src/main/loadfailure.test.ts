import { describe, expect, it } from 'vitest'

import { loadFailureReason } from './loadfailure'

describe('loadFailureReason', () => {
  it("says in words that a source's certificate is not valid (Videasy, 2026-10-04)", () => {
    expect(loadFailureReason(-202, 'ERR_CERT_AUTHORITY_INVALID', 'Videasy')).toBe(
      "Videasy's site has an invalid security certificate",
    )
    expect(loadFailureReason(-201, 'ERR_CERT_DATE_INVALID', 'VidSrc')).toBe(
      "VidSrc's site has an invalid security certificate",
    )
  })

  it('names the common network failures plainly', () => {
    expect(loadFailureReason(-102, 'ERR_CONNECTION_REFUSED', 'VidLux')).toBe('VidLux refused the connection')
    expect(loadFailureReason(-118, 'ERR_CONNECTION_TIMED_OUT', 'VidLux')).toBe('VidLux did not answer in time')
  })

  it("keeps Chromium's own text for anything else", () => {
    expect(loadFailureReason(-324, 'ERR_EMPTY_RESPONSE', 'VidLux')).toBe('ERR_EMPTY_RESPONSE')
  })
})
