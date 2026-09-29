import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { admitWindow, readIndex, windowFor, windowId, writeIndex, type CachedWindow } from './segmentcache'

const W = (patch: Partial<CachedWindow> = {}): CachedWindow => ({
  id: 'tv-tt0386676-4-1-abc',
  titleKey: 'tv:tt0386676',
  season: 4,
  episode: 1,
  providerId: 'vidsrc-me',
  startSeconds: 595.6,
  endSeconds: 625.6,
  filmSeconds: 2518.7,
  bytes: 6_600_000,
  savedAt: 1_000,
  ...patch,
})

describe('admitWindow', () => {
  it("replaces the title's previous window", () => {
    const { index, drop } = admitWindow([W({ id: 'old' })], W({ id: 'new', savedAt: 2_000 }))
    expect(index.map((w) => w.id)).toEqual(['new'])
    expect(drop.map((w) => w.id)).toEqual(['old'])
  })

  it('drops the oldest past the title limit and the byte limit', () => {
    const others = [W({ id: 'a', titleKey: 'a', savedAt: 3 }), W({ id: 'b', titleKey: 'b', savedAt: 1 }), W({ id: 'c', titleKey: 'c', savedAt: 2 })]
    const byTitles = admitWindow(others, W({ id: 'n', titleKey: 'n', savedAt: 9 }), { titles: 3, bytes: 1e12 })
    expect(byTitles.drop.map((w) => w.id)).toEqual(['b'])
    const byBytes = admitWindow(others, W({ id: 'n', titleKey: 'n', savedAt: 9, bytes: 15_000_000 }), { titles: 99, bytes: 25_000_000 })
    expect(byBytes.drop.map((w) => w.id)).toEqual(['b', 'c'])
  })

  it('never keeps more than the limits allow, and never drops the newest', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ key: fc.integer({ min: 0, max: 60 }), bytes: fc.integer({ min: 1, max: 60_000_000 }) }), { maxLength: 120 }),
        (adds) => {
          let index: CachedWindow[] = []
          adds.forEach((add, i) => {
            const added = W({ id: `w${i}`, titleKey: `t${add.key}`, bytes: add.bytes, savedAt: i })
            index = admitWindow(index, added).index
            expect(index.some((w) => w.id === added.id)).toBe(true)
            expect(index.length).toBeLessThanOrEqual(40)
            expect(index.reduce((s, w) => s + w.bytes, 0)).toBeLessThanOrEqual(1_000_000_000)
            expect(new Set(index.map((w) => w.titleKey)).size).toBe(index.length)
          })
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe('windowFor', () => {
  const where = { titleKey: 'tv:tt0386676', season: 4, episode: 1, providerId: 'vidsrc-me' }

  it('answers for the same episode and source, from inside the window', () => {
    expect(windowFor([W()], where, 600)?.id).toBe('tv-tt0386676-4-1-abc')
    expect(windowFor([W()], where, 594)?.id).toBe('tv-tt0386676-4-1-abc')
  })

  it('not for another source, another episode, or a place it cannot serve', () => {
    expect(windowFor([W()], { ...where, providerId: 'vidrock' }, 600)).toBeNull()
    expect(windowFor([W()], { ...where, episode: 2 }, 600)).toBeNull()
    expect(windowFor([W()], where, 400)).toBeNull()
    // Less than MIN_CACHE_AHEAD_SECONDS left.
    expect(windowFor([W()], where, 620)).toBeNull()
  })
})

describe('the index file', () => {
  it('round-trips, and drops entries it cannot trust', () => {
    const text = writeIndex([W()])
    expect(readIndex(JSON.parse(text))).toEqual([W()])
    expect(readIndex({ windows: [{ ...W(), id: '../../etc' }, { id: 'x' }, null] })).toEqual([])
    expect(readIndex('nonsense')).toEqual([])
  })

  it('names windows safely', () => {
    expect(windowId({ titleKey: 'tv:tt0386676', season: 4, episode: 1 }, 1_790_000_000_000)).toMatch(/^[a-z0-9-]+$/)
  })
})
