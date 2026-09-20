import { describe, expect, it, vi } from 'vitest'
import { backfillScores, type BackfillTarget } from './scorebackfill'

const noWait = async (): Promise<void> => {}

function targets(count: number): BackfillTarget[] {
  return Array.from({ length: count }, (_, i) => ({ tmdbId: i + 1, type: 'tv' as const }))
}

describe('backfillScores', () => {
  it('writes a score for each title that has one', async () => {
    const save = vi.fn()
    const written = await backfillScores({
      pending: () => targets(3),
      score: async (id) => id + 6,
      save,
      wait: noWait,
    })

    expect(written).toBe(3)
    expect(save.mock.calls).toEqual([
      [1, 7],
      [2, 8],
      [3, 9],
    ])
  })

  /**
   * Saving per title rather than at the end is what makes an interrupted run
   * resumable: the app can be closed mid-backfill and keeps everything it had
   * already fetched.
   */
  it('saves as it goes rather than in one batch at the end', async () => {
    const order: string[] = []
    await backfillScores({
      pending: () => targets(2),
      score: async (id) => {
        order.push(`fetch ${id}`)
        return 7
      },
      save: (id) => order.push(`save ${id}`),
      wait: noWait,
    })

    expect(order).toEqual(['fetch 1', 'save 1', 'fetch 2', 'save 2'])
  })

  it('carries on past a title that cannot be fetched', async () => {
    const save = vi.fn()
    const written = await backfillScores({
      pending: () => targets(3),
      score: async (id) => {
        if (id === 2) throw new Error('network')
        return 8
      },
      save,
      wait: noWait,
    })

    expect(written).toBe(2)
    expect(save.mock.calls.map(([id]) => id)).toEqual([1, 3])
  })

  /** TMDB reports 0 for unrated. Storing that would claim a rating of zero. */
  it('does not store a zero as though it were a score', async () => {
    const save = vi.fn()
    const written = await backfillScores({
      pending: () => targets(2),
      score: async () => 0,
      save,
      wait: noWait,
    })

    expect(written).toBe(0)
    expect(save).not.toHaveBeenCalled()
  })

  it('skips entries with no TMDB id, which cannot be looked up', async () => {
    const score = vi.fn(async () => 8)
    await backfillScores({
      pending: () => [
        { tmdbId: 0, type: 'tv' },
        { tmdbId: 9, type: 'movie' },
      ],
      score,
      save: vi.fn(),
      wait: noWait,
    })

    expect(score.mock.calls).toEqual([[9, 'movie']])
  })

  /**
   * A large imported catalogue should spread over sessions rather than make one
   * launch spend minutes talking to TMDB. What is left is pending next time.
   */
  it('stops at the per-launch cap', async () => {
    const score = vi.fn(async () => 8)
    const written = await backfillScores({
      pending: () => targets(500),
      score,
      save: vi.fn(),
      wait: noWait,
    })

    expect(written).toBe(120)
    expect(score).toHaveBeenCalledTimes(120)
  })
})
