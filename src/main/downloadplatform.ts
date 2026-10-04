/**
 * The desktop's half of downloads (`shared/downloads/`): hidden capture
 * through the source tests' own probe, Node's `fetch` with a source's
 * headers, and files under the user data directory. Everything else, the
 * queue, the plan, the transfer, is the shared core the phone runs too.
 *
 * ## Capture
 *
 * `probeStream` loads the source exactly as "Test all sources" does (the
 * bare shell, the ad rules, the presses on play), muted, and keeps watching
 * `CAPTURE_LINGER_MS` after the first media request, by which time a player
 * has fetched its master and the rendition it chose. Every response is kept
 * with the headers Chromium sent for it (`Cookie` included); segments are
 * left out, because a player that has started fetches dozens and the
 * playlists are what the plan needs.
 *
 * ## Files
 *
 * `userData/downloads/<id>/`, served by the local server under
 * `DOWNLOADS_PATH` so the player and the app window load them from the
 * app's own origin. Every write goes to `<name>.part` and is renamed when
 * complete, which is the "whole or not at all" `DownloadFiles` promises: the
 * folder listing is what a resumed download trusts.
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Provider } from '@shared/types'
import type { CapturedRequest } from '@shared/streamfetch'
import { DownloadManager, type DownloadPlatform, type DownloadSource } from '@shared/downloads/manager'
import type { DownloadFiles } from '@shared/downloads/transfer'
import type { DownloadsStatus, DownloadSubject } from '@shared/downloads/types'
import { replayableHeaders } from './castproxy'
import { mediaKind } from './mediarequest'
import { fetchText } from './segmentfiles'
import { probeStream } from './streamprobe'

/** Where the local server serves the downloads from. */
export const DOWNLOADS_PATH = '/__downloads'

/** How long a capture waits for the source's first media request. Slow sources chain several API calls first. */
const CAPTURE_TIMEOUT_MS = 30_000
/** How long it keeps watching after it: the master, then the rendition the player chose. */
const CAPTURE_LINGER_MS = 8_000
/** One segment's fetch, whole. A large 1080p segment on a slow line takes a while. */
const SEGMENT_TIMEOUT_MS = 60_000

const POSTER_FILE = 'poster.jpg'
const PART = '.part'

export interface DesktopDownloadDeps {
  /** `userData/downloads`. */
  root: string
  /** `downloads.json`, beside the library. */
  recordsFile: string
  /** The sources to try, best first, as Resume would: see `DownloadPlatform.sources`. */
  sources: (subject: DownloadSubject, preferredProviderId: string | null) => DownloadSource[]
  provider: (id: string) => Provider | null
  /** The bare player shell, as the source tests frame a source. */
  frameUrl: (providerUrl: string) => string
  /** The local server's address, once it runs. */
  baseUrl: () => string | null
  publish: (status: DownloadsStatus) => void
}

async function fetchBytes(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ status: number; bytes: Uint8Array } | null> {
  try {
    const response = await fetch(url, {
      headers: replayableHeaders(headers),
      signal: AbortSignal.any([signal, AbortSignal.timeout(SEGMENT_TIMEOUT_MS)]),
    })
    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) }
  } catch {
    return null
  }
}

async function writeWhole(path: string, data: Uint8Array | string): Promise<void> {
  await writeFile(`${path}${PART}`, data)
  await rename(`${path}${PART}`, path)
}

function folderFiles(dir: string): DownloadFiles {
  return {
    fetchBytes,
    async list() {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      const files = entries.filter((e) => e.isFile() && !e.name.endsWith(PART))
      return Promise.all(files.map(async (e) => ({ name: e.name, bytes: (await stat(join(dir, e.name))).size })))
    },
    write: (name, bytes) => writeWhole(join(dir, name), bytes),
    async readText(name) {
      return readFile(join(dir, name), 'utf8').catch(() => null)
    },
    writeText: (name, text) => writeWhole(join(dir, name), text),
    async remove(name) {
      await rm(join(dir, name), { force: true })
    },
    async concat(names, name) {
      const target = join(dir, `${name}${PART}`)
      const out = createWriteStream(target)
      try {
        for (const part of names) await pipeline(createReadStream(join(dir, part)), out, { end: false })
      } finally {
        await new Promise<void>((resolve) => out.end(resolve))
      }
      await rename(target, join(dir, name))
    },
  }
}

