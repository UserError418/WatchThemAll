/**
 * Tests for the ad rules.
 *
 * Weighted deliberately towards *false positives*, not towards catching ads.
 * A rule that misses an ad costs the user a banner; a rule that blocks a
 * segment playlist costs them the film, and it fails in a way that looks like
 * the provider is broken rather than like the blocker is wrong.
 */

import { describe, expect, it } from 'vitest'
import { decide } from './adblock'

const PAGE = 'https://player.videasy.to'
const ask = (url: string, resourceType = 'script', pageOrigin: string | null = PAGE) =>
  decide({ url, resourceType, pageOrigin })

describe('what must never be blocked', () => {
  it('lets the video through even from a host that looks unrelated', () => {
    // The stream genuinely arrives from a domain with no relationship to the
    // page. That is normal here and is exactly what an ad host looks like.
    expect(ask('https://cache.vdrk.site/v2/movie/550.m3u8', 'media').blocked).toBe(false)
  })

  it('does not block the page itself', () => {
    expect(ask('https://player.videasy.to/tv/1396/1/1', 'mainFrame').blocked).toBe(false)
  })

  it('does not mistake "adaptive" for "ad"', () => {
    // The substring trap, and not a hypothetical one: HLS delivery is full of
    // this word. Matching `ad` as a substring kills the stream.
    for (const url of [
      'https://cdn.example.com/adaptive/master.m3u8',
      'https://cdn.example.com/hls/adaptive_720/seg-1.ts',
      'https://cdn.example.com/v1/upload/preload/chunk.ts',
    ]) {
      expect(ask(url, 'xhr').blocked, url).toBe(false)
    }
  })

  it('does not block stylesheets or fonts', () => {
    expect(ask('https://ads.example.com/style.css', 'stylesheet').blocked).toBe(false)
    expect(ask('https://ads.example.com/f.woff2', 'font').blocked).toBe(false)
  })

  it('gives the provider its own paths the benefit of the doubt', () => {
    // These sites proxy streams through paths nobody here can predict. A false
    // positive on the page's own origin is a dead video.
    expect(ask('https://player.videasy.to/api/ads/config', 'xhr').blocked).toBe(false)
    expect(ask('https://cdn.videasy.to/ad/segment.ts', 'xhr').blocked).toBe(false)
  })

  it('leaves data: and blob: alone', () => {
    expect(ask('data:text/javascript,void 0').blocked).toBe(false)
    expect(ask('blob:https://player.videasy.to/abc', 'media').blocked).toBe(false)
  })
})

describe('what must be blocked', () => {
  it('blocks the pop-under and ad networks by host', () => {
    for (const url of [
      'https://a.propellerads.com/loader.js',
      'https://cdn.popads.net/pop.js',
      'https://www.googletagmanager.com/gtm.js?id=X',
      'https://sub.deep.exoclick.com/tag',
    ]) {
      expect(ask(url).blocked, url).toBe(true)
    }
  })

  it('blocks beacons whatever they point at', () => {
    expect(ask('https://player.videasy.to/api/stats/hit', 'ping').blocked).toBe(true)
  })

  it('blocks ad scripts by filename on any host', () => {
    expect(ask('https://unknown-cdn.example/js/prebid.js').blocked).toBe(true)
    expect(ask('https://unknown-cdn.example/a/ads.js').blocked).toBe(true)
  })

  it('blocks third-party ad paths on segment boundaries', () => {
    expect(ask('https://unknown.example/banner/300x250.png', 'image').blocked).toBe(true)
    expect(ask('https://unknown.example/v2/popunder/go', 'subFrame').blocked).toBe(true)
  })

  it('names the rule that decided, so a broken stream can be traced', () => {
    expect(ask('https://a.popads.net/x.js').rule).toBe('ad-host:popads.net')
    expect(ask('https://unknown.example/ads/x.png', 'image').rule).toBe('ad-path:ads')
  })
})

describe('host matching', () => {
  it('matches subdomains but not lookalikes', () => {
    expect(ask('https://x.popads.net/a.js').blocked).toBe(true)
    // The same mistake `startsWith` made in the provider-failure check.
    expect(ask('https://popads.net.evil.example/a.js').blocked).toBe(false)
  })
})
