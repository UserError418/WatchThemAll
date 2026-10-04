/**
 * The phone's half of downloads (`src/shared/downloads/`): capture in a
 * hidden probe session, segments moved and decrypted natively
 * (`DownloadsPlugin.java`), files under the app's data directory. The queue,
 * the plan and the transfer are the shared core the desktop runs too.
 *
 * ## Capture
 *
 * The source loads in a probe session of its own, as "Test all sources" loads
 * it (`probeview.ts`): out of sight, muted, play pressed by the page script.
 * Its request log is the session's alone, with the headers each request
 * carried (`Cookie` included), which is what the segments are fetched with
 * afterwards. It is watched until the first media request and
 * `CAPTURE_LINGER_MS` past it, by which time the player has its master and
 * the rendition it chose.
 *
 * ## Files
 *
 * `files/downloads/<id>/`, and `files/downloads.json` for the records. Not
 * the cache directory, which Android empties when storage runs low, and left
 * out of backup (`data_extraction_rules.xml`). Segments never cross the
 * WebView bridge: the native side stages them and the core reads only their
 * first bytes (`DownloadFiles.stageSegment`). The player plays a download
 * through `download.html`, a page of the app's own, with a `<video>` of the
 * local playlist via `convertFileSrc`; the WebView plays HLS by itself.
 *
 * ## Background
 *
 * While anything is queued or under way, `DownloadKeepAliveService` holds a
 * notification saying what and how far, which keeps the process (and the
 * page driving the queue) alive with the phone in a pocket.
 */

import { Capacitor, registerPlugin } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { isMediaRequest, PLAYLIST_URL, WHOLE_FILE_URL } from '@main/mediarequest'
import type { Provider } from '@shared/types'
import type { CapturedRequest } from '@shared/streamfetch'
import { DownloadManager, type DownloadPlatform, type DownloadSource } from '@shared/downloads/manager'
import { PLAYLIST_FILE } from '@shared/downloads/plan'
import type { DownloadFiles } from '@shared/downloads/transfer'
import type { DownloadsStatus, DownloadSubject, DownloadView } from '@shared/downloads/types'
import { capture } from './cast'
import { openProbe, type ProbeRequest } from './probeview'
import { isScanCandidate } from './scanjudge'
import { fetchText } from './segmentfiles'

interface DownloadsNative {
  stageSegment(options: {
    url: string
    headers: Record<string, string>
    path: string
    key?: string
    iv?: string
  }): Promise<{ status: number; bytes: number; head: string }>
  commitSegment(options: { path: string; skip: number }): Promise<{ bytes: number }>
  discardSegment(options: { path: string }): Promise<void>
  freeBytes(): Promise<{ bytes: number }>
  keepAlive(options: { active: boolean; title?: string; text?: string; percent?: number }): Promise<void>
}

const Downloads = registerPlugin<DownloadsNative>('Downloads')

const DIRECTORY = Directory.Data
const ROOT = 'downloads'
const RECORDS = 'downloads.json'
const POSTER_FILE = 'poster.jpg'
const PART = '.part'

/** How long a capture waits for the source's first media request. Slow sources chain several API calls first. */
const CAPTURE_TIMEOUT_MS = 30_000
/** How long it keeps watching after it: the master, then the rendition the player chose. */
const CAPTURE_LINGER_MS = 8_000
const POLL_MS = 500
/** Keys and init segments are a few kilobytes; a poster a few dozen. */
const SMALL_FILE_LIMIT = 4 * 1024 * 1024
/** The page `download.html` plays in, from the app's own origin. */
const PLAY_PAGE = '/download.html'

