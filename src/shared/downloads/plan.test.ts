import { describe, expect, it } from 'vitest'
import {
  estimateBytes,
  hasSeparateAudio,
  localPlaylist,
  pickForCap,
  planDownload,
  planFrom,
  readPlan,
  samePlan,
  type DownloadPlan,
} from './plan'
import { parseMediaPlaylist } from '../segmentwindow'
import type { Variant } from '../streamquality'
import { fakeNetwork, mediaPlaylist } from './downloads.fixture'

const H = { Referer: 'https://source.example/' }
const options = { expectedMinutes: 24, cap: 'best' as const, sourceName: 'VidRock', kind: 'episode' as const }

const v = (height: number | null, bandwidth: number, width: number | null = null): Variant => ({
  url: `https://cdn/${width}x${height}-${bandwidth}.m3u8`,
  bandwidth,
  width,
  height,
})

describe('pickForCap', () => {
  const ladder = [v(480, 1_000), v(1080, 5_000), v(720, 2_500), v(1080, 6_000)]

  it('takes the tallest, then the better bit rate, by default', () => {
    expect(pickForCap(ladder, 'best')).toEqual(v(1080, 6_000))
  })

  it('stays at or under a cap', () => {
    expect(pickForCap(ladder, 720)).toEqual(v(720, 2_500))
    expect(pickForCap(ladder, 480)).toEqual(v(480, 1_000))
  })

  it('takes the shortest when every rendition is over the cap, rather than nothing', () => {
    expect(pickForCap([v(1080, 5_000), v(720, 2_000)], 480)).toEqual(v(720, 2_000))
  })

  it('judges by bit rate alone when no height is stated', () => {
    expect(pickForCap([v(null, 1_000), v(null, 3_000)], 480)).toEqual(v(null, 3_000))
  })

  it('judges a letterboxed rendition by its class, not its height', () => {
    // 1068 lines is under 1080, but 2560 wide is 1440p, which "up to 1080p" is not.
    const wide = [v(1068, 9_000, 2560), v(800, 5_000, 1920), v(536, 2_500, 1280)]
    expect(pickForCap(wide, 1080)).toEqual(v(800, 5_000, 1920))
    expect(pickForCap(wide, 720)).toEqual(v(536, 2_500, 1280))
  })
})

describe('hasSeparateAudio', () => {
  it('spots an audio rendition with its own playlist', () => {
    expect(hasSeparateAudio('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="audio.m3u8"\n')).toBe(true)
  })

  it('ignores an audio group carried inside the video', () => {
    expect(hasSeparateAudio('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en"\n')).toBe(false)
    expect(hasSeparateAudio('#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="subs.m3u8"\n')).toBe(false)
  })
})

describe('planDownload', () => {
  const episode = mediaPlaylist('https://cdn/ep', 144, 10) // 24 minutes
  const clip = mediaPlaylist('https://cdn/clip', 12, 10) // 2 minutes
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480',
    'low.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080',
    'high.m3u8',
  ].join('\n')

  it('chooses from a master by the cap, keeping the headers the page sent', async () => {
    const net = fakeNetwork({
      'https://cdn/master.m3u8': { status: 200, body: master },
      'https://cdn/high.m3u8': { status: 200, body: episode },
      'https://cdn/low.m3u8': { status: 200, body: episode },
    })
    const best = await planDownload([{ url: 'https://cdn/master.m3u8', headers: H }], net, options)
    expect(best.ok && best.plan.playlistUrl).toBe('https://cdn/high.m3u8')
    expect(best.ok && best.plan.height).toBe(1080)
    expect(best.ok && best.plan.headers).toEqual(H)
    const capped = await planDownload([{ url: 'https://cdn/master.m3u8', headers: H }], net, { ...options, cap: 480 })
    expect(capped.ok && capped.plan.playlistUrl).toBe('https://cdn/low.m3u8')
  })

  it('takes the rendition the player fetched when no master was seen', async () => {
    const net = fakeNetwork({ 'https://cdn/ep.m3u8': { status: 200, body: episode } })
    const planned = await planDownload([{ url: 'https://cdn/api', headers: H }, { url: 'https://cdn/ep.m3u8', headers: H }], net, options)
    expect(planned.ok && planned.plan.segments.length).toBe(144)
    expect(planned.ok && planned.plan.format).toBe('ts')
  })

  it('refuses a clip in the film\'s place, saying so in words', async () => {
    const net = fakeNetwork({ 'https://cdn/clip.m3u8': { status: 200, body: clip } })
    const planned = await planDownload([{ url: 'https://cdn/clip.m3u8', headers: H }], net, options)
    expect(planned).toEqual({ ok: false, reason: 'VidRock plays something else here (a 2 min video for a 24 min episode)' })
  })

  it('passes over an advert to the film', async () => {
    const net = fakeNetwork({
      'https://cdn/clip.m3u8': { status: 200, body: clip },
      'https://cdn/ep.m3u8': { status: 200, body: episode },
    })
    const planned = await planDownload([{ url: 'https://cdn/clip.m3u8', headers: H }, { url: 'https://cdn/ep.m3u8', headers: H }], net, options)
    expect(planned.ok && planned.plan.playlistUrl).toBe('https://cdn/ep.m3u8')
  })

  it('refuses DRM and separate audio with a reason', async () => {
    const drm = episode.replace('#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"')
    const net = fakeNetwork({ 'https://cdn/drm.m3u8': { status: 200, body: drm } })
    expect(await planDownload([{ url: 'https://cdn/drm.m3u8', headers: H }], net, options)).toEqual({
      ok: false,
      reason: "VidRock's stream is DRM-protected",
    })
    const split = `${master}\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8"`
    const net2 = fakeNetwork({ 'https://cdn/master.m3u8': { status: 200, body: split } })
    const planned = await planDownload([{ url: 'https://cdn/master.m3u8', headers: H }], net2, options)
    expect(!planned.ok && planned.reason).toMatch(/separate stream/)
  })

  it('says nothing was downloadable when the capture held no playlist', async () => {
    const net = fakeNetwork({ 'https://cdn/api': { status: 200, body: '{"ok":true}' } })
    expect(await planDownload([{ url: 'https://cdn/api', headers: H }], net, options)).toEqual({
      ok: false,
      reason: 'VidRock streamed nothing the app can download',
    })
  })
})

