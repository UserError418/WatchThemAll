/**
 * The player's keyboard, in one place.
 *
 * Three documents can have the focus while something plays:
 * - the `/__player` shell, after the picture was clicked;
 * - the top bar, after one of its buttons was;
 * - the app window, right after Play was pressed.
 *
 * Each one maps the key here and sends the action to main, which routes it
 * (`InlinePlayer.action`). So a key means the same thing wherever the focus
 * happens to be, and there is one table to change.
 *
 * The map is the owner's (2026-09-27, v2):
 * - Space: play/pause. ←/→: back and forward 10 s. ↑/↓: volume.
 * - Backspace: back. Enter: episode browser. C: cast. R: reload.
 *   F: fullscreen.
 * - Escape keeps its old meaning (back), after leaving fullscreen first.
 * - M mutes, as in every other player.
 */

export const PLAYER_ACTIONS = [
  'togglePlay',
  'seekBack',
  'seekForward',
  'volumeUp',
  'volumeDown',
  'mute',
  'back',
  'escape',
  'episodes',
  'cast',
  'reload',
  'fullscreen',
  /** The source list. No key: the button in our bar asks for it. */
  'sources',
] as const

export type PlayerAction = (typeof PLAYER_ACTIONS)[number]

/** The actions the overlay carries out on the film itself; main routes the rest. */
export const TRANSPORT_ACTIONS = ['togglePlay', 'seekBack', 'seekForward', 'volumeUp', 'volumeDown', 'mute'] as const
export type TransportAction = (typeof TRANSPORT_ACTIONS)[number]

export function isPlayerAction(value: unknown): value is PlayerAction {
  return typeof value === 'string' && (PLAYER_ACTIONS as readonly string[]).includes(value)
}

export function isTransportAction(value: unknown): value is TransportAction {
  return typeof value === 'string' && (TRANSPORT_ACTIONS as readonly string[]).includes(value)
}

/** How far the arrow keys move, and by how much they change the volume. */
export const SEEK_STEP_SECONDS = 10
export const VOLUME_STEP = 0.1

/** The parts of a `KeyboardEvent` the map reads, so it can be tested without a DOM. */
export interface KeyPress {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  /** The focused element's tag, upper case, as `Element.tagName` gives it. */
  targetTag?: string
  /** An input's `type`, for telling a slider from a text field. */
  targetType?: string
  targetEditable?: boolean
}

const KEYS: Record<string, PlayerAction> = {
  ' ': 'togglePlay',
  ArrowLeft: 'seekBack',
  ArrowRight: 'seekForward',
  ArrowUp: 'volumeUp',
  ArrowDown: 'volumeDown',
  Backspace: 'back',
  Enter: 'episodes',
  Escape: 'escape',
  c: 'cast',
  r: 'reload',
  f: 'fullscreen',
  m: 'mute',
}

/**
 * Where typing goes to the element itself: a text field, a list, anything
 * editable. A range input is not one of them: its arrows would move the
 * volume slider instead of seeking.
 */
const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/**
 * Space and Enter are the player's even on a focused button.
 *
 * They once were not: Space and Enter on a focused button pressed it, as
 * they do on any page. But a click leaves focus behind on whatever was
 * clicked. That might be the picture (a button in the shell), a control, or
 * the detail view's Play button behind the player. So Enter "pressed" that
 * button instead of opening the episode browser (reported by the owner,
 * 2026-09-27). Every document that uses this map cancels the key's default,
 * so no focused button is pressed by it either.
 */
export function playerKeyAction(press: KeyPress): PlayerAction | null {
  if (press.ctrlKey || press.metaKey || press.altKey) return null
  const tag = press.targetTag ?? ''
  const typing = press.targetEditable || (TYPING.has(tag) && press.targetType !== 'range')
  if (typing) return press.key === 'Escape' ? 'escape' : null
  const key = press.key.length === 1 ? press.key.toLowerCase() : press.key
  return KEYS[key] ?? null
}

/** `playerKeyAction` for a real event. */
export function actionForEvent(event: KeyboardEvent): PlayerAction | null {
  const target = event.target as HTMLElement | null
  return playerKeyAction({
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    targetTag: target?.tagName,
    targetType: (target as HTMLInputElement | null)?.type,
    targetEditable: target?.isContentEditable === true,
  })
}
