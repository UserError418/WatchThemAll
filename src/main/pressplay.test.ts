/**
 * Pressing play must never be the thing that stops.
 *
 * Both the player and the UI probe await `clickPlayInFrames`. A frame whose
 * renderer Chromium has killed never answers `executeJavaScript` — the promise
 * neither resolves nor rejects — so without a time limit one bad frame halts
 * whatever is waiting on the press. The UI probe once sat on SuperEmbed's
 * first title for eighteen minutes, and moves on since this limit exists.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

import { clickPlayInFrames } from './pressplay'

/** Just enough of a `WebContents` for the frame walk, with scripted frames. */
function contentsWith(frames: Array<() => Promise<unknown>>): {
  contents: WebContents
  calls: number[]
} {
  const calls: number[] = []
  const contents = {
    isDestroyed: () => false,
    mainFrame: {
      framesInSubtree: frames.map((answer, index) => ({
        executeJavaScript: () => {
          calls.push(index)
          return answer()
        },
      })),
    },
  } as unknown as WebContents
  return { contents, calls }
}

const never = (): Promise<unknown> => new Promise(() => {})
const answers = (): Promise<unknown> => Promise.resolve(true)
const detached = (): Promise<unknown> => Promise.reject(new Error('frame detached'))

describe('clickPlayInFrames', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives up on a frame that never answers and presses the rest', async () => {
    vi.useFakeTimers()
    const { contents, calls } = contentsWith([never, answers, never, answers])

    let settled = false
    const press = clickPlayInFrames(contents).then(() => {
      settled = true
    })

    // Two silent frames, each allowed a couple of seconds and no more.
    await vi.advanceTimersByTimeAsync(10_000)
    await press

    expect(settled).toBe(true)
    expect(calls).toEqual([0, 1, 2, 3])
  })

  it('does not wait out the budget on frames that answer', async () => {
    vi.useFakeTimers()
    const { contents, calls } = contentsWith([answers, answers, answers])

    let settled = false
    void clickPlayInFrames(contents).then(() => {
      settled = true
    })
    // No timer advanced: answering frames must settle on their own.
    await vi.advanceTimersByTimeAsync(0)

    expect(settled).toBe(true)
    expect(calls).toEqual([0, 1, 2])
  })

  it('carries on past a frame that has gone away', async () => {
    const { contents, calls } = contentsWith([detached, answers])

    await expect(clickPlayInFrames(contents)).resolves.toBeUndefined()
    expect(calls).toEqual([0, 1])
  })
})
