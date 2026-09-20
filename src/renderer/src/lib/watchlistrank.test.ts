import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '@shared/types'
import {
  activityOf,
  bandOf,
  bandWatchlist,
  compareWithin,
  indexHistory,
  NEARLY,
  STALE_DAYS,
  type Activity,
  type RankableEntry,
} from './watchlistrank'

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000

/** A series entry, marks given as `"S:E"` keys all stamped at `at`. */
function series(over: Partial<RankableEntry> & { title?: string } = {}) {
  return {
    tmdbId: 1396,
    type: 'tv' as const,
    episodeMarks: {},
    watchedEpisodes: [],
    episodeCount: 20,
    title: 'Breaking Bad',
    ...over,
  }
}

function marks(at: number, ...keys: string[]): Record<string, { watched: boolean; at: number }> {
  return Object.fromEntries(keys.map((k) => [k, { watched: true, at }]))
}

function play(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'h1',
    tmdbId: 1396,
    type: 'tv',
    title: 'Breaking Bad',
    posterPath: null,
    season: 1,
    episode: 1,
    watchedAt: NOW - DAY,
    playedMs: 30 * 60_000,
    ...over,
  }
}

const EMPTY = indexHistory([])

describe('indexHistory', () => {
  it('sums minutes and keeps the latest timestamp per title', () => {
    const index = indexHistory([
      play({ id: 'a', watchedAt: NOW - 5 * DAY, playedMs: 20 * 60_000 }),
      play({ id: 'b', watchedAt: NOW - DAY, playedMs: 40 * 60_000 }),
    ])
    expect(index.minutes.get(1396)).toBe(60)
    expect(index.lastAt.get(1396)).toBe(NOW - DAY)
  })

  /**
   * A session left open overnight is not eight hours of watching. `playedMs`
   * clamps it, and without that one abandoned tab would own the top of the
   * "continue" band forever.
   */
  it('clamps an implausible session rather than letting it dominate', () => {
    const index = indexHistory([play({ playedMs: 20 * 60 * 60_000 })])
    expect(index.minutes.get(1396)).toBeLessThan(20 * 60)
  })

  /** An entry that was opened but never settled has no duration to add. */
  it('still dates a title that recorded no duration', () => {
    const index = indexHistory([play({ playedMs: undefined, watchedAt: NOW - DAY })])
    expect(index.minutes.get(1396) ?? 0).toBe(0)
    expect(index.lastAt.get(1396)).toBe(NOW - DAY)
  })

  it('ignores unresolved imports, which all share tmdbId 0', () => {
    expect(indexHistory([play({ tmdbId: 0 })]).lastAt.size).toBe(0)
  })
})

