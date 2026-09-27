import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { batchChanges } from './changebatch'

describe('batchChanges', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reports a burst once, naming each key once', () => {
    const heard: unknown[] = []
    const listener = batchChanges((keys) => heard.push(keys), 100)

    listener('watchlist')
    listener('watched')
    listener('watchlist')
    expect(heard).toEqual([])

    vi.advanceTimersByTime(100)
    expect(heard).toEqual([['watchlist', 'watched']])
  })

  it('reports everything when any change in the batch replaced the document', () => {
    const heard: unknown[] = []
    const listener = batchChanges((keys) => heard.push(keys), 100)

    listener('trackers')
    listener(null)
    listener('ratings')
    vi.advanceTimersByTime(100)

    expect(heard).toEqual([null])
  })

  it('starts a fresh batch after delivering one', () => {
    const heard: unknown[] = []
    const listener = batchChanges((keys) => heard.push(keys), 100)

    listener(null)
    vi.advanceTimersByTime(100)
    listener('trackers')
    vi.advanceTimersByTime(100)

    expect(heard).toEqual([null, ['trackers']])
  })
})
