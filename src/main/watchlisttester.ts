/**
 * Testing the watchlist's sources in the background, one at a time.
 *
 * "Test all sources" answers the question when the user asks it, and makes them
 * wait a minute or two for the answer. For the titles they are actually going
 * to watch — the watchlist — the answer can be ready before they ask. The
 * brief, 2026-09-26: test one provider every minute or two, the first
 * watchlist entry until every provider is tested, then the next, to the end;
 * then stop until something new is added. Series on the episode the user is
 * on, or S1E1 for a show just added.
 *
 * Results last thirty days, and some are due again sooner — reds after three
 * days, ambers after four (`RETEST_AFTER_MS`). "Stop until something new is
 * added" therefore means *sleep until something is due*: a new show, or a
 * result that has aged into a re-test.
 *
 * ## What it must not do
 *
 * - **Compete with the user.** It pauses while a video plays in the app and
 *   while a scan by hand runs. A probe is a hidden player decoding video; two
 *   of those at once starve each other, and one beside the user's own playback
 *   would cost them picture.
 * - **Paint the world red when the network is down.** Every provider fails
 *   when nothing can be reached, and a red lasts three days. Each test starts
 *   with a TMDB lookup for the title; if that fails, the tick is skipped rather
 *   than trusted.
 * - **Test what cannot exist yet.** A title with no release date, or one in the
 *   future, is skipped: every provider would be red for a film nobody has.
 *
 * The planning is a pure function, `planNextTest`, so the order can be tested
 * without a timer or a network. `createWatchlistTester` is the loop around it.
 */

import type { HistoryEntry, Provider, ProviderScan, WatchlistEntry } from '@shared/types'
import type { WatchlistTestStatus } from '@shared/ipc'
import type { ProbeSubject } from './streamprobe'
import { isListed } from '@shared/listed'
import { bandWatchlist, resumeAnchor } from '@shared/watchlistrank'
import { titleKey } from './outcomes'
import { isRetestDue, scanEpisode } from './providerscan'

/** A watchlist entry added this recently, and never tested, goes first. */
export const NEW_ENTRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The order to work through the watchlist in: the Watchlist tab's own order,
 * except that a show added in the last week and never tested jumps the queue.
 * Listed entries only, as the tab shows them (see `WatchlistEntry.listed`).
 *
 * The tab's order is the user's own sense of what is next — nearly finished,
 * then in progress, then stalled, then not started — so testing in it means
 * the results they are likeliest to need are ready first. A new addition is
 * the one thing that order would bury: it is "not started", so it sorts last,
 * while it is exactly what the user added in order to watch.
 */
export function testingOrder(
  watchlist: readonly WatchlistEntry[],
  history: readonly HistoryEntry[],
  scans: readonly ProviderScan[],
  filmPercent: (tmdbId: number) => number | null,
  now: number,
): WatchlistEntry[] {
  // Unlisted entries are titles the user ticked episodes of, not ones they
  // want to watch here; testing them would spend the budget on the wrong list.
  const tabOrder = bandWatchlist(watchlist.filter(isListed), history, filmPercent, now).flatMap((group) =>
    group.items.map((item) => item.entry),
  )
  const tested = new Set(scans.map((scan) => scan.titleKey))
  const isNew = (entry: WatchlistEntry): boolean =>
    now - entry.addedAt <= NEW_ENTRY_WINDOW_MS && !tested.has(titleKey(entry))
  return [
    ...tabOrder.filter(isNew).sort((a, b) => b.addedAt - a.addedAt),
    ...tabOrder.filter((entry) => !isNew(entry)),
  ]
}

/** The episode to probe a series on: where the user is, else S1E1. Null for a film. */
export function episodeToTest(entry: WatchlistEntry): { season: number; episode: number } | null {
  return scanEpisode(entry.type, entry.type === 'tv' ? resumeAnchor(entry) : null)
}

export interface PlannedTest {
  entry: WatchlistEntry
  titleKey: string
  provider: Provider
}

/**
 * The next test to run, or null when nothing is due.
 *
 * Finishes one title before starting the next, as the brief asks: every due
 * provider of the first entry, in the user's provider order, then the second
 * entry. `skip` names titles to pass over this time — unreleased ones, and any
 * whose lookup just failed.
 */
export function planNextTest(input: {
  entries: readonly WatchlistEntry[]
  providers: readonly Provider[]
  scans: readonly ProviderScan[]
  now: number
  skip?: ReadonlySet<string>
}): PlannedTest | null {
  const { entries, providers, scans, now, skip = new Set() } = input
  for (const entry of entries) {
    const key = titleKey(entry)
    if (skip.has(key)) continue
    const scan = scans.find((row) => row.titleKey === key)
    const provider = providers.find((candidate) => isRetestDue(scan, candidate.id, now))
    if (provider) return { entry, titleKey: key, provider }
  }
  return null
}

/** How many (title, provider) pairs are up to date, of how many there are. */
export function testedCount(input: {
  entries: readonly WatchlistEntry[]
  providers: readonly Provider[]
  scans: readonly ProviderScan[]
  now: number
  skip?: ReadonlySet<string>
}): { done: number; total: number } {
  const { entries, providers, scans, now, skip = new Set() } = input
  let done = 0
  let total = 0
  for (const entry of entries) {
    const key = titleKey(entry)
    if (skip.has(key)) continue
    const scan = scans.find((row) => row.titleKey === key)
    for (const provider of providers) {
      total += 1
      if (!isRetestDue(scan, provider.id, now)) done += 1
    }
  }
  return { done, total }
}