describe('activityOf', () => {
  it('counts watched episodes and derives the fraction', () => {
    const a = activityOf(series({ episodeMarks: marks(NOW, '1:1', '1:2') }), EMPTY)
    expect(a.watched).toBe(2)
    expect(a.total).toBe(20)
    expect(a.fraction).toBeCloseTo(0.1)
  })

  /**
   * The case that decides whether an imported library ranks at all: marks
   * carry their own timestamps, and for most of these titles there is no play
   * log to fall back on.
   */
  it('dates a title from its marks when nothing was played through the app', () => {
    const a = activityOf(series({ episodeMarks: marks(NOW - 3 * DAY, '1:1') }), EMPTY)
    expect(a.lastAt).toBe(NOW - 3 * DAY)
    expect(a.minutes).toBe(0)
  })

  it('takes whichever of marks and history is more recent', () => {
    const index = indexHistory([play({ watchedAt: NOW - DAY })])
    const a = activityOf(series({ episodeMarks: marks(NOW - 9 * DAY, '1:1') }), index)
    expect(a.lastAt).toBe(NOW - DAY)
  })

  /** An entry written before `episodeMarks` existed carries only this list. */
  it('reads the legacy watchedEpisodes list too', () => {
    const a = activityOf(series({ episodeMarks: {}, watchedEpisodes: ['1:1', '1:2'] }), EMPTY)
    expect(a.watched).toBe(2)
  })

  it('does not double-count an episode present in both', () => {
    const a = activityOf(
      series({ episodeMarks: marks(NOW, '1:1'), watchedEpisodes: ['1:1'] }),
      EMPTY,
    )
    expect(a.watched).toBe(1)
  })

  /** An episode opened and abandoned is not an episode watched. */
  it('ignores a mark that records the episode as not watched', () => {
    const a = activityOf(
      series({ episodeMarks: { '1:1': { watched: false, at: NOW } } }),
      EMPTY,
    )
    expect(a.watched).toBe(0)
  })

  /**
   * Null, not zero. A series with twelve episodes marked and no count yet is
   * not 0% watched — and calling it 0% would file it under "not started",
   * beside things never opened.
   */
  it('reports an unknown fraction rather than zero when the total is missing', () => {
    const a = activityOf(series({ episodeCount: null, episodeMarks: marks(NOW, '1:1') }), EMPTY)
    expect(a.fraction).toBeNull()
    expect(a.watched).toBe(1)
  })

  it('caps the fraction at 1 when marks outnumber the known episodes', () => {
    const a = activityOf(
      series({ episodeCount: 2, episodeMarks: marks(NOW, '1:1', '1:2', '1:3') }),
      EMPTY,
    )
    expect(a.fraction).toBe(1)
  })

  /** A film has no episodes; its progress is the resume position. */
  it('uses the resume position for a film', () => {
    const a = activityOf({ ...series({ type: 'movie' }), episodeCount: null }, EMPTY, 62)
    expect(a.fraction).toBeCloseTo(0.62)
    expect(a.watched).toBe(0)
  })

  it('reports an unknown fraction for a film never started', () => {
    expect(activityOf({ ...series({ type: 'movie' }) }, EMPTY, null).fraction).toBeNull()
  })
})

/** Shorthand for the band tests. */
function activity(over: Partial<Activity> = {}): Activity {
  return { lastAt: NOW, watched: 1, total: 20, minutes: 30, fraction: 0.05, ...over }
}

describe('bandOf', () => {
  it('files a title with nothing watched as not started', () => {
    expect(bandOf(activity({ watched: 0, minutes: 0, fraction: 0, lastAt: 0 }), NOW)).toBe('fresh')
  })

  it('files recent progress as continue', () => {
    expect(bandOf(activity({ lastAt: NOW - 2 * DAY }), NOW)).toBe('continue')
  })

  it('files old progress as stalled', () => {
    expect(bandOf(activity({ lastAt: NOW - (STALE_DAYS + 1) * DAY }), NOW)).toBe('stalled')
  })

  /** Exactly on the cutoff is still current — the boundary is inclusive. */
  it('keeps a title exactly at the staleness cutoff in continue', () => {
    expect(bandOf(activity({ lastAt: NOW - STALE_DAYS * DAY }), NOW)).toBe('continue')
  })

  it('files a nearly-complete title as nearly, at the threshold', () => {
    expect(bandOf(activity({ fraction: NEARLY }), NOW)).toBe('nearly')
  })

  it('leaves a title just under the threshold in continue', () => {
    expect(bandOf(activity({ fraction: NEARLY - 0.01 }), NOW)).toBe('continue')
  })

  /**
   * The ordering of the tests is the design: something both recent and nearly
   * over belongs under the heading that says it is nearly over.
   */
  it('prefers nearly over continue when both are true', () => {
    expect(bandOf(activity({ fraction: 0.9, lastAt: NOW }), NOW)).toBe('nearly')
  })

  /** Otherwise a finished series sits under "nearly finished" permanently. */
  it('does not keep a finished title in nearly', () => {
    expect(bandOf(activity({ fraction: 1, lastAt: NOW }), NOW)).not.toBe('nearly')
  })

  /**
   * A MyAnimeList import can arrive with marks but no usable timestamps.
   * "Continue" overstates it and "not started" is plainly false.
   */
  it('files started-but-undateable progress as stalled', () => {
    expect(bandOf(activity({ lastAt: 0, fraction: 0.3 }), NOW)).toBe('stalled')
  })

  /** A film part-way through counts as started even with no episode marks. */
  it('treats a film with a resume position as started', () => {
    expect(
      bandOf(activity({ watched: 0, minutes: 0, total: null, fraction: 0.4, lastAt: NOW }), NOW),
    ).toBe('continue')
  })
})

