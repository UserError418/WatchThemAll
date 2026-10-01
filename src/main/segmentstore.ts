/**
 * The preview cache's store: the windows on disk, the index beside them,
 * and saves one at a time. The same on both platforms; what differs, files
 * and fetching with a source's headers, is `CacheFiles` (the desktop's in
 * `segmentfiles.ts`, the phone's in `mobile/src/bridge/segmentfiles.ts`).
 *
 * The cutting, the fetching order and the book-keeping are the shared
 * modules (`segmentwindow.ts`, `segmentsave.ts`, `segmentcache.ts`). A window
 * is written into `<id>.part` and renamed when complete, so a crash mid-save
 * leaves a directory the next start removes, never a half window the index
 * points at.
 */

import type { PreviewCacheSave, PreviewCacheStatus } from '@shared/ipc'
import { admitWindow, readIndex, windowFor, windowId, windowOfTitle, writeIndex, type CachedWindow } from './segmentcache'
import {
  findStreamPlaylist,
  saveStreamWindow,
  type CapturedRequest,
  type SaveIo,
  type SaveOutcome,
  type StreamFetch,
} from './segmentsave'

export interface WindowWhere {
  titleKey: string
  season: number | null
  episode: number | null
  providerId: string
}

/** A platform's files and network, as the store needs them. */
export interface CacheFiles extends StreamFetch {
  /** The index's text, or null when there is none yet. */
  readIndex(): Promise<string | null>
  /** Replace the index, atomically. */
  writeIndex(text: string): Promise<void>
  /** The window directories on disk. */
  listWindows(): Promise<string[]>
  removeWindow(name: string): Promise<void>
  renameWindow(from: string, to: string): Promise<void>
  /** Create a window directory, and the fetching and writing that fills it. */
  openWindow(name: string): Promise<SaveIo>
  /** Where the page loads a kept window's playlist from. */
  playlistUrl(id: string): string
}

export interface KeptWindow {
  src: string
  startSeconds: number
  endSeconds: number
  filmSeconds: number
}

/** What a save is of, by name, for the status line: the keys in `WindowWhere` are not for reading. */
export interface SaveNames {
  title: string
  source: string
}

export interface SegmentStore {
  /** The kept window for this preview, and what it covers; null when there is none. */
  find(where: WindowWhere, seconds: number): KeptWindow | null
  /**
   * The source of the window kept for this episode, if it covers `seconds`.
   * A title keeps one window, so there is at most one. For a preview no
   * test here qualified for: that source streamed on this device.
   */
  keptSource(where: Omit<WindowWhere, 'providerId'>, seconds: number): string | null
  /** How many titles and bytes are kept, and what the last save did. */
  status(): PreviewCacheStatus
  /**
   * Keep a window of what the page fetched, from `from.seconds`. Saves run one
   * at a time, in order; the promise settles when this one is done. The
   * requests may still be on their way (the phone reads them from native
   * code): the save counts as under way from this call, for `settled`.
   */
  save(
    where: WindowWhere,
    requests: readonly CapturedRequest[] | Promise<readonly CapturedRequest[]>,
    from: { seconds: number; duration: number },
    expectedMinutes: number | null,
    names: SaveNames,
  ): Promise<SaveOutcome>
  /**
   * Settles when a save for this title that is under way has finished, or
   * after `timeoutMs`. The preview asks for its plan the moment the player
   * closes, which is also the moment the player's window starts saving.
   */
  settled(titleKey: string, timeoutMs: number): Promise<void>
  /**
   * The page is playing the film now: find its playlist among what it has
   * fetched so far, and remember it for this title and source, to be tried
   * first when the window is kept. Nothing is downloaded but playlist heads.
   */
  notePlaylist(
    where: WindowWhere,
    requests: readonly CapturedRequest[] | Promise<readonly CapturedRequest[]>,
    filmSeconds: number,
    expectedMinutes: number | null,
  ): Promise<void>
}

