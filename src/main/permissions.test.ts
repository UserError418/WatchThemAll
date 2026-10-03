/**
 * A source's page gets nothing it could spy with; the app's own page gets
 * only what its features use. The permission names are Electron's.
 */

import type { Session } from 'electron'
import { describe, expect, it } from 'vitest'

import { APP_PERMISSIONS, restrictPermissions, SOURCE_PERMISSIONS } from './permissions'

type RequestHandler = (contents: unknown, permission: string, callback: (granted: boolean) => void) => void
type CheckHandler = (contents: unknown, permission: string) => boolean

/** A session that only records the two handlers it is given. */
function fakeSession(): { session: Session; ask: (permission: string) => boolean; check: (permission: string) => boolean } {
  let request: RequestHandler | null = null
  let checker: CheckHandler | null = null
  const session = {
    setPermissionRequestHandler: (handler: RequestHandler) => (request = handler),
    setPermissionCheckHandler: (handler: CheckHandler) => (checker = handler),
  } as unknown as Session
  return {
    session,
    ask: (permission) => {
      let answer: boolean | undefined
      request?.(null, permission, (granted) => (answer = granted))
      if (answer === undefined) throw new Error(`no answer for ${permission}`)
      return answer
    },
    check: (permission) => {
      if (!checker) throw new Error('no check handler')
      return checker(null, permission)
    },
  }
}

const SPYING = ['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'hid', 'serial', 'usb']

describe('restrictPermissions', () => {
  it("refuses a source's page everything it could spy or annoy with, by request and by check", () => {
    const fake = fakeSession()
    restrictPermissions(fake.session, SOURCE_PERMISSIONS)
    for (const permission of SPYING) {
      expect(fake.ask(permission), permission).toBe(false)
      expect(fake.check(permission), permission).toBe(false)
    }
    // Nor may it write to the clipboard: an advert swapping what was copied.
    expect(fake.ask('clipboard-sanitized-write')).toBe(false)
  })

  it("lets a source's own fullscreen button work", () => {
    const fake = fakeSession()
    restrictPermissions(fake.session, SOURCE_PERMISSIONS)
    expect(fake.ask('fullscreen')).toBe(true)
  })

  it("gives the app's window the clipboard write its copy button uses, and no more", () => {
    const fake = fakeSession()
    restrictPermissions(fake.session, APP_PERMISSIONS)
    expect(fake.ask('clipboard-sanitized-write')).toBe(true)
    expect(fake.ask('fullscreen')).toBe(true)
    for (const permission of SPYING) expect(fake.ask(permission), permission).toBe(false)
  })
})
