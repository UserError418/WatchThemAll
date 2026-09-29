/**
 * The desktop's preview cache on disk: the windows' files under the user data
 * directory, the index beside them, and saves one at a time.
 *
 * The cutting, the fetching order and the book-keeping are the shared modules
 * (`segmentwindow.ts`, `segmentsave.ts`, `segmentcache.ts`); this is the part
 * that is Node's: files, and `fetch` with headers a browser would refuse to
 * set. The local server serves the files to the detail view's `<video>` under
 * `CACHE_PATH` (`localserver.ts`), so they come from the app's own origin and
 * its content security policy needs nothing new.
 *
 * A window is written into `<id>.part` and renamed when complete, so a crash
 * mid-save leaves a directory the next start removes, never a half window the
 * index points at.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { replayableHeaders } from './castproxy'
import {
  admitWindow,
  readIndex,
  windowFor,
  windowId,
  writeIndex,
  type CachedWindow,
} from './segmentcache'
import { saveStreamWindow, type CapturedRequest, type SaveIo, type SaveOutcome } from './segmentsave'

/** Where the local server serves the windows from. */
export const CACHE_PATH = '/__cache'

const INDEX_FILE = 'index.json'
const PLAYLIST_TIMEOUT_MS = 10_000
const SEGMENT_TIMEOUT_MS = 20_000
/** Enough of a segment's head to tell video from an error page. */
const HEAD_BYTES = 400

export interface WindowWhere {
  titleKey: string
  season: number | null
  episode: number | null
  providerId: string
}

export interface SegmentStore {
  /** Where the kept window for this preview is served, and what it covers; null when there is none. */
  find(where: WindowWhere, seconds: number): { path: string; startSeconds: number; endSeconds: number; filmSeconds: number } | null
  /**
   * Keep a window of what the page fetched, from `from.seconds`. Saves run one
   * at a time, in order; the promise settles when this one is done.
   */
  save(
    where: WindowWhere,
    requests: readonly CapturedRequest[],
    from: { seconds: number; duration: number },
    expectedMinutes: number | null,
  ): Promise<SaveOutcome>
  /**
   * Settles when a save for this title that is under way has finished, or
   * after `timeoutMs`. The preview asks for its plan the moment the player
   * closes, which is also the moment the player's window starts saving.
   */
  settled(titleKey: string, timeoutMs: number): Promise<void>
  /** The directory the windows live in. */
  readonly root: string
}

function nodeIo(dir: string): SaveIo {
  return {
    async fetchText(url, headers) {
      try {
        const response = await fetch(url, { headers: replayableHeaders(headers), signal: AbortSignal.timeout(PLAYLIST_TIMEOUT_MS) })
        return { status: response.status, body: await response.text() }
      } catch {
        return null
      }
    },
    async download(url, headers, name) {
      try {
        const response = await fetch(url, { headers: replayableHeaders(headers), signal: AbortSignal.timeout(SEGMENT_TIMEOUT_MS) })
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (response.ok) await writeFile(join(dir, name), bytes)
        return { status: response.status, bytes: bytes.length, head: bytes.subarray(0, HEAD_BYTES) }
      } catch {
        return null
      }
    },
    async writeText(name, text) {
      await writeFile(join(dir, name), text, 'utf8')
    },
  }
}

export async function createSegmentStore(root: string): Promise<SegmentStore> {
  await mkdir(root, { recursive: true })
  let index: CachedWindow[] = []
  try {
    index = readIndex(JSON.parse(await readFile(join(root, INDEX_FILE), 'utf8')))
  } catch {
    // No index yet, or a damaged one: start empty, and the sweep below clears the files.
  }
  // Anything on disk the index does not name: an interrupted save, or a window
  // whose index entry was lost.
  const named = new Set(index.map((w) => w.id))
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !named.has(entry.name)) await rm(join(root, entry.name), { recursive: true, force: true })
  }

  const persist = async (): Promise<void> => {
    await writeFile(join(root, `${INDEX_FILE}.tmp`), writeIndex(index), 'utf8')
    await rename(join(root, `${INDEX_FILE}.tmp`), join(root, INDEX_FILE))
  }

  let queue: Promise<unknown> = Promise.resolve()
  /** Saves not yet finished, by title. */
  const pending = new Map<string, Promise<unknown>>()

  const saveNow = async (
    where: WindowWhere,
    requests: readonly CapturedRequest[],
    from: { seconds: number; duration: number },
    expectedMinutes: number | null,
  ): Promise<SaveOutcome> => {
    const now = Date.now()
    const id = windowId(where, now)
    const part = join(root, `${id}.part`)
    await mkdir(part, { recursive: true })
    const outcome = await saveStreamWindow(requests, from, expectedMinutes, nodeIo(part))
    if (!outcome.ok) {
      await rm(part, { recursive: true, force: true })
      console.log(`[cache] not kept: ${outcome.reason} (${where.titleKey} ${where.providerId})`)
      return outcome
    }
    await rename(part, join(root, id))
    const admitted = admitWindow(index, {
      id,
      ...where,
      startSeconds: outcome.startSeconds,
      endSeconds: outcome.endSeconds,
      filmSeconds: from.duration,
      bytes: outcome.bytes,
      savedAt: now,
    })
    index = admitted.index
    await persist()
    for (const dropped of admitted.drop) await rm(join(root, dropped.id), { recursive: true, force: true })
    console.log(
      `[cache] kept ${Math.round(outcome.endSeconds - outcome.startSeconds)} s from ${Math.round(outcome.startSeconds)} s, ` +
        `${(outcome.bytes / 1e6).toFixed(1)} MB (${where.titleKey} ${where.providerId})`,
    )
    return outcome
  }

  return {
    root,
    find(where, seconds) {
      const found = windowFor(index, where, seconds)
      return (
        found && {
          path: `${CACHE_PATH}/${found.id}/index.m3u8`,
          startSeconds: found.startSeconds,
          endSeconds: found.endSeconds,
          filmSeconds: found.filmSeconds,
        }
      )
    },
    save(where, requests, from, expectedMinutes) {
      const run = queue.then(() => saveNow(where, requests, from, expectedMinutes))
      queue = run.catch(() => {})
      const settled = run.catch((error: unknown) => ({ ok: false as const, reason: String(error) }))
      pending.set(where.titleKey, settled)
      void settled.then(() => {
        if (pending.get(where.titleKey) === settled) pending.delete(where.titleKey)
      })
      return settled
    },
    async settled(titleKey, timeoutMs) {
      const saving = pending.get(titleKey)
      if (saving === undefined) return
      await Promise.race([saving, new Promise((resolve) => setTimeout(resolve, timeoutMs))])
    },
  }
}