export async function createSegmentStore(files: CacheFiles, log: (line: string) => void = console.log): Promise<SegmentStore> {
  let index: CachedWindow[] = []
  try {
    const text = await files.readIndex()
    if (text !== null) index = readIndex(JSON.parse(text))
  } catch {
    // A damaged index: start empty, and the sweep below clears the files.
  }
  // Anything on disk the index does not name: an interrupted save, or a
  // window whose index entry was lost.
  const named = new Set(index.map((w) => w.id))
  for (const name of await files.listWindows()) {
    if (!named.has(name)) await files.removeWindow(name)
  }

  let queue: Promise<unknown> = Promise.resolve()
  /** Saves not yet finished, by title. */
  const pending = new Map<string, Promise<unknown>>()
  /** The playlist each title's page was seen playing, by title and source (`notePlaylist`). */
  const playlists = new Map<string, CapturedRequest>()
  const playlistKey = (where: WindowWhere): string => `${where.titleKey}|${where.season}|${where.episode}|${where.providerId}`

  /** The last save's outcome, for `status`. */
  let last: PreviewCacheSave | null = null
  const report = (save: PreviewCacheSave, where: WindowWhere): void => {
    last = save
    // The log keeps the keys: it is read next to the requests they explain.
    const what = save.kept
      ? `kept ${save.kept.seconds} s from ${save.kept.fromSeconds} s, ${(save.kept.bytes / 1e6).toFixed(1)} MB`
      : `not kept: ${save.reason}`
    log(`[cache] ${what} (${where.titleKey} ${where.providerId})`)
  }

  const saveNow = async (
    where: WindowWhere,
    requests: readonly CapturedRequest[] | Promise<readonly CapturedRequest[]>,
    from: { seconds: number; duration: number },
    expectedMinutes: number | null,
    names: SaveNames,
  ): Promise<SaveOutcome> => {
    const about = { title: names.title, source: names.source, season: where.season, episode: where.episode }
    const now = Date.now()
    const id = windowId(where, now)
    const part = `${id}.part`
    const io: SaveIo = await files.openWindow(part)
    const noted = playlists.get(playlistKey(where))
    const outcome = await saveStreamWindow([...(noted ? [noted] : []), ...(await requests)], from, expectedMinutes, io)
    if (!outcome.ok) {
      await files.removeWindow(part)
      report({ ...about, kept: null, reason: outcome.reason }, where)
      return outcome
    }
    await files.renameWindow(part, id)
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
    await files.writeIndex(writeIndex(index))
    for (const dropped of admitted.drop) await files.removeWindow(dropped.id)
    report(
      {
        ...about,
        kept: {
          seconds: Math.round(outcome.endSeconds - outcome.startSeconds),
          fromSeconds: Math.round(outcome.startSeconds),
          bytes: outcome.bytes,
        },
        reason: null,
      },
      where,
    )
    return outcome
  }

  return {
    find(where, seconds) {
      const found = windowFor(index, where, seconds)
      return (
        found && {
          src: files.playlistUrl(found.id),
          startSeconds: found.startSeconds,
          endSeconds: found.endSeconds,
          filmSeconds: found.filmSeconds,
        }
      )
    },
    status() {
      return { titles: index.length, bytes: index.reduce((sum, w) => sum + w.bytes, 0), last }
    },
    keptSource(where, seconds) {
      const title = windowOfTitle(index, where.titleKey)
      if (title === null || title.season !== where.season || title.episode !== where.episode) return null
      return windowFor(index, { ...where, providerId: title.providerId }, seconds) === null ? null : title.providerId
    },
    save(where, requests, from, expectedMinutes, names) {
      const run = queue.then(() => saveNow(where, requests, from, expectedMinutes, names))
      queue = run.catch(() => {})
      const settled = run.catch((error: unknown) => ({ ok: false as const, reason: String(error) }))
      pending.set(where.titleKey, settled)
      void settled.then(() => {
        if (pending.get(where.titleKey) === settled) pending.delete(where.titleKey)
      })
      return settled
    },
    async notePlaylist(where, requests, filmSeconds, expectedMinutes) {
      try {
        const found = await findStreamPlaylist(await requests, files, filmSeconds, expectedMinutes)
        if ('reason' in found) log(`[cache] no playlist noted: ${found.reason} (${where.titleKey} ${where.providerId})`)
        else playlists.set(playlistKey(where), found)
      } catch {
        // Only a head start for the save; it looks again itself.
      }
    },
    async settled(titleKey, timeoutMs) {
      const saving = pending.get(titleKey)
      if (saving === undefined) return
      await Promise.race([saving, new Promise((resolve) => setTimeout(resolve, timeoutMs))])
    },
  }
}
