import { describe, expect, it } from 'vitest'
import { DownloadManager, type DownloadPlatform, type DownloadSource } from './manager'
import { fakeNetwork, memoryFolder, mediaPlaylist, tsSegment } from './downloads.fixture'
import type { DownloadRequest, DownloadsStatus } from './types'
import type { CapturedRequest } from '../streamfetch'

const request: DownloadRequest = {
  tmdbId: 1,
  imdbId: 'tt1',
  type: 'tv',
  title: 'Show',
  season: 1,
  episode: 2,
  episodeName: 'Two',
  runtimeMinutes: 24,
  posterPath: null,
  providerId: null,
}

const SOURCES: DownloadSource[] = [
  { id: 'clipper', name: 'Clipper' },
  { id: 'good', name: 'Good' },
]

/** A 24-minute episode in six segments from one source, and a ten-second clip from another. */
function world(segmentRoute?: (i: number, count: number) => { status: number; body: Uint8Array }) {
  const routes: Record<string, unknown> = {
    'https://good/ep.m3u8': { status: 200, body: mediaPlaylist('https://good', 6, 240) },
    'https://clip/ep.m3u8': { status: 200, body: mediaPlaylist('https://clip', 1, 10) },
  }
  for (let i = 0; i < 6; i++) routes[`https://good/seg${i}`] = (n: number) => segmentRoute?.(i, n) ?? { status: 200, body: tsSegment(i) }
  const net = fakeNetwork(routes as never)
  const folders = new Map<string, ReturnType<typeof memoryFolder>>()
  const published: DownloadsStatus[] = []
  const captures: string[] = []
  let saved: string | null = null
  let gate: Promise<void> = Promise.resolve()
  const platform: DownloadPlatform = {
    readRecords: async () => saved,
    writeRecords: async (text) => void (saved = text),
    sources: async (_subject, preferred) => (preferred === 'good' ? [SOURCES[1]!, SOURCES[0]!] : [...SOURCES]),
    capture: async (_subject, source): Promise<CapturedRequest[]> => {
      captures.push(source.id)
      await gate
      return [{ url: source.id === 'good' ? 'https://good/ep.m3u8' : 'https://clip/ep.m3u8', headers: { Referer: `https://${source.id}/` } }]
    },
    fetch: net,
    folder: async (id) => {
      if (!folders.has(id)) folders.set(id, memoryFolder(net))
      return folders.get(id)!
    },
    removeFolder: async (id) => void folders.delete(id),
    listFolders: async () => [...folders.keys()],
    freeBytes: async () => 10_000_000,
    savePoster: async () => null,
    posterUrl: () => null,
    now: () => Date.now(),
    sleep: async () => {},
    publish: (status) => published.push(status),
    log: () => {},
  }
  return {
    net,
    platform,
    folders,
    published,
    captures,
    saved: () => saved,
    hold: () => {
      let release!: () => void
      gate = new Promise((resolve) => (release = resolve))
      return release
    },
  }
}

/** Until the queue has nothing running: every state the test waits on is published. */
async function settled(manager: DownloadManager): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
    const states = manager.status().downloads.map((d) => d.state)
    if (!states.some((s) => s === 'queued' || s === 'capturing' || s === 'downloading')) return
  }
  throw new Error('the queue never settled')
}

