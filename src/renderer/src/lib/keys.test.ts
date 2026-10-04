import { describe, expect, it } from 'vitest'
import { keyBelongsToTarget, type KeyTarget } from './keys'

const element = (tagName: string, role: string | null = null, isContentEditable = false): KeyTarget => ({
  tagName,
  isContentEditable,
  getAttribute: (name) => (name === 'role' ? role : null),
})

describe('keyBelongsToTarget', () => {
  it('gives fields and selects their own keys', () => {
    expect(keyBelongsToTarget(element('INPUT'))).toBe(true)
    expect(keyBelongsToTarget(element('TEXTAREA'))).toBe(true)
    expect(keyBelongsToTarget(element('SELECT'))).toBe(true)
    expect(keyBelongsToTarget(element('DIV', null, true))).toBe(true)
  })

  /** The rating's pips are buttons with role="radio". */
  it("gives a rating pip its own keys, so a digit there does not switch tabs", () => {
    expect(keyBelongsToTarget(element('BUTTON', 'radio'))).toBe(true)
  })

  it('leaves a plain button and the page to the shortcuts', () => {
    expect(keyBelongsToTarget(element('BUTTON'))).toBe(false)
    expect(keyBelongsToTarget(element('BODY'))).toBe(false)
    expect(keyBelongsToTarget(null)).toBe(false)
  })
})
