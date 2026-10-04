/**
 * Whether a key pressed on this element is the element's own: typing into a
 * field, or choosing in a control that takes keys itself (a select, the
 * rating's pips, which are radios).
 *
 * The app's bare-key shortcuts (the digits that switch tabs, `/`) must leave
 * those keys alone. Pressing "8" on a focused rating pip — the natural way to
 * try rating an 8 — switched to another tab instead.
 */

const OWN_KEYS_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
const OWN_KEYS_ROLES = new Set(['radio', 'slider', 'spinbutton', 'listbox', 'option', 'textbox', 'combobox'])

export interface KeyTarget {
  tagName: string
  isContentEditable?: boolean
  getAttribute(name: string): string | null
}

export function keyBelongsToTarget(target: KeyTarget | null): boolean {
  if (!target) return false
  if (OWN_KEYS_TAGS.has(target.tagName) || target.isContentEditable === true) return true
  const role = target.getAttribute('role')
  return role !== null && OWN_KEYS_ROLES.has(role)
}
