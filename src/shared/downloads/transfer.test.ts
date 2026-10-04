import { describe, expect, it } from 'vitest'
import { runTransfer, transportStreamStart, RETRY_DELAYS_MS, type TransferOptions } from './transfer'
import { planFrom, type DownloadPlan } from './plan'
import { parseMediaPlaylist } from '../segmentwindow'
import { ivFor } from './aes'
import { fakeNetwork, memoryFolder, mediaPlaylist, tsSegment } from './downloads.fixture'

function planOf(body: string, bandwidth: number | null = null): DownloadPlan {
  const parsed = parseMediaPlaylist(body, 'https://cdn/ep.m3u8')
  if (!parsed.ok) throw new Error(parsed.reason)
  return planFrom(parsed.playlist, 'https://cdn/ep.m3u8', {}, { height: null, bandwidth })!
}

function options(overrides: Partial<TransferOptions> = {}): TransferOptions & { sleeps: number[]; progress: number[] } {
  const sleeps: number[] = []
  const progress: number[] = []
  return {
    sleeps,
    progress,
    signal: new AbortController().signal,
    onProgress: (p) => progress.push(p.segmentsDone),
    sleep: async (ms) => void sleeps.push(ms),
    roomFor: async () => null,
    ...overrides,
  }
}

const routesFor = (count: number): Record<string, { status: number; body: Uint8Array }> =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`https://cdn/seg${i}`, { status: 200, body: tsSegment(i) }]))

describe('runTransfer', () => {
  it('fetches every segment and writes the playlist that plays them', async () => {
    const net = fakeNetwork(routesFor(5))
    const folder = memoryFolder(net)
    const outcome = await runTransfer(planOf(mediaPlaylist('https://cdn', 5, 6)), folder, options())
    expect(outcome).toMatchObject({ kind: 'done' })
    expect([...folder.files.keys()].sort()).toEqual(['index.m3u8', 's00000.ts', 's00001.ts', 's00002.ts', 's00003.ts', 's00004.ts'])
    expect(folder.files.get('s00003.ts')![1]).toBe(3)
  })

  it('resumes: segments already in the folder are not fetched again', async () => {
    const net = fakeNetwork(routesFor(4))
    const folder = memoryFolder(net)
    folder.files.set('s00000.ts', tsSegment(0))
    folder.files.set('s00001.ts', tsSegment(1))
    const run = options()
    await runTransfer(planOf(mediaPlaylist('https://cdn', 4, 6)), folder, run)
    expect(net.counts.get('https://cdn/seg0')).toBeUndefined()
    expect(net.counts.get('https://cdn/seg3')).toBe(1)
    expect(run.progress[0]).toBe(2)
  })

  it('decrypts AES-128 segments as it saves them, with the sequence number as IV', async () => {
    const raw = new Uint8Array(16).fill(9)
    const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['encrypt'])
    const routes: Record<string, { status: number; body: Uint8Array }> = { 'https://cdn/key': { status: 200, body: raw } }
    for (let i = 0; i < 3; i++) {
      const cipher = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: ivFor({ iv: null, sequence: i }) }, key, tsSegment(i) as BufferSource)
      routes[`https://cdn/seg${i}`] = { status: 200, body: new Uint8Array(cipher) }
    }
    const net = fakeNetwork(routes)
    const folder = memoryFolder(net)
    const plan = planOf(mediaPlaylist('https://cdn', 3, 6, { key: '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn/key"' }))
    expect((await runTransfer(plan, folder, options())).kind).toBe('done')
    expect(folder.files.get('s00002.ts')).toEqual(tsSegment(2))
    expect(net.counts.get('https://cdn/key')).toBe(1)
    expect(new TextDecoder().decode(folder.files.get('index.m3u8'))).not.toMatch(/KEY/)
  })

  it('ends as expired on a 403, so the source is captured again', async () => {
    const routes = routesFor(6)
    routes['https://cdn/seg4'] = { status: 403, body: new Uint8Array() }
    const folder = memoryFolder(fakeNetwork(routes))
    expect(await runTransfer(planOf(mediaPlaylist('https://cdn', 6, 6)), folder, options())).toEqual({ kind: 'expired' })
    expect(folder.files.has('index.m3u8')).toBe(false)
  })

  it('retries with growing pauses, and says which segment failed after the last try', async () => {
    const routes: Record<string, unknown> = routesFor(3)
    routes['https://cdn/seg1'] = (n: number) => (n < 3 ? { status: 503, body: '' } : { status: 200, body: tsSegment(1) })
    const run = options()
    expect((await runTransfer(planOf(mediaPlaylist('https://cdn', 3, 6)), memoryFolder(fakeNetwork(routes as never)), run)).kind).toBe('done')
    expect(run.sleeps).toEqual(RETRY_DELAYS_MS.slice(0, 2))

    const failing = routesFor(3)
    failing['https://cdn/seg2'] = { status: 404, body: new Uint8Array() }
    const outcome = await runTransfer(planOf(mediaPlaylist('https://cdn', 3, 6)), memoryFolder(fakeNetwork(failing)), options())
    expect(outcome).toEqual({ kind: 'failed', reason: 'Segment 3 of 3 would not download (HTTP 404)' })
  })

  it('refuses a page served in a segment\'s place', async () => {
    const routes: Record<string, { status: number; body: string | Uint8Array }> = routesFor(2)
    routes['https://cdn/seg1'] = { status: 200, body: '<html>busy</html>' }
    const outcome = await runTransfer(planOf(mediaPlaylist('https://cdn', 2, 6)), memoryFolder(fakeNetwork(routes)), options())
    expect(outcome).toEqual({ kind: 'failed', reason: 'Segment 2 of 2 would not download (not video)' })
  })

  it('refuses to fill the disk, before the first segment when the bit rate is known', async () => {
    const net = fakeNetwork(routesFor(3))
    const outcome = await runTransfer(planOf(mediaPlaylist('https://cdn', 3, 6), 8_000_000), memoryFolder(net), options({ roomFor: async () => 'No room' }))
    expect(outcome).toEqual({ kind: 'failed', reason: 'No room' })
    expect(net.counts.size).toBe(0)
  })

  it('stops when the viewer pauses', async () => {
    const controller = new AbortController()
    const routes: Record<string, unknown> = routesFor(10)
    routes['https://cdn/seg1'] = () => {
      controller.abort()
      return { status: 200, body: tsSegment(1) }
    }
    const outcome = await runTransfer(planOf(mediaPlaylist('https://cdn', 10, 6)), memoryFolder(fakeNetwork(routes as never)), options({ signal: controller.signal }))
    expect(outcome).toEqual({ kind: 'aborted' })
  })
})

describe('transportStreamStart', () => {
  it('skips an image disguise in front of the stream', () => {
    const ts = tsSegment(5, 752)
    const disguised = new Uint8Array(8 + ts.length)
    disguised.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    disguised.set(ts, 8)
    expect(transportStreamStart(disguised)).toEqual(ts)
    expect(transportStreamStart(ts)).toBe(ts)
  })
})
