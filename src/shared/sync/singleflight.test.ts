/** One run at a time, shared by everyone who asks while it is out. */

import { describe, expect, it } from 'vitest'

import { singleFlight } from './singleflight'

describe('singleFlight', () => {
  it('runs once for every caller that asks while a run is out, and they share its answer', async () => {
    let runs = 0
    let finish!: (value: string) => void
    const shared = singleFlight(() => {
      runs += 1
      return new Promise<string>((resolve) => (finish = resolve))
    })

    const answers = Promise.all([shared(), shared(), shared()])
    finish('token-1')

    expect(await answers).toEqual(['token-1', 'token-1', 'token-1'])
    expect(runs).toBe(1)
  })

  it('runs afresh once the last run has finished, and after a failure', async () => {
    let runs = 0
    const shared = singleFlight(async () => {
      runs += 1
      if (runs === 1) throw new Error('offline')
      return `token-${runs}`
    })

    await expect(shared()).rejects.toThrow('offline')
    expect(await shared()).toBe('token-2')
  })
})
