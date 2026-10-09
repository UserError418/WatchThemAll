import { describe, expect, it } from 'vitest'
import { downloadCastBundle } from './castbundle'
import { localPlaylist, planFrom } from './plan'
import { parseMediaPlaylist } from '../segmentwindow'
import { mediaPlaylist } from './downloads.fixture'

let n = 0
const ids = (prefix: string): string => `${prefix}${(n += 1)}`

describe('downloadCastBundle', () => {
  it('names every file by an id, and keeps the timing', () => {
    const parsed = parseMediaPlaylist(mediaPlaylist('https://cdn', 3, 6), 'https://cdn/ep.m3u8')
    if (!parsed.ok) throw new Error(parsed.reason)
    const plan = planFrom(parsed.playlist, 'https://cdn/ep.m3u8', {}, { width: null, height: null, bandwidth: null })!
    const bundle = downloadCastBundle(localPlaylist(plan), ids)!
    const body = bundle.playlists[bundle.rootId]!
    expect(Object.values(bundle.files).sort()).toEqual(['s00000.ts', 's00001.ts', 's00002.ts'])
    expect(body).not.toMatch(/s0000\d\.ts/)
    expect(body.match(/#EXTINF:6\.000000,/g)).toHaveLength(3)
    for (const id of Object.keys(bundle.files)) expect(body).toContain(id)
  })

  it('rewrites the initialisation segment of fMP4', () => {
    const bundle = downloadCastBundle('#EXTM3U\n#EXT-X-MAP:URI="m00000.mp4"\n#EXTINF:4,\ns00000.m4s\n#EXT-X-ENDLIST\n', ids)!
    const body = bundle.playlists[bundle.rootId]!
    expect(body).not.toContain('m00000.mp4')
    expect(Object.values(bundle.files).sort()).toEqual(['m00000.mp4', 's00000.m4s'])
  })

  it('refuses a playlist naming anything but its own files', () => {
    expect(downloadCastBundle('#EXTM3U\n#EXTINF:4,\n../../etc/passwd\n', ids)).toBeNull()
    expect(downloadCastBundle('#EXTM3U\n#EXTINF:4,\nhttps://elsewhere/seg.ts\n', ids)).toBeNull()
    expect(downloadCastBundle('#EXTM3U\n#EXT-X-ENDLIST\n', ids)).toBeNull()
  })
})
