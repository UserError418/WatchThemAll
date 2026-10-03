/**
 * The history's watch time: every settled play adds to its row, and the time
 * already counted survives the row moving up (a replay, or Resume after a
 * preview that was heard). The owner, 2026-09-29: watching always counts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// `persist` writes through the preload bridge; a stub stands in for it.
const write = vi.fn(async () => {})
vi.stubGlobal('window', { wta: { store: { write } } })

const { library } = await import('./library.svelte')

const show = { tmdbId: 1396, title: 'Breaking Bad', posterPath: null, type: 'tv' as const }
const settle = (playedMs: number, watched = false) =>
  library.notePlayback({ tmdbId: 1396, type: 'tv', season: 1, episode: 2, playedMs, seconds: 600, duration: 2880, watched })

beforeEach(() => {
  library.history = []
  library.watchlist = []
})

describe('watch time in the history', () => {
  it('adds up every settle against the same row', () => {
    library.recordWatch(show, 1, 2)
    settle(40_000)
    settle(3_000)
    expect(library.history).toHaveLength(1)
    expect(library.history[0]?.playedMs).toBe(43_000)
  })

  it('keeps the time already counted when the episode is played again', () => {
    library.recordWatch(show, 1, 2)
    settle(40_000, true)
    library.recordWatch(show, 1, 2)
    settle(5_000)
    expect(library.history).toHaveLength(1)
    expect(library.history[0]).toMatchObject({ playedMs: 45_000, completed: true })
  })
})