/**
 * What the source's page fetched while it played, newest first: playlists
 * before everything else, segments and whole files left out.
 */
async function capture(deps: DesktopDownloadDeps, subject: DownloadSubject, source: DownloadSource): Promise<CapturedRequest[]> {
  const provider = deps.provider(source.id)
  if (provider === null) return []
  const playlists: CapturedRequest[] = []
  const others: CapturedRequest[] = []
  const seen = new Set<string>()
  await probeStream(
    provider,
    {
      imdbId: subject.imdbId ?? '',
      tmdbId: subject.tmdbId,
      type: subject.type,
      season: subject.season ?? undefined,
      episode: subject.episode ?? undefined,
      label: subject.title,
      runtimeMinutes: subject.runtimeMinutes,
    },
    {
      timeoutMs: CAPTURE_TIMEOUT_MS,
      lingerMs: CAPTURE_LINGER_MS,
      frameUrl: deps.frameUrl,
      muted: true,
      onResponse: (response) => {
        if (response.statusCode >= 400 || seen.has(response.url) || !/^https?:/.test(response.url)) return
        const kind = mediaKind(response.url, response.resourceType, response.mime, response.totalBytes)
        if (kind === 'segment' || kind === 'file') return
        if (!['xhr', 'fetch', 'media', 'other'].includes(response.resourceType) && kind !== 'playlist') return
        seen.add(response.url)
        ;(kind === 'playlist' ? playlists : others).push({ url: response.url, headers: response.headers })
      },
    },
  )
  return [...playlists.reverse(), ...others.reverse()]
}

/** The desktop's downloads, loaded and running. */
export async function createDesktopDownloads(deps: DesktopDownloadDeps): Promise<DownloadManager> {
  await mkdir(deps.root, { recursive: true })
  const platform: DownloadPlatform = {
    readRecords: () => readFile(deps.recordsFile, 'utf8').catch(() => null),
    writeRecords: (text) => writeWhole(deps.recordsFile, text),
    sources: async (subject, preferred) => deps.sources(subject, preferred),
    capture: (subject, source) => capture(deps, subject, source),
    fetch: { fetchText },
    async folder(id) {
      const dir = join(deps.root, id)
      await mkdir(dir, { recursive: true })
      return folderFiles(dir)
    },
    removeFolder: (id) => rm(join(deps.root, id), { recursive: true, force: true }),
    async listFolders() {
      return (await readdir(deps.root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    },
    async freeBytes() {
      const info = await statfs(deps.root)
      return info.bavail * info.bsize
    },
    async savePoster(id, posterPath) {
      const got = await fetchBytes(`https://image.tmdb.org/t/p/w342${posterPath}`, {}, new AbortController().signal)
      if (got === null || got.status !== 200 || got.bytes.length === 0) return null
      await writeWhole(join(deps.root, id, POSTER_FILE), got.bytes)
      return POSTER_FILE
    },
    posterUrl: (id, file) => {
      const base = deps.baseUrl()
      return base === null ? null : `${base}${DOWNLOADS_PATH}/${id}/${file}`
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    publish: deps.publish,
    log: (line) => console.log(`[downloads] ${line}`),
  }
  const manager = new DownloadManager(platform)
  await manager.load()
  return manager
}

/** The page the player frames to play a download: our own `<video>` of its local playlist. */
export function downloadPlayUrl(baseUrl: string, id: string): string {
  return `${baseUrl}${DOWNLOADS_PATH}/${id}/play.html`
}
