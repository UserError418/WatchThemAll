import { describe, expect, it } from 'vitest'
import { createSegmentStore, type CacheFiles } from './segmentstore'
import type { SaveIo } from './segmentsave'

const TS = (() => {
  const bytes = new Uint8Array(400)
  bytes[0] = 0x47
  bytes[188] = 0x47
  return bytes
})()

const PLAYLIST = ['#EXTM3U', '#EXT-X-TARGETDURATION:5']
  .concat(Array.from({ length: 504 }, (_, i) => [`#EXTINF:5,`, `https://cdn.example/seg/${i}.ts`]).flat())
  .concat('#EXT-X-ENDLIST')
  .join('\n')

/** Files in memory, and a network that serves one film's playlist and segments. */
function memoryFiles(existing: string[] = [], index: string | null = null) {
  const dirs = new Map<string, Map<string, string>>(existing.map((name) => [name, new Map()]))
  let indexText = index
  let slowNetwork: Promise<void> | null = null
  const files: CacheFiles = {
    async fetchText(url) {
      return url.endsWith('index.m3u8') ? { status: 200, body: PLAYLIST } : null
    },
    async readIndex() {
      return indexText
    },
    async writeIndex(text) {
      indexText = text
    },
    async listWindows() {
      return [...dirs.keys()]
    },
    async removeWindow(name) {
      dirs.delete(name)
    },
    async renameWindow(from, to) {
      dirs.set(to, dirs.get(from)!)
      dirs.delete(from)
    },
    async openWindow(name) {
      const dir = new Map<string, string>()
      dirs.set(name, dir)
      const io: SaveIo = {
        async fetchText(url) {
          if (slowNetwork) await slowNetwork
          return url.endsWith('index.m3u8') ? { status: 200, body: PLAYLIST } : null
        },
        async download(_url, _headers, fileName) {
          dir.set(fileName, 'bytes')
          return { status: 200, bytes: 1_000_000, head: TS }
        },
        async writeText(fileName, text) {
          dir.set(fileName, text)
        },
      }
      return io
    },
    playlistUrl: (id) => `/__cache/${id}/index.m3u8`,
  }
  return { files, dirs, index: () => indexText, slow: (until: Promise<void>) => (slowNetwork = until) }
}

const WHERE = { titleKey: 'tv:tt0386676', season: 4, episode: 1, providerId: 'vidsrc-me' }
const REQUESTS = [{ url: 'https://cdn.example/ep/index.m3u8', headers: {} }]
const NAMES = { title: 'The Office', source: 'VidSrc' }
const quiet = (): void => {}

describe('createSegmentStore', () => {
  it('sweeps directories the index does not name: an interrupted save leaves no half window', async () => {
    const { files, dirs } = memoryFiles(['abc.part', 'orphan'])
    await createSegmentStore(files, quiet)
    expect([...dirs.keys()]).toEqual([])
  })

  it('keeps a window, then finds it for the same source and a place inside it', async () => {
    const { files, dirs, index } = memoryFiles()
    const store = await createSegmentStore(files, quiet)
    const outcome = await store.save(WHERE, REQUESTS, { seconds: 600, duration: 2520 }, 42, NAMES)
    expect(outcome.ok).toBe(true)
    const kept = store.find(WHERE, 602)
    expect(kept?.src).toMatch(/^\/__cache\/[a-z0-9-]+\/index\.m3u8$/)
    expect(kept?.filmSeconds).toBe(2520)
    expect([...dirs.keys()].some((d) => d.endsWith('.part'))).toBe(false)
    expect(JSON.parse(index()!).windows).toHaveLength(1)
    expect(store.find({ ...WHERE, providerId: 'vidrock' }, 602)).toBeNull()
  })

  it('leaves nothing behind when a save finds no stream', async () => {
    const { files, dirs } = memoryFiles()
    const store = await createSegmentStore(files, quiet)
    const outcome = await store.save(WHERE, [{ url: 'https://ads.example/x.js', headers: {} }], { seconds: 600, duration: 2520 }, 42, NAMES)
    expect(outcome).toEqual({ ok: false, reason: 'no-playlist' })
    expect(dirs.size).toBe(0)
  })

  it('reports the last save by name, for a person to read', async () => {
    const { files } = memoryFiles()
    const store = await createSegmentStore(files, quiet)
    expect(store.status().last).toBeNull()
    await store.save(WHERE, [{ url: 'https://ads.example/x.js', headers: {} }], { seconds: 600, duration: 2520 }, 42, NAMES)
    expect(store.status().last).toEqual({
      title: 'The Office',
      season: 4,
      episode: 1,
      source: 'VidSrc',
      kept: null,
      reason: 'no-playlist',
    })
    await store.save(WHERE, REQUESTS, { seconds: 600, duration: 2520 }, 42, NAMES)
    expect(store.status().last).toMatchObject({ title: 'The Office', source: 'VidSrc', reason: null, kept: { fromSeconds: expect.any(Number) } })
  })

  it('lets a plan wait for a save of the same title that is under way', async () => {
    const { files, slow } = memoryFiles()
    const store = await createSegmentStore(files, quiet)
    let release!: () => void
    slow(new Promise<void>((resolve) => (release = resolve)))
    void store.save(WHERE, REQUESTS, { seconds: 600, duration: 2520 }, 42, NAMES)
    const waited = store.settled(WHERE.titleKey, 5_000).then(() => store.find(WHERE, 602))
    release()
    expect(await waited).not.toBeNull()
    // Another title does not wait at all.
    await expect(store.settled('movie:tt0137523', 5_000)).resolves.toBeUndefined()
  })
  it('names the source of the window kept for an episode, for a preview no test qualified for', async () => {
    const { files } = memoryFiles()
    const store = await createSegmentStore(files, quiet)
    await store.save(WHERE, REQUESTS, { seconds: 600, duration: 2520 }, 42, NAMES)
    const episode = { titleKey: WHERE.titleKey, season: WHERE.season, episode: WHERE.episode }
    expect(store.keptSource(episode, 602)).toBe('vidsrc-me')
    expect(store.keptSource({ ...episode, episode: 2 }, 602)).toBeNull()
    expect(store.keptSource(episode, 2000)).toBeNull()
  })
})