describe('DownloadManager', () => {
  it('passes over a source that plays something else, and downloads from the next', async () => {
    const w = world()
    const manager = new DownloadManager(w.platform, { publishEveryMs: 0 })
    await manager.load()
    const started = await manager.start(request)
    expect(started.ok).toBe(true)
    await settled(manager)
    const [download] = manager.status().downloads
    expect(download).toMatchObject({ state: 'done', source: { id: 'good' }, segmentsDone: 6, segmentsTotal: 6, durationSeconds: 1440 })
    expect(download!.refusals).toEqual([{ providerId: 'clipper', reason: 'Clipper plays something else here (a 1 min video for a 24 min episode)' }])
    expect(w.captures).toEqual(['clipper', 'good'])
    expect(w.folders.get(download!.id)!.files.has('index.m3u8')).toBe(true)
    expect(manager.playable(request)?.id).toBe(download!.id)
  })

  it('tries the source chosen by hand first', async () => {
    const w = world()
    const manager = new DownloadManager(w.platform, { publishEveryMs: 0 })
    await manager.load()
    await manager.start({ ...request, providerId: 'good' })
    await settled(manager)
    expect(w.captures).toEqual(['good'])
  })

  it('captures again when the links expire, and resumes at the next missing segment', async () => {
    const w = world((i, n) => (i === 3 && n === 1 ? { status: 403, body: new Uint8Array() } : { status: 200, body: tsSegment(i) }))
    const manager = new DownloadManager(w.platform, { publishEveryMs: 0 })
    await manager.load()
    await manager.start({ ...request, providerId: 'good' })
    await settled(manager)
    expect(manager.status().downloads[0]!.state).toBe('done')
    expect(w.captures).toEqual(['good', 'good'])
    // Segments 0-2 were kept through the expiry, not fetched twice.
    expect(w.net.counts.get('https://good/seg0')).toBe(1)
  })

  it('says why when no source gives the film', async () => {
    const w = world()
    w.platform.sources = async () => [SOURCES[0]!]
    const manager = new DownloadManager(w.platform, { publishEveryMs: 0 })
    await manager.load()
    await manager.start(request)
    await settled(manager)
    expect(manager.status().downloads[0]).toMatchObject({ state: 'failed', error: 'Clipper plays something else here (a 1 min video for a 24 min episode)' })
  })

  it('runs one download at a time, in the order asked', async () => {
    const w = world()
    const release = w.hold()
    const manager = new DownloadManager(w.platform, { publishEveryMs: 0 })
    await manager.load()
    await manager.start({ ...request, providerId: 'good' })
    await manager.start({ ...request, episode: 3, providerId: 'good' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(manager.status().downloads.map((d) => d.state).sort()).toEqual(['capturing', 'queued'])
    release()
    await settled(manager)
    expect(manager.status().downloads.map((d) => d.state)).toEqual(['done', 'done'])
  })

  it('asking again for the same episode does not make a second download', async () => {
    const w = world()
    const manager = new DownloadManager(w.platform, { publishEveryMs: 0 })
    await manager.load()
    const a = await manager.start(request)
    const b = await manager.start(request)
    expect(a).toEqual(b)
    expect(manager.status().downloads).toHaveLength(1)
  })

  it('pauses, resumes, and deletes with its files', async () => {
    const w = world()
    const release = w.hold()
    const manager = new DownloadManager(w.platform, { publishEveryMs: 0 })
    await manager.load()
    const started = await manager.start({ ...request, providerId: 'good' })
    const id = started.ok ? started.id : ''
    await manager.pause(id)
    release()
    await settled(manager)
    expect(manager.status().downloads[0]!.state).toBe('paused')
    await manager.resume(id)
    await settled(manager)
    expect(manager.status().downloads[0]!.state).toBe('done')
    await manager.remove(id)
    expect(manager.status().downloads).toEqual([])
    expect(w.folders.has(id)).toBe(false)
  })

  it('carries on after a restart from what was on disk', async () => {
    const w = world()
    const release = w.hold()
    const first = new DownloadManager(w.platform, { publishEveryMs: 0 })
    await first.load()
    await first.start({ ...request, providerId: 'good' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The app quits mid-capture: the file says "capturing".
    expect(JSON.parse(w.saved()!).downloads[0].state).toBe('capturing')
    release()
    const second = new DownloadManager(w.platform, { publishEveryMs: 0 })
    await second.load()
    await settled(second)
    expect(second.status().downloads[0]!.state).toBe('done')
  })

  it('refuses when the disk lacks room, and says so', async () => {
    const w = world()
    w.platform.freeBytes = async () => 100
    const manager = new DownloadManager(w.platform, { publishEveryMs: 0 })
    await manager.load()
    await manager.start({ ...request, providerId: 'good' })
    await settled(manager)
    expect(manager.status().downloads[0]!.error).toMatch(/^Not enough space on this device: it needs .* is free$/)
  })

  it('removes folders no record names', async () => {
    const w = world()
    await w.platform.folder('orphan')
    const manager = new DownloadManager(w.platform)
    await manager.load()
    expect(w.folders.has('orphan')).toBe(false)
  })
})
