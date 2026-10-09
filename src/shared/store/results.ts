/**
 * The test history (`sourceresults.ts`), kept in a file of its own.
 *
 * Not in the library document, because the library is uploaded whole on
 * every sync, and the history would make it most of a megabyte bigger. It
 * travels in its own synced file instead (`sync/results.ts`), and is stored
 * here the way the library is, by the same platform persistence: atomic
 * writes, a debounced flush, and a file that exists but cannot be read left
 * alone for the session rather than overwritten.
 *
 * Losing this file costs far less than losing the library (the sources get
 * tested again), which is why it has no retries and no user-facing error.
 * Keeping it from overwriting what it could not read costs nothing, so that
 * rule stays.
 */

import { isDownloadedSource } from '../downloads/types'
import {
  isSourceResult,
  mergeResults,
  pruneResults,
  resultKey,
  withoutFutureResults,
  type SourceResult,
} from '../sourceresults'
import { withoutByteOrderMark, type StorePersistence } from './core'

/** The file's shape. `results` marks it and is bumped only if the shape ever changes. */
interface ResultsFile {
  results: 1
  items: SourceResult[]
}

/** A result written here, or one taken from another device's copy. */
export type ResultsChange = 'local' | 'remote'

/**
 * Told of every change: where it came from, and the titles (`titleKey`)
 * whose results it changed, so an open screen can tell whether it shows one
 * of them. Empty when nothing anyone reads changed.
 */
export type ResultsListener = (change: ResultsChange, titleKeys: readonly string[]) => void

const FLUSH_DELAY_MS = 2_000

export class ResultStore {
  private items: SourceResult[] = []
  private listeners = new Set<ResultsListener>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()
  private unsaved = false
  private loaded = false
  /** Set when the file exists and could not be read: nothing is written this session. */
  private readFailed = false

  constructor(
    private readonly persistence: StorePersistence,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Read the file. Await once before anything else; again is a no-op. */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let text: string | null
    try {
      text = await this.persistence.read()
    } catch (err) {
      this.readFailed = true
      console.error('[results] the test history exists but could not be read:', err)
      return
    }
    if (text === null) return
    try {
      const parsed = JSON.parse(withoutByteOrderMark(text)) as Partial<ResultsFile>
      const items = Array.isArray(parsed.items) ? parsed.items.filter(isSourceResult) : []
      this.items = pruneResults(items, this.now())
    } catch {
      try {
        await this.persistence.quarantine()
      } catch {
        // No copy could be kept: leave the file alone this session, as the
        // library's store does, rather than write over the only copy.
        this.readFailed = true
      }
      this.items = []
    }
  }

  /** Every result held, oldest first. */
  all(): readonly SourceResult[] {
    return this.items
  }

  /**
   * Keep new results measured here.
   *
   * Never one for a download, whoever files it: the one place every writer
   * on both platforms passes through, so a new writer cannot forget it the
   * way the phone's cast did until 2.0.18 (see `isSourceResult`).
   */
  record(results: readonly SourceResult[]): void {
    const kept = results.filter((result) => !isDownloadedSource(result.providerId))
    if (kept.length === 0) return
    this.replace(mergeResults(this.items, kept, this.now()), 'local')
  }

  /** Take the history merged with another device's, as the sync worked it out. */
  adopt(results: readonly SourceResult[]): void {
    const now = this.now()
    this.replace(pruneResults(withoutFutureResults(results, now), now), 'remote')
  }

  subscribe(listener: ResultsListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Write now. Call when the app is about to lose the chance to. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.readFailed || !this.unsaved) return this.writing
    this.unsaved = false
    const file: ResultsFile = { results: 1, items: this.items }
    const snapshot = JSON.stringify(file)
    // Chained, as the library's writes are: two writes to one path must not overlap.
    this.writing = this.writing
      .then(() => this.persistence.write(snapshot))
      .catch((err: unknown) => {
        console.error('[results] write failed:', err)
        this.unsaved = true
      })
    return this.writing
  }

  private replace(items: SourceResult[], change: ResultsChange): void {
    const titleKeys = changedTitles(this.items, items)
    this.items = items
    this.unsaved = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => void this.flush(), FLUSH_DELAY_MS)
    for (const listener of this.listeners) {
      try {
        listener(change, titleKeys)
      } catch (err) {
        console.error('[results] subscriber threw:', err)
      }
    }
  }
}

/**
 * The titles whose results differ between two histories: a result added,
 * gone (aged out, or pushed out by newer ones), or filed again with more in
 * it (a play's picture, learned a minute later).
 *
 * Worked out rather than taken from what was recorded, because a sync
 * replaces the whole history and keeping one result can push out another
 * title's. Cheap: a result that did not change is the same object in both,
 * so only a result filed again is compared by content.
 */
function changedTitles(before: readonly SourceResult[], after: readonly SourceResult[]): string[] {
  const held = new Map(before.map((result) => [resultKey(result), result]))
  const changed = new Set<string>()
  for (const result of after) {
    const key = resultKey(result)
    const was = held.get(key)
    held.delete(key)
    if (was === result) continue
    if (was !== undefined && JSON.stringify(was) === JSON.stringify(result)) continue
    changed.add(result.titleKey)
    if (was !== undefined) changed.add(was.titleKey)
  }
  for (const gone of held.values()) changed.add(gone.titleKey)
  return [...changed]
}
