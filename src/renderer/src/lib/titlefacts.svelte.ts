/**
 * Title facts for list rows, fetched on demand and remembered between visits.
 *
 * See `titlefacts.ts` for what the facts are and why they are not stored on
 * the library's records. This is the part with state: a reactive map the rows
 * read, a queue so a two-hundred-row list does not fire two hundred requests
 * at once, and the `localStorage` copy that makes the second visit instant.
 */

import { SvelteMap } from 'svelte/reactivity'
import type { MediaType } from '@shared/types'
import {
  FACTS_STORAGE_KEY,
  factsFromDetail,
  factsKey,
  isStale,
  parseFacts,
  serialiseFacts,
  type TitleFacts,
} from './titlefacts'

/**
 * Requests in flight at once.
 *
 * TMDB throttles, and the rows ask as they scroll into view — a fast scroll
 * through the Watched list asks for dozens in a second. Four keeps the
 * artwork arriving in the order the rows appeared without queueing behind a
 * burst the user has already scrolled past.
 */
const CONCURRENCY = 4

/** How long to wait before writing the cache, so a burst of answers is one write. */
const SAVE_DELAY_MS = 1500

class TitleFactsStore {
  private readonly facts = new SvelteMap<string, TitleFacts>()
  private readonly queue: Array<{ type: MediaType; tmdbId: number }> = []
  private readonly pending = new Set<string>()
  private active = 0
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    try {
      for (const [key, value] of parseFacts(localStorage.getItem(FACTS_STORAGE_KEY))) {
        this.facts.set(key, value)
      }
    } catch {
      // No storage (a test, a locked-down profile): the facts are fetched each visit.
    }
  }

  /** What is known about a title, possibly stale, or null while nothing is. */
  get(type: MediaType, tmdbId: number): TitleFacts | null {
    return this.facts.get(factsKey(type, tmdbId)) ?? null
  }

  /**
   * Make sure the facts for a title are on their way.
   *
   * Called by a row when it scrolls into view. A no-op when fresh facts are
   * already held or a request is already queued, so rows can call it freely.
   */
  want(type: MediaType, tmdbId: number): void {
    if (!tmdbId) return
    const key = factsKey(type, tmdbId)
    const held = this.facts.get(key)
    if (held && !isStale(held, Date.now())) return
    if (this.pending.has(key)) return
    this.pending.add(key)
    this.queue.push({ type, tmdbId })
    this.pump()
  }

  private pump(): void {
    while (this.active < CONCURRENCY && this.queue.length > 0) {
      const next = this.queue.shift()!
      this.active += 1
      void this.fetchOne(next.type, next.tmdbId).finally(() => {
        this.active -= 1
        this.pump()
      })
    }
  }

  private async fetchOne(type: MediaType, tmdbId: number): Promise<void> {
    const key = factsKey(type, tmdbId)
    try {
      const detail = await window.wta.tmdb.detail(tmdbId, type)
      // Null is TMDB not knowing the title — an import that never resolved.
      if (detail === null) return
      this.facts.set(key, factsFromDetail(detail, Date.now()))
      this.scheduleSave()
    } catch {
      // Offline, or TMDB said no. The row keeps its poster; the next visit asks again.
    } finally {
      this.pending.delete(key)
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try {
        localStorage.setItem(FACTS_STORAGE_KEY, serialiseFacts(this.facts))
      } catch {
        // Quota or no storage: the cache is a convenience, never a requirement.
      }
    }, SAVE_DELAY_MS)
  }
}

export const titleFacts = new TitleFactsStore()

/**
 * `use:whenVisible={() => …}` — run once, the first time the element is on screen.
 *
 * With a margin, so the facts for the next screenful are already arriving by
 * the time the user scrolls to them.
 */
export function whenVisible(node: HTMLElement, onVisible: () => void): { destroy: () => void } {
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect()
        onVisible()
      }
    },
    { rootMargin: '600px 0px' },
  )
  observer.observe(node)
  return { destroy: () => observer.disconnect() }
}
