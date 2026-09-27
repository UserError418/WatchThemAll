import { describe, expect, it } from 'vitest'

import { isPlayerAction, isTransportAction, playerKeyAction, type KeyPress } from './playerkeys'

const press = (key: string, extra: Partial<KeyPress> = {}): KeyPress => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...extra,
})

describe('playerKeyAction', () => {
  it("is the owner's map", () => {
    expect(
      [' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace', 'Enter', 'c', 'r', 'f'].map((key) =>
        playerKeyAction(press(key)),
      ),
    ).toEqual(['togglePlay', 'seekBack', 'seekForward', 'volumeUp', 'volumeDown', 'back', 'episodes', 'cast', 'reload', 'fullscreen'])
  })

  it('takes letters in either case, and M mutes', () => {
    expect(playerKeyAction(press('F'))).toBe('fullscreen')
    expect(playerKeyAction(press('M'))).toBe('mute')
  })

  it('leaves shortcuts with a modifier to the system', () => {
    expect(playerKeyAction(press('r', { ctrlKey: true }))).toBeNull()
    expect(playerKeyAction(press('f', { metaKey: true }))).toBeNull()
  })

  /** A search box behind the player, or the episode filter: typing is typing. */
  it('does nothing while typing, except Escape', () => {
    expect(playerKeyAction(press('Backspace', { targetTag: 'INPUT' }))).toBeNull()
    expect(playerKeyAction(press('r', { targetEditable: true }))).toBeNull()
    expect(playerKeyAction(press('Escape', { targetTag: 'INPUT' }))).toBe('escape')
  })

  /** A focused button in the bar: Space and Enter press it, as they always do. */
  it('lets Space and Enter press a focused button, but not the other keys', () => {
    expect(playerKeyAction(press(' ', { targetTag: 'BUTTON' }))).toBeNull()
    expect(playerKeyAction(press('Enter', { targetTag: 'BUTTON' }))).toBeNull()
    expect(playerKeyAction(press('ArrowRight', { targetTag: 'BUTTON' }))).toBe('seekForward')
  })

  it('ignores every other key', () => {
    expect(playerKeyAction(press('x'))).toBeNull()
    expect(playerKeyAction(press('Tab'))).toBeNull()
  })
})

describe('action guards', () => {
  it('accept only known actions, as main does for anything from a renderer', () => {
    expect(isPlayerAction('fullscreen')).toBe(true)
    expect(isPlayerAction('rm -rf')).toBe(false)
    expect(isTransportAction('seekBack')).toBe(true)
    expect(isTransportAction('back')).toBe(false)
  })
})
