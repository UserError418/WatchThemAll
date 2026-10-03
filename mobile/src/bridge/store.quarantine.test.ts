/**
 * The phone keeps every unreadable library it finds, each under its own name.
 *
 * It used one fixed slot, and `Filesystem.copy` will not overwrite: a second
 * incident, months after the first, could not be kept at all, and the store
 * then wrote an empty library over the only copy of the newer one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

const { copy } = vi.hoisted(() => ({ copy: vi.fn(async () => ({})) }))
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { copy },
  Directory: { Data: 'DATA' },
  Encoding: { UTF8: 'utf8' },
}))

const { CapacitorPersistence } = await import('./store')

afterEach(() => {
  vi.useRealTimers()
})

describe('the phone setting an unreadable library aside', () => {
  it('copies each one to a name of its own, and says which', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const persistence = new CapacitorPersistence('watchthemall.json')

    vi.setSystemTime(1_000)
    const first = await persistence.quarantine()
    vi.setSystemTime(2_000)
    const second = await persistence.quarantine()

    expect(first).toBe('watchthemall.corrupt-1000.json')
    expect(second).toBe('watchthemall.corrupt-2000.json')
    expect(copy).toHaveBeenLastCalledWith(expect.objectContaining({ from: 'watchthemall.json', to: second }))
  })
})
