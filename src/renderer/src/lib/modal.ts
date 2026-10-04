/**
 * Overlays that take the keyboard: the detail view, the command palette, the
 * MyAnimeList import, and the Providers panel.
 *
 * Before this, none of them did anything about focus. Opening a title left
 * the focus on the card behind the scrim, Tab walked through the page under
 * the overlay (36 controls behind the detail view), and closing it dropped
 * the focus on <body>, so a keyboard user lost their place in the row.
 * Escape was a window listener in each overlay and in App, so a key meant for
 * one layer could close two.
 *
 * `use:layer` gives an overlay:
 *
 * - the focus on open (its `[data-autofocus]` control, else its first one),
 *   and the focus back where it was on close;
 * - when it is modal, Tab kept inside it, and the rest of the page `inert`
 *   while it is open — except what is marked `data-stays-live`: the toast,
 *   whose Undo must stay reachable, and the player, which plays on (and
 *   takes its own keys) over a detail view;
 * - Escape, for the topmost layer only. A layer's `onescape` says whether it
 *   took the key; one that did not (the detail view while a player is up)
 *   lets it on to the window listeners, the player's among them. A popover
 *   inside a layer keeps its own Escape by stopping it before it gets here.
 */

export interface LayerOptions {
  /** Takes the page: Tab stays inside, and everything else goes inert. */
  modal: boolean
  /** Escape with this layer on top. True when the layer took the key. */
  onescape: () => boolean
}

/**
 * Which open layer the keyboard belongs to.
 *
 * The newest modal one, else the newest: a modal draws its scrim over a
 * docked panel (the detail view over the Providers panel), so it is the one
 * on top whichever opened first. Pure, so the rule is tested on its own.
 */
export class LayerStack<T extends { modal: boolean }> {
  private layers: T[] = []

  push(layer: T): void {
    this.layers.push(layer)
  }

  remove(layer: T): void {
    this.layers = this.layers.filter((open) => open !== layer)
  }

  top(): T | undefined {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      if (this.layers[i]!.modal) return this.layers[i]
    }
    return this.layers[this.layers.length - 1]
  }
}

/**
 * Where Tab takes the focus inside a modal layer: the index to focus, or null
 * to leave it to the browser's own order.
 *
 * Wraps at both ends; from outside the layer (index -1) it comes in at the
 * first control, or the last for Shift+Tab.
 */
export function trapStep(count: number, index: number, backwards: boolean): number | null {
  if (count === 0) return null
  if (index === -1) return backwards ? count - 1 : 0
  if (backwards && index === 0) return count - 1
  if (!backwards && index === count - 1) return 0
  return null
}

interface Layer extends LayerOptions {
  node: HTMLElement
  /** What had the focus when the layer opened, to give it back on close. */
  opener: Element | null
  /** What this layer made inert. */
  inerted: Element[]
}

const stack = new LayerStack<Layer>()

/** Whether a modal layer is open: the app's bare-key shortcuts stand down while one is. */
export function modalLayerOpen(): boolean {
  return stack.top()?.modal === true
}

/**
 * How many open layers made each element inert, so that closing one of two
 * stacked modals does not wake the page under the other. Elements that were
 * inert before any layer touched them are never counted, nor woken.
 */
const inertBy = new Map<Element, number>()

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusables(node: HTMLElement): HTMLElement[] {
  return [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.tabIndex >= 0 && el.getClientRects().length > 0 && !el.closest('[inert]'),
  )
}

/** Inert every element beside the layer's own ancestors, except what stays live. */
function inertOutside(node: HTMLElement): Element[] {
  const inerted: Element[] = []
  for (let inner: Element = node; inner.parentElement && inner !== document.body; inner = inner.parentElement) {
    for (const sibling of inner.parentElement.children) {
      if (sibling === inner || sibling.hasAttribute('data-stays-live')) continue
      if (sibling.tagName === 'SCRIPT' || sibling.tagName === 'STYLE') continue
      const count = inertBy.get(sibling)
      if (count === undefined && sibling.hasAttribute('inert')) continue
      inertBy.set(sibling, (count ?? 0) + 1)
      sibling.setAttribute('inert', '')
      inerted.push(sibling)
    }
  }
  return inerted
}

function wake(inerted: Element[]): void {
  for (const element of inerted) {
    const count = (inertBy.get(element) ?? 1) - 1
    if (count > 0) {
      inertBy.set(element, count)
      continue
    }
    inertBy.delete(element)
    element.removeAttribute('inert')
  }
}

function onKeydown(event: KeyboardEvent): void {
  const top = stack.top()
  if (!top) return

  if (event.key === 'Escape') {
    if (top.onescape()) {
      event.preventDefault()
      event.stopPropagation()
    }
    return
  }

  if (event.key !== 'Tab' || !top.modal) return
  const active = document.activeElement
  // Focus somewhere this layer does not own (a palette opened over it) is
  // left alone; focus lost to <body> is brought back in.
  if (active && active !== document.body && !top.node.contains(active)) return
  const controls = focusables(top.node)
  const to = trapStep(controls.length, controls.indexOf(active as HTMLElement), event.shiftKey)
  if (to === null) return
  event.preventDefault()
  controls[to]!.focus()
}

/**
 * The Svelte action. On `document`, in the bubble phase: after a popover's
 * own handler (which may keep Escape by stopping it) and before App's window
 * listener.
 */
export function layer(node: HTMLElement, options: LayerOptions): { update: (next: LayerOptions) => void; destroy: () => void } {
  const entry: Layer = { ...options, node, opener: document.activeElement, inerted: [] }
  if (stack.top() === undefined) document.addEventListener('keydown', onKeydown)
  stack.push(entry)
  // Marked in the page, so the phone's Back button can tell an open layer
  // (which its Escape closes) from the page underneath (`bridge/index.ts`).
  node.setAttribute('data-layer', '')
  if (entry.modal) entry.inerted = inertOutside(node)

  const first = node.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(node)[0]
  first?.focus({ preventScroll: true })

  return {
    update(next) {
      entry.onescape = next.onescape
    },
    destroy() {
      node.removeAttribute('data-layer')
      stack.remove(entry)
      wake(entry.inerted)
      if (stack.top() === undefined) document.removeEventListener('keydown', onKeydown)
      if (entry.opener instanceof HTMLElement && entry.opener.isConnected) entry.opener.focus({ preventScroll: true })
    },
  }
}
