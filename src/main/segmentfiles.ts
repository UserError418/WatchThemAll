/**
 * The desktop's files and network for the preview cache (`segmentstore.ts`):
 * windows under the user data directory, fetched with Node's `fetch`, which
 * may set the headers a browser would refuse (`Referer`, `Origin`). The local
 * server serves them under `CACHE_PATH` (`localserver.ts`), so the detail
 * view's `<video>` loads them from the app's own origin and its content
 * security policy needs nothing new.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { replayableHeaders } from './castproxy'
import type { SaveIo } from './segmentsave'
import type { CacheFiles } from './segmentstore'

/** Where the local server serves the windows from. */
export const CACHE_PATH = '/__cache'

const INDEX_FILE = 'index.json'
const PLAYLIST_TIMEOUT_MS = 10_000
const SEGMENT_TIMEOUT_MS = 20_000
/** Enough of a segment's head to tell video from an error page. */
const HEAD_BYTES = 400

/** A URL's text with the source's headers; with `limitBytes`, only its start, and the rest is never downloaded. */
async function fetchText(url: string, headers: Record<string, string>, limitBytes?: number): Promise<{ status: number; body: string } | null> {
  try {
    const response = await fetch(url, { headers: replayableHeaders(headers), signal: AbortSignal.timeout(PLAYLIST_TIMEOUT_MS) })
    if (limitBytes === undefined || response.body === null) return { status: response.status, body: await response.text() }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    while (length < limitBytes) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      length += value.length
    }
    void reader.cancel().catch(() => {})
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return { status: response.status, body: new TextDecoder().decode(bytes.subarray(0, limitBytes)) }
  } catch {
    return null
  }
}

function windowIo(dir: string): SaveIo {
  return {
    fetchText,
    async download(url, headers, name) {
      try {
        const response = await fetch(url, { headers: replayableHeaders(headers), signal: AbortSignal.timeout(SEGMENT_TIMEOUT_MS) })
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (response.ok) await writeFile(join(dir, name), bytes)
        return { status: response.status, bytes: response.ok ? bytes.length : 0, head: bytes.subarray(0, HEAD_BYTES) }
      } catch {
        return null
      }
    },
    async writeText(name, text) {
      await writeFile(join(dir, name), text, 'utf8')
    },
    async remove(name) {
      await rm(join(dir, name), { force: true })
    },
  }
}

/** `root`: the cache's directory. `baseUrl`: the local server's, for the playlists' addresses. */
export async function nodeCacheFiles(root: string, baseUrl: () => string | null): Promise<CacheFiles> {
  await mkdir(root, { recursive: true })
  return {
    fetchText,
    async readIndex() {
      try {
        return await readFile(join(root, INDEX_FILE), 'utf8')
      } catch {
        return null
      }
    },
    async writeIndex(text) {
      await writeFile(join(root, `${INDEX_FILE}.tmp`), text, 'utf8')
      await rename(join(root, `${INDEX_FILE}.tmp`), join(root, INDEX_FILE))
    },
    async listWindows() {
      return (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    },
    async removeWindow(name) {
      await rm(join(root, name), { recursive: true, force: true })
    },
    async renameWindow(from, to) {
      await rename(join(root, from), join(root, to))
    },
    async openWindow(name) {
      await mkdir(join(root, name), { recursive: true })
      return windowIo(join(root, name))
    },
    playlistUrl(id) {
      return `${baseUrl() ?? ''}${CACHE_PATH}/${id}/index.m3u8`
    },
  }
}
