/**
 * Recognising a stream from what each caller actually holds.
 *
 * The phone's capture buffer records URLs and nothing else, so every URL-only
 * case below is a provider the phone's "Test all sources" either sees or
 * reports as having streamed nothing. The URLs are the real shapes providers
 * were measured serving, trimmed of their tokens.
 */

import { describe, expect, it } from 'vitest'

import { isFalseWholeFile, isMediaRequest, isMediaResponse, totalBytesOf } from './mediarequest'

describe('isMediaRequest from the URL alone', () => {
  it.each([
    ['an HLS manifest', 'https://cdn.example/hls/master.m3u8?token=abc'],
    ['a DASH manifest', 'https://cdn.example/dash/stream.mpd'],
    ['an HLS segment', 'https://cdn.example/hls/seg-00042.ts'],
    ['a progressive MP4', 'https://cdn.example/films/title.mp4?expires=1'],
    ['a progressive MKV', 'https://s3.streamflixserver.site/movies/1999/fightclub.mkv'],
    ['a proxy path that names itself', 'https://proxy.example/v1/manifest?data=xyz'],
    ['a segment proxy path', 'https://proxy.example/segment/000042'],
  ])('recognises %s', (_label, url) => {
    expect(isMediaRequest(url)).toBe(true)
  })

  it.each([
    ['a provider API call', 'https://screenscape.me/api/eyJrIjoicm91dGUifQ'],
    ['an analytics beacon', 'https://www.googletagmanager.com/td?id=G-S9S669WDEX'],
    ['a script whose name merely contains an extension', 'https://cdn.example/mkv-player.js'],
    // Called by VidZee on every title; it made the scan report a dead source as streaming.
    ['an intro-skip API', 'https://core.vidzee.wtf/introdb/segments?imdb_id=tt4574334&season=4&episode=9'],
    ['a web-app manifest', 'https://player.example/manifest.json'],
    ['a site manifest', 'https://player.example/site.webmanifest'],
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

describe('what is not the stream, whatever it looks like', () => {
  it('never counts a subtitle file, even one a media element loaded', () => {
    // MoviesAPI's <track>: Chromium types it `media`.
    expect(isMediaRequest('https://moviesapi.to/api/vidora/subs/movie/550/en.vtt', 'media')).toBe(false)
    expect(isMediaRequest('https://cdn.example/sub?id=1', 'xhr', 'text/vtt')).toBe(false)
  })

  it("rejects VidRock's placeholder, a web page with a video's name", () => {
    expect(isFalseWholeFile('https://vidrock.net/demo-video.mp4', 'media', 'text/html; charset=utf-8', 887)).toBe(true)
  })

  it('rejects a whole file too small to be a programme', () => {
    expect(isFalseWholeFile('https://ads.example/preroll.mp4', 'media', 'video/mp4', 900_000)).toBe(true)
  })

  it('accepts a real film file', () => {
    // ScreenScape serves whole films; this is the size of one.
    expect(isFalseWholeFile('https://s3.example/movies/1999/fightclub.mkv', 'media', 'video/x-matroska', 2_400_000_000)).toBe(false)
  })

  it('gives the benefit of the doubt when the size is unknown', () => {
    expect(isFalseWholeFile('https://cdn.example/film.mp4', 'media', 'video/mp4', null)).toBe(false)
  })

  it('leaves segments and playlists alone, which are small or HTML-typed by design', () => {
    expect(isFalseWholeFile('https://cdn.example/seg-00001.mp4', 'xhr', 'video/mp4', 1_500_000)).toBe(false)
    expect(isFalseWholeFile('https://cdn.example/index.m3u8', 'media', 'text/html', 900)).toBe(false)
  })
})

describe('totalBytesOf', () => {
  it("reads the whole size from a range response's Content-Range", () => {
    expect(totalBytesOf(206, 'bytes 0-886/887', '887')).toBe(887)
  })

  it("takes a 200's Content-Length", () => {
    expect(totalBytesOf(200, '', '52428800')).toBe(52_428_800)
  })

  it('does not mistake a partial length for the whole', () => {
    expect(totalBytesOf(206, '', '1024')).toBeNull()
    expect(totalBytesOf(206, 'bytes 0-1023/*', '1024')).toBeNull()
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
