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
  { kind: 'wrong-video', seconds: 167, expectedMinutes: 139, title: 'film' },
]

describe('reason labels', () => {
  it('says what happened, with the number the user would look up', () => {
    expect(describeReason({ kind: 'error', status: 500 }).label).toBe('error 500')
    expect(describeReason({ kind: 'timeout', seconds: 20 }).label).toBe('timeout (20 s)')
    expect(describeReason({ kind: 'refused', status: 403 }).label).toBe('stream refused (403)')
  })

  it('is red for everything the test saw fail, amber for a bot check and for something else playing', () => {
    for (const reason of ALL) {
      expect(verdictForReason(reason)).toBe(reason.kind === 'blocked' || reason.kind === 'wrong-video' ? 'unsure' : 'dead')
    }
  })

  /** The measured case: VidRock served a clip for Fight Club while its test said green. */
  it('says a clip in the place of the film is something else, in the Downloads tab\'s words', () => {
    const text = describeReason({ kind: 'wrong-video', seconds: 167, expectedMinutes: 139, title: 'film' })
    expect(text.label).toBe('something else')
    expect(text.hint).toBe('Tested — this source plays something else here (a 3 min video for a 139 min film)')
    expect(describeReason({ kind: 'wrong-video', seconds: 300, expectedMinutes: null, title: 'episode' }).hint).toBe(
      'Tested — this source plays something else here (a 5 min video)',
    )
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

  it('ignores a reason on a working source, which says nothing but its colour', () => {
    expect(providerDot(undefined, 'stream', { kind: 'error', status: 500 })).toMatchObject({ tone: 'good', label: null })
  })
})
