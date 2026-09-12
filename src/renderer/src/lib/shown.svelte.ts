/**
 * Which titles the browse page has already shown, and where.
 *
 * Every row is an independent TMDB query, and TMDB's lists overlap heavily —
 * a popular drama is simultaneously trending, top-rated, on the air, and in the
 * user's top genre. Rendered naively that is the same handful of shows four
 * times down one page, which makes a catalogue of hundreds of thousands of
 * titles feel like it contains twenty.
 *
 * So rows claim what they display. A title belongs to the first row that shows
 * it, and every row below filters it out. Order therefore matters and is
 * deliberate: the rows that answer "what should I open" most directly are
 * highest, so they get first pick.
 */

import type { MediaSummary } from '@shared/types'

/** The identity of a title across rows. */
function keyOf(media: MediaSummary): string {
  // Same composite the keyed `{#each}` blocks use: every IMDB-sourced result
  // carries `tmdbId: 0`, so the TMDB id alone collides across all of them.
  return `${media.type}:${media.tmdbId || media.imdbId}`
}

class ShownRegistry {
  /** title key → the row that owns it. */
  private owners = new Map<string, string>()

  /**
   * Take the titles this row may display, in order.
   *
   * **Idempotent per row**, which is the part that is easy to get wrong: a row
   * re-rendering — because the window resized, or its data refreshed — would
   * otherwise find every one of its own titles already claimed by itself and
   * render nothing. Releasing this row's previous claims first means calling
   * this twice with the same input gives the same answer.
   */
  claim(rowKey: string, items: MediaSummary[]): MediaSummary[] {
    for (const [key, owner] of this.owners) {
      if (owner === rowKey) this.owners.delete(key)
    }

    const kept: MediaSummary[] = []
    for (const item of items) {
      const key = keyOf(item)
      if (this.owners.has(key)) continue
      this.owners.set(key, rowKey)
      kept.push(item)
    }
    return kept
  }

  /** Has any row already shown this? Used by the discovery feed. */
  has(media: MediaSummary): boolean {
    return this.owners.has(keyOf(media))
  }

  /**
   * Forget everything.
   *
   * Called when the browse surface is torn down. Without it the registry
   * outlives the page it describes, and returning to Browse renders a page
   * where every row believes its titles are already shown somewhere above.
   */
  reset(): void {
    this.owners.clear()
  }
}

/**
 * One registry for the browse page.
 *
 * A module singleton rather than context, because the discovery feed at the
 * bottom needs to consult it too and it is not a descendant of the rows whose
 * claims it needs to see.
 */
export const shown = new ShownRegistry()
