/**
 * The words and colour a failed test gets.
 *
 * The point of reasons is that the dot and the label never disagree, and that
 * the label says what happened rather than "may work". Both are cheap to get
 * wrong silently: a mismatch renders, it just misleads.
 */

import { describe, expect, it } from 'vitest'
import type { ScanReason } from './types'
import { describeReason, verdictForReason } from './scanreason'
import { providerDot } from './scanrank'

const ALL: ScanReason[] = [
  { kind: 'error', status: 500 },
  { kind: 'refused', status: 403 },
  { kind: 'timeout', seconds: 20 },
  { kind: 'blocked' },
  { kind: 'no-stream' },
  { kind: 'unreachable' },
  { kind: 'unsupported' },
]

describe('reason labels', () => {
  it('says what happened, with the number the user would look up', () => {
    expect(describeReason({ kind: 'error', status: 500 }).label).toBe('error 500')
    expect(describeReason({ kind: 'timeout', seconds: 20 }).label).toBe('timeout (20 s)')
    expect(describeReason({ kind: 'refused', status: 403 }).label).toBe('stream refused (403)')
  })

  it('is red for everything the test saw fail, amber only for a bot check', () => {
    for (const reason of ALL) {
      expect(verdictForReason(reason)).toBe(reason.kind === 'blocked' ? 'unsure' : 'dead')
    }
  })
})

describe('the dot with a reason', () => {
  it("uses the reason's words in the rank's colour", () => {
    const dot = providerDot(undefined, 'dead', { kind: 'timeout', seconds: 25 })
    expect(dot).toMatchObject({ tone: 'bad', label: 'timeout (25 s)' })
    expect(providerDot(undefined, 'unsure', { kind: 'blocked' })).toMatchObject({ tone: 'warn', label: 'blocked' })
  })

  it('falls back to the old words when a stored result has no reason', () => {
    expect(providerDot(undefined, 'unsure').label).toBe('may work')
    expect(providerDot(undefined, 'dead').label).toBe('no stream')
  })

  it('ignores a reason on a working source', () => {
    expect(providerDot(undefined, 'stream', { kind: 'error', status: 500 }).label).toBe('works')
  })
})