function planOf(body: string, url = 'https://cdn/ep.m3u8'): DownloadPlan {
  const parsed = parseMediaPlaylist(body, url)
  if (!parsed.ok) throw new Error(parsed.reason)
  return planFrom(parsed.playlist, url, H, { width: 1280, height: 720, bandwidth: 2_000_000 })!
}

describe('the local playlist', () => {
  it('names the files and drops the key line, keeping each segment\'s IV source', () => {
    const plan = planOf(mediaPlaylist('https://cdn/ep', 3, 6, { key: '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn/key",IV=0x01' }))
    expect(plan.segments[0]).toMatchObject({ keyUrl: 'https://cdn/key', iv: '0x01', sequence: 0 })
    const text = localPlaylist(plan)
    expect(text).not.toMatch(/EXT-X-KEY/)
    expect(text).toContain('s00000.ts')
    expect(text).toContain('s00002.ts')
    expect(text.trim().endsWith('#EXT-X-ENDLIST')).toBe(true)
  })

  it('points fMP4 at its initialisation segment', () => {
    const plan = planOf(mediaPlaylist('https://cdn/ep', 2, 6, { map: '#EXT-X-MAP:URI="init.mp4"' }))
    expect(plan.format).toBe('fmp4')
    expect(plan.maps).toEqual(['https://cdn/init.mp4'])
    expect(localPlaylist(plan)).toContain('#EXT-X-MAP:URI="init0.mp4"')
    expect(localPlaylist(plan)).toContain('s00001.m4s')
  })
})

describe('resuming with a fresh capture', () => {
  const kept = planOf(mediaPlaylist('https://cdn/a', 10, 6))

  it('keeps the segments when the fresh plan is the same stream at new addresses', () => {
    expect(samePlan(kept, planOf(mediaPlaylist('https://other/b', 10, 6)))).toBe(true)
  })

  it('starts over when the stream differs', () => {
    expect(samePlan(kept, planOf(mediaPlaylist('https://cdn/a', 11, 6)))).toBe(false)
    expect(samePlan(kept, { ...kept, height: 1080 })).toBe(false)
  })

  it('reads back what it wrote, and nothing else', () => {
    expect(readPlan(JSON.stringify(kept))).toEqual(kept)
    expect(readPlan('{"nope":1}')).toBeNull()
    expect(readPlan('not json')).toBeNull()
  })
})

describe('estimateBytes', () => {
  it('uses the bit rate, else the first segments scaled', () => {
    const plan = planOf(mediaPlaylist('https://cdn/a', 100, 6))
    expect(estimateBytes(plan, null)).toBe(Math.round((2_000_000 / 8) * 600))
    expect(estimateBytes({ ...plan, bandwidth: null }, { bytes: 1_000, seconds: 6 })).toBe(100_000)
    expect(estimateBytes({ ...plan, bandwidth: null }, null)).toBeNull()
  })
})
