import { describe, expect, it } from 'vitest'
import { TvHandover } from './tvhandover'

describe('TvHandover', () => {
  it('gives the source a beat to load before the first try', () => {
    const handover = new TvHandover(0)

    expect(handover.next(1_000)).toBe('wait')
    expect(handover.next(2_000)).toBe('try')
  })

  it('still tries when first asked long after its budget, as a phone in a pocket asks', () => {
    const handover = new TvHandover(0)

    // A backgrounded app's timer, firing a minute late.
    expect(handover.next(60_000)).toBe('try')
    handover.settle('retry')
    expect(handover.next(61_200)).toBe('give-up')
    expect(handover.done).toBe(true)
  })

  it('keeps trying on the television’s five-second ticks until the budget is spent', () => {
    const handover = new TvHandover(0)
    const steps: string[] = []
    for (let now = 5_000; now <= 30_000; now += 5_000) {
      const step = handover.next(now)
      steps.push(step)
      if (step === 'try') handover.settle('retry')
    }

    expect(steps).toEqual(['try', 'try', 'try', 'try', 'give-up', 'wait'])
  })

  it('never tries twice at once, nor faster than its spacing', () => {
    const handover = new TvHandover(0)

    expect(handover.next(2_000)).toBe('try')
    expect(handover.next(9_000)).toBe('wait') // the first is still in flight
    handover.settle('retry')
    expect(handover.next(9_000)).toBe('try')
    handover.settle('retry')
    expect(handover.next(9_500)).toBe('wait')
  })

  it('ends when a try lands or is refused for good', () => {
    const landed = new TvHandover(0)
    landed.next(2_000)
    landed.settle('ok')
    const refused = new TvHandover(0)
    refused.next(2_000)
    refused.settle('final')

    expect([landed.done, refused.done]).toEqual([true, true])
    expect(landed.next(5_000)).toBe('wait')
  })
})
