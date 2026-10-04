/**
 * Which overlay the keyboard belongs to, and where Tab goes inside a modal
 * one. The DOM half (focus in and back, inert, the listener) was checked in
 * the running app; the renderer has no DOM test environment.
 */

import { describe, expect, it } from 'vitest'
import { LayerStack, trapStep } from './modal'

const panel = { name: 'providers', modal: false }
const detail = { name: 'detail', modal: true }
const palette = { name: 'palette', modal: true }

describe('LayerStack', () => {
  it('has nothing on top when nothing is open', () => {
    expect(new LayerStack().top()).toBeUndefined()
  })

  /** The detail view's scrim covers the docked Providers panel. */
  it('puts a modal layer over a panel opened after it', () => {
    const stack = new LayerStack<typeof panel>()
    stack.push(detail)
    stack.push(panel)
    expect(stack.top()).toBe(detail)
  })

  /** One Escape in the palette must not close the detail view under it as well. */
  it('puts the newest modal layer on top, and the one below back when it closes', () => {
    const stack = new LayerStack<typeof panel>()
    stack.push(detail)
    stack.push(palette)
    expect(stack.top()).toBe(palette)

    stack.remove(palette)
    expect(stack.top()).toBe(detail)
  })

  it('gives the keyboard to a panel when it is the only layer', () => {
    const stack = new LayerStack<typeof panel>()
    stack.push(panel)
    expect(stack.top()).toBe(panel)
  })
})

describe('trapStep', () => {
  it('wraps from the last control to the first, and back', () => {
    expect(trapStep(5, 4, false)).toBe(0)
    expect(trapStep(5, 0, true)).toBe(4)
  })

  it("leaves the browser's own order in between", () => {
    expect(trapStep(5, 2, false)).toBeNull()
    expect(trapStep(5, 2, true)).toBeNull()
  })

  it('brings the focus in from outside', () => {
    expect(trapStep(5, -1, false)).toBe(0)
    expect(trapStep(5, -1, true)).toBe(4)
  })

  it('does nothing in a layer with no controls', () => {
    expect(trapStep(0, -1, false)).toBeNull()
  })
})
