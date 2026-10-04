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

import { isSourceResult, mergeResults, pruneResults, withoutFutureResults, type SourceResult } from '../sourceresults'
import { withoutByteOrderMark, type StorePersistence } from './core'

/** The file's shape. `results` marks it and is bumped only if the shape ever changes. */
interface ResultsFile {
  results: 1
  items: SourceResult[]
}

/** A result written here, or one taken from another device's copy. */
export type ResultsChange = 'local' | 'remote'

const FLUSH_DELAY_MS = 2_000

export class ResultStore {
  private items: SourceResult[] = []
  private listeners = new Set<(change: ResultsChange) => void>()
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

  /** Keep new results measured here. */
  record(results: readonly SourceResult[]): void {
    if (results.length === 0) return
    this.replace(mergeResults(this.items, results, this.now()), 'local')
  }

  /** Take the history merged with another device's, as the sync worked it out. */
  adopt(results: readonly SourceResult[]): void {
    const now = this.now()
    this.replace(pruneResults(withoutFutureResults(results, now), now), 'remote')
  }

  subscribe(listener: (change: ResultsChange) => void): () => void {
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
    this.items = items
    this.unsaved = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => void this.flush(), FLUSH_DELAY_MS)
    for (const listener of this.listeners) {
      try {
        listener(change)
      } catch (err) {
        console.error('[results] subscriber threw:', err)
      }
    }
  }
}
