/**
 * Recognising a stream from what each caller actually holds.
 *
 * The phone's capture buffer records URLs and nothing else, so every URL-only
 * case below is a provider the phone's "Test all sources" either sees or
 * reports as having streamed nothing. The URLs are the real shapes providers
 * were measured serving, trimmed of their tokens.
 */

import { describe, expect, it } from 'vitest'

import { isMediaRequest, isMediaResponse } from './mediarequest'

describe('isMediaRequest from the URL alone', () => {
  it.each([
    ['an HLS manifest', 'https://cdn.example/hls/master.m3u8?token=abc'],
    ['a DASH manifest', 'https://cdn.example/dash/stream.mpd'],
    ['an HLS segment', 'https://cdn.example/hls/seg-00042.ts'],
    ['a progressive MP4', 'https://cdn.example/films/title.mp4?expires=1'],
    ['a progressive MKV', 'https://s3.streamflixserver.site/movies/1999/fightclub.mkv'],
    ['a proxy path that names itself', 'https://proxy.example/v1/manifest?data=xyz'],
  ])('recognises %s', (_label, url) => {
    expect(isMediaRequest(url)).toBe(true)
  })

  it.each([
    ['a provider API call', 'https://screenscape.me/api/eyJrIjoicm91dGUifQ'],
    ['an analytics beacon', 'https://www.googletagmanager.com/td?id=G-S9S669WDEX'],
    ['a script whose name merely contains an extension', 'https://cdn.example/mkv-player.js'],
  ])('ignores %s', (_label, url) => {
    expect(isMediaRequest(url)).toBe(false)
  })
})

describe('isMediaRequest with the response in hand', () => {
  it('trusts a media MIME type on an extensionless URL', () => {
    // The desktop case: the URL says nothing, the response type settles it.
    expect(isMediaRequest('https://proxy.example/pl/H4sIAAAA', 'xhr', 'application/vnd.apple.mpegurl')).toBe(true)
  })

  it("trusts Chromium's own media classification", () => {
    expect(isMediaRequest('https://cdn.example/stream', 'media')).toBe(true)
  })
})

describe('isMediaResponse', () => {
  it('recognises a playlist by its type, even behind an opaque URL', () => {
    expect(isMediaResponse('application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-VERSION:3')).toBe(true)
  })

  it('recognises a playlist by its first line when the type lies', () => {
    expect(isMediaResponse('text/html; charset=UTF-8', '#EXTM3U\n#EXTINF:6.0,')).toBe(true)
  })

  it('recognises a video type', () => {
    expect(isMediaResponse('video/mp2t', '')).toBe(true)
  })

  it('ignores an ordinary page or API answer', () => {
    expect(isMediaResponse('text/html; charset=UTF-8', '<!doctype html><html>')).toBe(false)
    expect(isMediaResponse('application/json', '{"sources":[]}')).toBe(false)
  })
})
