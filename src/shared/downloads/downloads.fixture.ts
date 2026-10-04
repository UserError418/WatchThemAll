/**
 * A pretend network and folder for the downloads tests: routes answered from
 * a table, and files kept in a map, so the queue, the plan and the transfer
 * run end to end without a socket or a disk.
 */

import { memoryStaging } from './staging'
import type { DownloadFiles } from './transfer'

/** A clear MPEG-TS segment: sync bytes every 188, tagged so tests can tell segments apart. */
export function tsSegment(tag: number, length = 564): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i += 188) bytes[i] = 0x47
  bytes[1] = tag
  return bytes
}

export type Route = { status: number; body: string | Uint8Array } | ((count: number) => { status: number; body: string | Uint8Array } | null)

/** A network answering from `routes`; unknown URLs are unreachable (null). Counts every request. */
export function fakeNetwork(routes: Record<string, Route>) {
  const counts = new Map<string, number>()
  const answer = (url: string): { status: number; body: string | Uint8Array } | null => {
    const count = (counts.get(url) ?? 0) + 1
    counts.set(url, count)
    const route = routes[url]
    if (route === undefined) return null
    return typeof route === 'function' ? route(count) : route
  }
  return {
    routes,
    counts,
    async fetchText(url: string, _headers: Record<string, string>, limitBytes?: number) {
      const got = answer(url)
      if (got === null) return null
      const body = typeof got.body === 'string' ? got.body : new TextDecoder().decode(got.body)
      return { status: got.status, body: limitBytes === undefined ? body : body.slice(0, limitBytes) }
    },
    async fetchBytes(url: string) {
      const got = answer(url)
      if (got === null) return null
      return { status: got.status, bytes: typeof got.body === 'string' ? new TextEncoder().encode(got.body) : got.body }
    },
  }
}

/** A download folder in memory, fetching through `network`. */
export function memoryFolder(network: ReturnType<typeof fakeNetwork>): DownloadFiles & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>()
  const fetchBytes: DownloadFiles['fetchBytes'] = (url) => network.fetchBytes(url)
  return {
    files,
    fetchBytes,
    ...memoryStaging(fetchBytes, async (name, bytes) => void files.set(name, bytes.slice())),
    async list() {
      return [...files.entries()].map(([name, bytes]) => ({ name, bytes: bytes.length }))
    },
    async write(name, bytes) {
      files.set(name, bytes.slice())
    },
    async readText(name) {
      const bytes = files.get(name)
      return bytes ? new TextDecoder().decode(bytes) : null
    },
    async writeText(name, text) {
      files.set(name, new TextEncoder().encode(text))
    },
    async remove(name) {
      files.delete(name)
    },
  }
}

/** A media playlist of `count` segments of `seconds` each, under `base`. */
export function mediaPlaylist(base: string, count: number, seconds: number, extra: { key?: string; map?: string } = {}): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(seconds)}`, '#EXT-X-MEDIA-SEQUENCE:0']
  if (extra.key) lines.push(extra.key)
  if (extra.map) lines.push(extra.map)
  for (let i = 0; i < count; i++) lines.push(`#EXTINF:${seconds},`, `${base}/seg${i}`)
  lines.push('#EXT-X-ENDLIST')
  return lines.join('\n')
}