describe('compareWithin', () => {
  const at = (lastAt: number, minutes = 0, title = 'x') => ({
    activity: activity({ lastAt, minutes }),
    title,
  })

  it('puts the most recently touched first', () => {
    expect(compareWithin(at(NOW - DAY), at(NOW))).toBeGreaterThan(0)
  })

  it('breaks a tie on minutes watched', () => {
    expect(compareWithin(at(NOW, 10), at(NOW, 90))).toBeGreaterThan(0)
  })

  /** A total order: without the title fallback, cards swap on any re-render. */
  it('falls back to the title so the order is stable', () => {
    expect(compareWithin(at(NOW, 5, 'Alpha'), at(NOW, 5, 'Beta'))).toBeLessThan(0)
    expect(compareWithin(at(NOW, 5, 'Beta'), at(NOW, 5, 'Alpha'))).toBeGreaterThan(0)
  })
})

describe('bandWatchlist', () => {
  const entries = [
    series({ tmdbId: 1, title: 'Almost Over', episodeCount: 10, episodeMarks: marks(NOW, '1:1', '1:2', '1:3', '1:4', '1:5', '1:6', '1:7', '1:8', '1:9') }),
    series({ tmdbId: 2, title: 'Watching Now', episodeCount: 10, episodeMarks: marks(NOW - DAY, '1:1') }),
    series({ tmdbId: 3, title: 'Set Aside', episodeCount: 10, episodeMarks: marks(NOW - 60 * DAY, '1:1') }),
    series({ tmdbId: 4, title: 'Queued', episodeCount: 10, episodeMarks: {} }),
  ]

  it('returns the bands in reading order with their entries', () => {
    const groups = bandWatchlist(entries, [], () => null, NOW)
    expect(groups.map((g) => g.band)).toEqual(['nearly', 'continue', 'stalled', 'fresh'])
    expect(groups.map((g) => g.items[0]?.entry.title)).toEqual([
      'Almost Over',
      'Watching Now',
      'Set Aside',
      'Queued',
    ])
  })

  /** An empty heading is worse than no heading — it says the app lost something. */
  it('omits a band with no entries', () => {
    const groups = bandWatchlist([entries[3]!], [], () => null, NOW)
    expect(groups.map((g) => g.band)).toEqual(['fresh'])
  })

  it('orders inside a band by recency', () => {
    const recent = series({ tmdbId: 5, title: 'Yesterday', episodeMarks: marks(NOW - DAY, '1:1') })
    const older = series({ tmdbId: 6, title: 'Last week', episodeMarks: marks(NOW - 7 * DAY, '1:1') })
    const [group] = bandWatchlist([older, recent], [], () => null, NOW)
    expect(group?.items.map((i) => i.entry.title)).toEqual(['Yesterday', 'Last week'])
  })

  it('places a part-watched film by its resume position', () => {
    const film = { ...series({ tmdbId: 9, type: 'movie', title: 'Dune' }), episodeCount: null }
    const groups = bandWatchlist([film], [], (id) => (id === 9 ? 92 : null), NOW)
    expect(groups[0]?.band).toBe('nearly')
  })

  it('carries every entry into exactly one band', () => {
    const groups = bandWatchlist(entries, [], () => null, NOW)
    expect(groups.flatMap((g) => g.items).length).toBe(entries.length)
  })
})
