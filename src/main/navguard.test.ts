/**
 * The provider's page stays on its own site. The adverts here are the
 * measured ones: Videasy's and VidZee's own documents navigated to these
 * about ten seconds after loading, with no click.
 */

import { describe, expect, it } from 'vitest'

import { isForeignNavigation } from './navguard'

const VIDEASY = 'https://player.videasy.to/tv/1396/1/2'

describe('isForeignNavigation', () => {
  it('stops the measured advert redirects', () => {
    expect(isForeignNavigation(VIDEASY, 'https://nq.ernesseallow.cfd/click?z=1', VIDEASY)).toBe(
      true,
    )
    const vidzee = 'https://player.vidzee.wtf/embed/tv/1396/1/2'
    expect(isForeignNavigation(vidzee, 'https://wk.sanpoiljejuna.cfd/r', vidzee)).toBe(true)
  })

  it('lets the provider move around its own site', () => {
    expect(isForeignNavigation(VIDEASY, 'https://player.videasy.to/tv/1396/1/3', VIDEASY)).toBe(
      false,
    )
    expect(isForeignNavigation(VIDEASY, 'https://www.videasy.to/other', VIDEASY)).toBe(false)
  })

  /** A server redirect can land the document on a mirror; its own links still name the original. */
  it('allows both the site it is on and the site the source was loaded from', () => {
    const loaded = 'https://vidsrc.me/embed/tv?imdb=tt0903747&season=1&episode=2'
    const mirror = 'https://vidsrcme.ru/embed/tv?imdb=tt0903747&season=1&episode=2'
    expect(isForeignNavigation(mirror, 'https://vidsrcme.ru/next', loaded)).toBe(false)
    expect(
      isForeignNavigation(mirror, 'https://vidsrc.me/embed/tv?season=1&episode=3', loaded),
    ).toBe(false)
  })

  it('never stops the first load into an empty frame', () => {
    expect(isForeignNavigation('', VIDEASY, VIDEASY)).toBe(false)
    expect(isForeignNavigation('about:blank', VIDEASY, VIDEASY)).toBe(false)
  })

  it('leaves navigations that are not web pages alone', () => {
    expect(isForeignNavigation(VIDEASY, 'about:blank', VIDEASY)).toBe(false)
    expect(isForeignNavigation(VIDEASY, 'blob:https://player.videasy.to/1234', VIDEASY)).toBe(false)
  })

  /** The same trap `sameorigin.ts` exists for: a prefix is not a site. */
  it('is not fooled by a lookalike host', () => {
    expect(isForeignNavigation(VIDEASY, 'https://player.videasy.to.evil.example/x', VIDEASY)).toBe(
      true,
    )
  })

  it('treats an address as its own site', () => {
    expect(isForeignNavigation('http://10.0.0.5/embed', 'http://10.0.0.5/other', null)).toBe(false)
    expect(isForeignNavigation('http://10.0.0.5/embed', 'http://10.0.9.5/other', null)).toBe(true)
  })
})
