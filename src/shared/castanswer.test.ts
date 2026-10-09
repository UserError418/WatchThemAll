/**
 * The rule for when a television has answered a cast, and what that files.
 *
 * Both platforms go by it: the desktop through `castsender.ts`, the phone
 * through a copy in `CastPlugin.java` that nothing here can run, so the cases
 * below are also the specification that copy is checked against by hand.
 */

import { describe, expect, it } from 'vitest'
import { castOutcomeOf, ReceiverWatch } from './castanswer'

describe('ReceiverWatch', () => {
  it('takes PLAYING as played', () => {
    expect(new ReceiverWatch().read({ playerState: 'PLAYING', currentTime: 0.4 })).toBe('played')
  })

  it('does not take BUFFERING as played: it comes before the first frame', () => {
    const watch = new ReceiverWatch()
    expect(watch.read({ playerState: 'LOADING', currentTime: 0 })).toBeNull()
    expect(watch.read({ playerState: 'BUFFERING', currentTime: 1200 })).toBeNull()
    expect(watch.read({ playerState: 'BUFFERING', currentTime: 1200.2 })).toBeNull()
  })

  it('takes IDLE with reason ERROR as refused, even after BUFFERING', () => {
    // A stream can fail once it is buffering: a segment refused, a codec found
    // wrong. Until 2.0.18 the BUFFERING before the failure counted as "played".
    const watch = new ReceiverWatch()
    expect(watch.read({ playerState: 'BUFFERING', currentTime: 0 })).toBeNull()
    expect(watch.read({ playerState: 'IDLE', idleReason: 'ERROR' })).toBe('refused')
  })

  it('does not take any other IDLE as refused', () => {
    expect(new ReceiverWatch().read({ playerState: 'IDLE', idleReason: 'CANCELLED' })).toBeNull()
  })

  it('takes a position that moved as played, whatever the state says', () => {
    const watch = new ReceiverWatch()
    expect(watch.read({ playerState: 'BUFFERING', currentTime: 1200 })).toBeNull()
    expect(watch.read({ playerState: 'BUFFERING', currentTime: 1201.5 })).toBe('played')
  })

  it('does not count the seek from LOADING to the start as moving', () => {
    // LOADING reports 0, the receiver then seeks to the 20 minutes asked for.
    const watch = new ReceiverWatch()
    expect(watch.read({ playerState: 'LOADING', currentTime: 0 })).toBeNull()
    expect(watch.read({ playerState: 'PAUSED', currentTime: 1200 })).toBeNull()
    expect(watch.read({ playerState: 'PAUSED', currentTime: 1200 })).toBeNull()
  })
})

describe('castOutcomeOf', () => {
  const served = { served: 6, upstreamFailures: 0 }

  it('files a play, and a refusal of a stream the receiver had fetched', () => {
    expect(castOutcomeOf('played', served)).toBe('played')
    expect(castOutcomeOf('refused', served)).toBe('refused')
  })

  it('files nothing for a beam still loading at the end of the wait', () => {
    expect(castOutcomeOf('unsettled', served)).toBeNull()
  })

  it('files nothing for a refusal from a receiver that never reached the proxy', () => {
    // The receiver answers LOAD_FAILED alike when it cannot reach the device: a network problem.
    expect(castOutcomeOf('refused', { served: 0, upstreamFailures: 0 })).toBeNull()
  })

  it('files a refusal while the source refused the proxy as blocked, not as a format refusal', () => {
    expect(castOutcomeOf('refused', { served: 6, upstreamFailures: 1 })).toBe('blocked')
    // A play is a play, whatever was refused along the way.
    expect(castOutcomeOf('played', { served: 6, upstreamFailures: 2 })).toBe('played')
  })
})