/** What a title's release looks like, for deciding whether to test it. */
export interface TitleFacts {
  /** False for a title that has not come out yet, or whose date TMDB does not know. */
  released: boolean
  imdbId: string | null
}

export interface WatchlistTesterOptions {
  watchlist: () => WatchlistEntry[]
  history: () => HistoryEntry[]
  scans: () => ProviderScan[]
  /** A film's watched fraction, for the tab's order. See `Watchlist.svelte`. */
  filmPercent: (tmdbId: number) => number | null
  /** The enabled providers, in the user's order. */
  providers: () => Provider[]
  /** Looks the title up on TMDB. Null when the lookup failed, which skips the tick. */
  lookUp: (entry: WatchlistEntry) => Promise<TitleFacts | null>
  /** One provider, alone; null when a scan by hand interfered. See `ScanService.probeOne`. */
  probeOne: (titleKey: string, subject: ProbeSubject, provider: Provider) => Promise<ProviderScan | null>
  /** Why testing must wait right now, or null to go ahead. */
  pausedFor: () => 'playback' | 'scan' | null
  /** Keep a result. */
  save: (result: ProviderScan) => void
  onStatus: (status: WatchlistTestStatus) => void
  /** Between the end of one test and the start of the next. */
  intervalMs?: number
  /** Before the first test after launch, so start-up is not competing with it. */
  startDelayMs?: number
}

export interface WatchlistTester {
  start(): void
  stop(): void
  /** Look again now — after the watchlist changed, or playback ended. */
  poke(): void
  status(): WatchlistTestStatus
}

/**
 * One minute between tests, as the brief specifies ("every 1 or 2 minutes"). A
 * test itself takes up to 25 seconds, so a hidden player is running for at
 * most a third of the time, and one at a time.
 */
const DEFAULT_INTERVAL_MS = 60_000

export function createWatchlistTester(options: WatchlistTesterOptions): WatchlistTester {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let testing = false
  /** Titles found unreleased, until the next launch. Re-looking every minute would be pointless. */
  const unreleased = new Set<string>()
  let current: WatchlistTestStatus = {
    state: 'idle',
    pausedFor: null,
    title: null,
    providerName: null,
    done: 0,
    total: 0,
  }

  const orderedEntries = (now: number): WatchlistEntry[] =>
    testingOrder(options.watchlist(), options.history(), options.scans(), options.filmPercent, now)

  const publish = (state: WatchlistTestStatus['state'], extra: Partial<WatchlistTestStatus> = {}): void => {
    const now = Date.now()
    const counts = testedCount({
      entries: orderedEntries(now),
      providers: options.providers(),
      scans: options.scans(),
      now,
      skip: unreleased,
    })
    current = { state, pausedFor: null, title: null, providerName: null, ...counts, ...extra }
    options.onStatus(current)
  }

  const schedule = (delayMs: number): void => {
    if (!running) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void tick(), delayMs)
  }

  const tick = async (): Promise<void> => {
    timer = null
    if (!running || testing) return

    const paused = options.pausedFor()
    if (paused) {
      publish('paused', { pausedFor: paused })
      schedule(intervalMs)
      return
    }

    const now = Date.now()
    const plan = planNextTest({
      entries: orderedEntries(now),
      providers: options.providers(),
      scans: options.scans(),
      now,
      skip: unreleased,
    })
    if (!plan) {
      // Nothing due. Look again later: results age into re-tests, and the
      // watchlist can change without anyone poking.
      publish('idle')
      schedule(intervalMs * 10)
      return
    }

    testing = true
    try {
      const facts = await options.lookUp(plan.entry)
      if (!facts) {
        // Offline, or TMDB is down. A test now would only measure that.
        publish('waiting')
        return
      }
      if (!facts.released) {
        unreleased.add(plan.titleKey)
        publish('waiting')
        return
      }

      publish('testing', { title: plan.entry.title, providerName: plan.provider.name })
      const episode = episodeToTest(plan.entry)
      const result = await options.probeOne(
        plan.titleKey,
        {
          imdbId: facts.imdbId ?? plan.entry.imdbId ?? '',
          tmdbId: plan.entry.tmdbId,
          type: plan.entry.type,
          season: episode?.season,
          episode: episode?.episode,
          label: plan.titleKey,
          // As for a scan by hand: whether a stream exists, not whether it is
          // the right programme. See the note in `ipc.ts`.
          runtimeMinutes: null,
        },
        plan.provider,
      )
      // Null when a scan by hand ran meanwhile; it measured this provider too.
      if (result) options.save(result)
      publish('waiting')
    } finally {
      testing = false
      schedule(intervalMs)
    }
  }

  return {
    start() {
      if (running) return
      running = true
      publish('waiting')
      schedule(options.startDelayMs ?? intervalMs)
    },
    stop() {
      running = false
      if (timer) clearTimeout(timer)
      timer = null
    },
    poke() {
      // Soon rather than now: a poke arrives as the watchlist or the player
      // changes, and the next few seconds are the user's.
      if (running && !testing) schedule(5_000)
    },
    status: () => current,
  }
}
