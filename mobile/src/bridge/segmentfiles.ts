/**
 * The phone's files and network for the preview cache (`src/main/segmentstore.ts`).
 *
 * Windows live under the app's cache directory, `preview-cache/`: copies of
 * public streams, up to a gigabyte, that Android may reclaim when storage runs
 * low, that "Clear cache" clears, and that backup leaves out. Through 2.0.11
 * they lived in the data directory, where none of that applied, and a few
 * windows pushed the app past Auto Backup's per-app quota, which stops backing
 * up the library as well. Their
 * bytes are fetched by native code straight into the files (`capture.download`,
 * `CastPlugin.downloadToFile`), with the source's headers, which the WebView
 * could not set, and without passing megabytes over the bridge. The page plays
 * them from the app's own origin through `convertFileSrc`: measured 13 ms to the
 * first frame on the emulator. A plain `http://localhost` server would not do;
 * the WebView refuses cleartext traffic (measured 2026-09-29).
 */

import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import type { SaveIo } from '@main/segmentsave'
import type { CacheFiles } from '@main/segmentstore'
import { capture } from './cast'

const ROOT = 'preview-cache'
const DIRECTORY = Directory.Cache
/** Where windows were kept through 2.0.11; emptied once, so the old gigabyte is not stranded there. */
const LEGACY_DIRECTORY = Directory.Data
const INDEX = `${ROOT}/index.json`

/** A URL's text with the source's headers, by native code; with `limitBytes`, only its start. */
export async function fetchText(url: string, headers: Record<string, string>, limitBytes?: number): Promise<{ status: number; body: string } | null> {
  try {
    const response = await capture.text(url, headers, limitBytes)
    return { status: response.status, body: response.body }
  } catch {
    return null
  }
}

function windowIo(dir: string): SaveIo {
  return {
    fetchText,
    async download(url, headers, name) {
      try {
        return await capture.download(url, headers, `${dir}/${name}`)
      } catch {
        return null
      }
    },
    async writeText(name, text) {
      await Filesystem.writeFile({ path: `${dir}/${name}`, directory: DIRECTORY, data: text, encoding: Encoding.UTF8 })
    },
    async remove(name) {
      await Filesystem.deleteFile({ path: `${dir}/${name}`, directory: DIRECTORY }).catch(() => {})
    },
  }
}

export async function phoneCacheFiles(): Promise<CacheFiles> {
  await Filesystem.rmdir({ path: ROOT, directory: LEGACY_DIRECTORY, recursive: true }).catch(() => {})
  await Filesystem.mkdir({ path: ROOT, directory: DIRECTORY, recursive: true }).catch(() => {})
  // The directory's own address, once: `playlistUrl` has to answer at once.
  const { uri } = await Filesystem.getUri({ path: ROOT, directory: DIRECTORY })
  return {
    fetchText,
    async readIndex() {
      try {
        const file = await Filesystem.readFile({ path: INDEX, directory: DIRECTORY, encoding: Encoding.UTF8 })
        return typeof file.data === 'string' ? file.data : null
      } catch {
        return null
      }
    },
    async writeIndex(text) {
      await Filesystem.writeFile({ path: `${INDEX}.tmp`, directory: DIRECTORY, data: text, encoding: Encoding.UTF8 })
      await Filesystem.rename({ from: `${INDEX}.tmp`, to: INDEX, directory: DIRECTORY, toDirectory: DIRECTORY })
    },
    async listWindows() {
      const { files } = await Filesystem.readdir({ path: ROOT, directory: DIRECTORY })
      return files.filter((f) => f.type === 'directory').map((f) => f.name)
    },
    async removeWindow(name) {
      await Filesystem.rmdir({ path: `${ROOT}/${name}`, directory: DIRECTORY, recursive: true }).catch(() => {})
    },
    async renameWindow(from, to) {
      await Filesystem.rename({ from: `${ROOT}/${from}`, to: `${ROOT}/${to}`, directory: DIRECTORY, toDirectory: DIRECTORY })
    },
    async openWindow(name) {
      await Filesystem.mkdir({ path: `${ROOT}/${name}`, directory: DIRECTORY, recursive: true })
      return windowIo(`${ROOT}/${name}`)
    },
    playlistUrl(id) {
      return Capacitor.convertFileSrc(`${uri}/${id}/index.m3u8`)
    },
  }
}
