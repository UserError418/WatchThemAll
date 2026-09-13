import { describe, expect, it } from 'vitest'

import { isOpenableExternally } from './externalurl'

describe('isOpenableExternally', () => {
  it.each([
    'https://www.google.com/device',
    'http://example.com',
    'https://example.com:8443/path?q=1#f',
  ])('allows %s', (url) => expect(isOpenableExternally(url)).toBe(true))

  it.each([
    // Handed to the OS rather than to a browser, these are not web addresses.
    ['a local file', 'file:///etc/passwd'],
    ['a script url', 'javascript:alert(1)'],
    ['an inline document', 'data:text/html,<h1>hi</h1>'],
    ['an Android app link', 'intent://scan/#Intent;scheme=zxing;end'],
    ['a mail client', 'mailto:someone@example.com'],
    ['not a url at all', 'www.google.com/device'],
    ['empty', ''],
  ])('refuses %s', (_name, url) => expect(isOpenableExternally(url)).toBe(false))
})
