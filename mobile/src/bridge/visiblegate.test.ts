import { expect, it } from 'vitest'
import { createVisibleGate } from './visiblegate'

/** A page whose visibility the test sets. */
function page(initially: DocumentVisibilityState) {
  const listeners: Array<() => void> = []
  const fake = {
    visibilityState: initially,
    addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
    show() {
      fake.visibilityState = 'visible'
      for (const listener of listeners) listener()
    },
  }
  return fake
}

it('acts at once on a visible page', () => {
  const visible = page('visible')
  const acted: string[] = []

  createVisibleGate(visible as unknown as Document).run(() => acted.push('restore'))

  expect(acted).toEqual(['restore'])
})

it('holds the act on a hidden page until it is shown, and acts once', () => {
  const hidden = page('hidden')
  const acted: string[] = []
  const gate = createVisibleGate(hidden as unknown as Document)

  gate.run(() => acted.push('restore'))
  expect(acted).toEqual([])
  hidden.show()
  hidden.show()

  expect(acted).toEqual(['restore'])
})

it('keeps only the latest act, and none once cancelled', () => {
  const hidden = page('hidden')
  const acted: string[] = []
  const gate = createVisibleGate(hidden as unknown as Document)

  gate.run(() => acted.push('first'))
  gate.run(() => acted.push('second'))
  hidden.show()
  gate.run(() => acted.push('third'))
  expect(acted).toEqual(['second', 'third'])

  const again = page('hidden')
  const cancelled = createVisibleGate(again as unknown as Document)
  cancelled.run(() => acted.push('never'))
  cancelled.cancel()
  again.show()
  expect(acted).toEqual(['second', 'third'])
})
