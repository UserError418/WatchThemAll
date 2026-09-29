/**
 * Testing every source of a title by itself, at the two moments the owner
 * named (2026-09-29): a title "freshly added to the watch list and [that]
 * hasn't been removed for 10 mins", and one started "for the first time that
 * is in the watchlist".
 *
 * Both are the full test — every enabled source, as "Test all sources" does —
 * and both happen once per kind of device: a title this kind has tested (by
 * hand or here) is not tested again by this, since its results are what the
 * preview and Automatic read. The other kind's results do not count; they
 * are only a stand-in on this one (`sourceresults.ts`). The background tester
 * (`watchlisttester.ts`, desktop) keeps them fresh from there.
 *
 * ## When
 *
 * - **Added and still listed ten minutes later**, on any device: the entry
 *   arrives here by sync, and its `addedAt` is when it was listed. A title
 *   added more than a week ago is not "fresh" and is left to the background
 *   tester. Not while a film plays: a test decodes video, and the owner's
 *   exception to "never compete with the viewer" was the next case only.
 * - **Watched for the first time** (a listed title this kind never tested),
 *   while it plays. The owner chose "during playback" over "after the player
 *   closes" (recommended against: it shares the line and the decoder with the
 *   film). So it runs gently: one source at a time on the phone, two on the
 *   desktop, and none started while the film is buffering.
 *
 * Pressing play lists a title (`WatchlistEntry.listed`), so the second case
 * is in effect "the first play of anything".
 *
 * The decisions are pure (`dueAfterAdding`, `dueWhileWatching`), and
 * `AutoTester` is the loop both platforms run around them.
 */

import type { WatchlistEntry } from '@shared/types'
import { isListed } from '@shared/listed'
import { titleKey } from './outcomes'

/** How long an addition must stand before it is tested. */
export const AUTO_TEST_AFTER_ADD_MS = 10 * 60_000

/** Older additions are not fresh; the background tester covers them. */
export const FRESH_ADDITION_MS = 7 * 24 * 60 * 60_000

/** How often the loop looks, besides being poked. */
export const AUTO_TEST_TICK_MS = 60_000

/**
 * The freshest listed addition that has stood ten minutes and that this kind
 * of device has not tested, or null. `skip`: titles already tried this
 * session, so a run that measured nothing is not repeated every minute.
 */
export function dueAfterAdding(
  watchlist: readonly WatchlistEntry[],
  tested: (titleKey: string) => boolean,
  now: number,
  skip: ReadonlySet<string> = new Set(),
): WatchlistEntry | null {
  const due = watchlist.filter((entry) => {
    if (!isListed(entry)) return false
    const age = now - entry.addedAt
    if (age < AUTO_TEST_AFTER_ADD_MS || age > FRESH_ADDITION_MS) return false
    const key = titleKey(entry)
    return !skip.has(key) && !tested(key)
  })
  return due.sort((a, b) => b.addedAt - a.addedAt)[0] ?? null
}

/** Whether the title playing is being watched here for the first time, and so is due now. */
export function dueWhileWatching(
  entry: WatchlistEntry | undefined,
  tested: (titleKey: string) => boolean,
  skip: ReadonlySet<string> = new Set(),
): boolean {
  if (entry === undefined || !isListed(entry)) return false
  const key = titleKey(entry)
  return !skip.has(key) && !tested(key)
}

export type AutoTestMode = 'idle' | 'watching'

export interface AutoTesterDeps {
  watchlist(): WatchlistEntry[]
  /** Whether this kind of device has tested every enabled source of the title (`kindTested`). */
  tested(titleKey: string): boolean
  /** The title playing now, by id, or null. */
  playing(): { tmdbId: number } | null
  /** A scan is running already, by hand or from here. */
  busy(): boolean
  /** Test every source of `entry`: normally when `idle`, gently while `watching` it. */
  run(entry: WatchlistEntry, mode: AutoTestMode): Promise<void>
  log?(line: string): void
  now?(): number
}

export class AutoTester {
  /** Titles tried this session: see `dueAfterAdding`. */
  private readonly tried = new Set<string>()
  private running = false

  constructor(private readonly deps: AutoTesterDeps) {}

  /** Look now; called every `AUTO_TEST_TICK_MS`, when playback starts and when the watchlist changes. */
  tick(): void {
    if (this.running || this.deps.busy()) return
    const watchlist = this.deps.watchlist()
    const playing = this.deps.playing()
    const tested = (key: string): boolean => this.deps.tested(key)

    if (playing !== null) {
      const entry = watchlist.find((e) => e.tmdbId === playing.tmdbId)
      if (dueWhileWatching(entry, tested, this.tried)) void this.start(entry!, 'watching')
      return
    }
    const due = dueAfterAdding(watchlist, tested, this.deps.now?.() ?? Date.now(), this.tried)
    if (due !== null) void this.start(due, 'idle')
  }

  private async start(entry: WatchlistEntry, mode: AutoTestMode): Promise<void> {
    this.running = true
    this.tried.add(titleKey(entry))
    this.deps.log?.(`[autotest] testing every source of "${entry.title}" (${mode === 'watching' ? 'first watch, gently' : 'added to the watchlist'})`)
    try {
      await this.deps.run(entry, mode)
    } catch {
      // A failed run is tried again next session, not every minute.
    } finally {
      this.running = false
    }
  }
}