export interface PhoneDownloadDeps {
  /** The sources to try, best first, as Resume would: see `DownloadPlatform.sources`. */
  sources: (subject: DownloadSubject, preferredProviderId: string | null) => DownloadSource[]
  /** The source's URL for this title, as the player would load it; null when it cannot express it. */
  sourceUrl: (providerId: string, subject: DownloadSubject) => string | null
  publish: (status: DownloadsStatus) => void
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function fetchBytes(url: string, headers: Record<string, string>): Promise<{ status: number; bytes: Uint8Array } | null> {
  try {
    return await capture.bytes(url, headers, SMALL_FILE_LIMIT)
  } catch {
    return null
  }
}

/** Write a file whole or not at all: a `.part` renamed into place. */
async function writeWhole(path: string, data: string, encoding?: Encoding): Promise<void> {
  await Filesystem.writeFile({ path: `${path}${PART}`, directory: DIRECTORY, data, ...(encoding ? { encoding } : {}) })
  await Filesystem.rename({ from: `${path}${PART}`, to: path, directory: DIRECTORY, toDirectory: DIRECTORY })
}

async function readText(path: string): Promise<string | null> {
  try {
    const file = await Filesystem.readFile({ path, directory: DIRECTORY, encoding: Encoding.UTF8 })
    return typeof file.data === 'string' ? file.data : null
  } catch {
    return null
  }
}

function folderFiles(id: string): DownloadFiles {
  const dir = `${ROOT}/${id}`
  return {
    fetchBytes: (url, headers) => fetchBytes(url, headers),
    async stageSegment(url, headers, name, crypt) {
      try {
        const staged = await Downloads.stageSegment({
          url,
          headers,
          path: `${id}/${name}`,
          ...(crypt ? { key: toBase64(crypt.key), iv: toBase64(crypt.iv) } : {}),
        })
        return { status: staged.status, bytes: staged.bytes, head: fromBase64(staged.head) }
      } catch {
        return null
      }
    },
    async commitSegment(name, skip) {
      return (await Downloads.commitSegment({ path: `${id}/${name}`, skip })).bytes
    },
    async discardSegment(name) {
      await Downloads.discardSegment({ path: `${id}/${name}` }).catch(() => {})
    },
    async list() {
      const { files } = await Filesystem.readdir({ path: dir, directory: DIRECTORY }).catch(() => ({ files: [] }))
      return files.filter((f) => f.type === 'file' && !f.name.endsWith(PART)).map((f) => ({ name: f.name, bytes: f.size }))
    },
    write: (name, bytes) => writeWhole(`${dir}/${name}`, toBase64(bytes)),
    readText: (name) => readText(`${dir}/${name}`),
    writeText: (name, text) => writeWhole(`${dir}/${name}`, text, Encoding.UTF8),
    async remove(name) {
      await Filesystem.deleteFile({ path: `${dir}/${name}`, directory: DIRECTORY }).catch(() => {})
    },
  }
}

/**
 * What the source's page fetched while it played, newest first: playlists
 * before everything else, segments and whole files left out (the plan needs
 * the playlists; a player that has started fetches dozens of segments).
 */
async function captureSource(url: string): Promise<CapturedRequest[]> {
  const session = await openProbe({ url }).catch(() => null)
  if (session === null) return []
  const requests: ProbeRequest[] = []
  try {
    const started = Date.now()
    let firstMediaAt: number | null = null
    while (Date.now() - started < CAPTURE_TIMEOUT_MS + CAPTURE_LINGER_MS) {
      const answer = await session.poll()
      requests.push(...answer.requests)
      if (firstMediaAt === null && (answer.playingAtMs !== null || answer.requests.some((r) => isMediaRequest(r.url)))) firstMediaAt = Date.now()
      if (firstMediaAt !== null && Date.now() - firstMediaAt >= CAPTURE_LINGER_MS) break
      if (firstMediaAt === null && Date.now() - started >= CAPTURE_TIMEOUT_MS) break
      if (!answer.open) break
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  } finally {
    await session.close().catch(() => {})
  }
  const seen = new Set<string>()
  const playlists: CapturedRequest[] = []
  const others: CapturedRequest[] = []
  for (const request of requests.reverse()) {
    if (!isScanCandidate(request) || seen.has(request.url)) continue
    seen.add(request.url)
    if (PLAYLIST_URL.test(request.url)) playlists.push({ url: request.url, headers: request.headers })
    else if (!isMediaRequest(request.url) && !WHOLE_FILE_URL.test(request.url)) others.push({ url: request.url, headers: request.headers })
  }
  return [...playlists, ...others]
}

/** The notification's words for the download under way, or null when nothing is queued. */
function keepAliveFor(downloads: readonly DownloadView[]): { title: string; text: string; percent: number } | null {
  const running = downloads.find((d) => d.state === 'capturing' || d.state === 'downloading')
  const queued = downloads.filter((d) => d.state === 'queued').length
  if (!running && queued === 0) return null
  const label = (d: DownloadView): string =>
    d.subject.type === 'tv' ? `${d.subject.title} · S${d.subject.season}E${d.subject.episode}` : d.subject.title
  const more = queued > 0 ? ` · ${queued} waiting` : ''
  if (!running) return { title: 'Downloads waiting', text: `${queued} waiting`, percent: -1 }
  if (running.state === 'capturing') return { title: `Downloading ${label(running)}`, text: `Finding the stream${more}`, percent: -1 }
  const percent = running.segmentsTotal > 0 ? Math.floor((running.segmentsDone / running.segmentsTotal) * 100) : -1
  return { title: `Downloading ${label(running)}`, text: `${Math.max(0, percent)}%${more}`, percent }
}

/** The phone's downloads, loaded and running. */
export async function createPhoneDownloads(deps: PhoneDownloadDeps): Promise<{
  manager: DownloadManager
  /** The address `download.html` plays a finished download from. */
  playUrl: (id: string) => string
}> {
  await Filesystem.mkdir({ path: ROOT, directory: DIRECTORY, recursive: true }).catch(() => {})
  // The directory's own address, once: `posterUrl` and `playUrl` answer at once.
  const { uri } = await Filesystem.getUri({ path: ROOT, directory: DIRECTORY })
  const fileUrl = (id: string, file: string): string => Capacitor.convertFileSrc(`${uri}/${id}/${file}`)

  let lastKeepAlive = ''
  const keepAlive = (status: DownloadsStatus): void => {
    const words = keepAliveFor(status.downloads)
    const key = JSON.stringify(words)
    if (key === lastKeepAlive) return
    lastKeepAlive = key
    void Downloads.keepAlive(words ? { active: true, ...words } : { active: false }).catch((error: unknown) =>
      console.log(`[downloads] ${String(error)}`),
    )
  }

  const platform: DownloadPlatform = {
    readRecords: () => readText(RECORDS),
    writeRecords: (text) => writeWhole(RECORDS, text, Encoding.UTF8),
    sources: async (subject, preferred) => deps.sources(subject, preferred),
    async capture(subject, source) {
      const url = deps.sourceUrl(source.id, subject)
      return url === null ? [] : captureSource(url)
    },
    fetch: { fetchText },
    async folder(id) {
      await Filesystem.mkdir({ path: `${ROOT}/${id}`, directory: DIRECTORY, recursive: true }).catch(() => {})
      return folderFiles(id)
    },
    async removeFolder(id) {
      await Filesystem.rmdir({ path: `${ROOT}/${id}`, directory: DIRECTORY, recursive: true }).catch(() => {})
    },
    async listFolders() {
      const { files } = await Filesystem.readdir({ path: ROOT, directory: DIRECTORY })
      return files.filter((f) => f.type === 'directory').map((f) => f.name)
    },
    async freeBytes() {
      return (await Downloads.freeBytes()).bytes
    },
    async savePoster(id, posterPath) {
      const got = await fetchBytes(`https://image.tmdb.org/t/p/w342${posterPath}`, {})
      if (got === null || got.status !== 200 || got.bytes.length === 0) return null
      await writeWhole(`${ROOT}/${id}/${POSTER_FILE}`, toBase64(got.bytes))
      return POSTER_FILE
    },
    posterUrl: (id, file) => fileUrl(id, file),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    publish: (status) => {
      keepAlive(status)
      deps.publish(status)
    },
    log: (line) => console.log(`[downloads] ${line}`),
  }
  const manager = new DownloadManager(platform)
  await manager.load()
  return {
    manager,
    playUrl: (id) => `${location.origin}${PLAY_PAGE}?src=${encodeURIComponent(fileUrl(id, PLAYLIST_FILE))}`,
  }
}

/** A download's local playlist, for casting it; null when it cannot be read. */
export function readDownloadPlaylist(id: string): Promise<string | null> {
  return readText(`${ROOT}/${id}/${PLAYLIST_FILE}`)
}

/** A provider as the player's candidate list needs it, for a finished download. */
export function downloadedProvider(id: string, name: string): Provider {
  return { id, name, rootUrl: location.origin, tv: null, movie: null }
}
