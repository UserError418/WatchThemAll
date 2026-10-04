/**
 * The one toast: a newer one replaces the one showing, an old timer never
 * takes a newer toast down, and the action runs once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { toast, TOAST_MS, ACTION_TOAST_MS } = await import('./toast.svelte')

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  toast.dismiss()
  vi.useRealTimers()
})

describe('toast', () => {
  it('goes after its time', () => {
    toast.show('Saved')
    vi.advanceTimersByTime(TOAST_MS - 1)
    expect(toast.current?.message).toBe('Saved')
    vi.advanceTimersByTime(1)
    expect(toast.current).toBeNull()
  })

  it('gives a newer toast its full time', () => {
    toast.show('First')
    vi.advanceTimersByTime(TOAST_MS - 100)
    toast.show('Second')
    vi.advanceTimersByTime(200)
    expect(toast.current?.message).toBe('Second')
  })

  it('stays longer when there is something to press', () => {
    toast.show('Removed', { label: 'Undo', run: () => {} })
    vi.advanceTimersByTime(TOAST_MS)
    expect(toast.current?.message).toBe('Removed')
    vi.advanceTimersByTime(ACTION_TOAST_MS - TOAST_MS)
    expect(toast.current).toBeNull()
  })

  it('runs the action once and goes', () => {
    const run = vi.fn()
    toast.show('Removed', { label: 'Undo', run })

    toast.act()
    toast.act()

    expect(run).toHaveBeenCalledTimes(1)
    expect(toast.current).toBeNull()
  })
})
