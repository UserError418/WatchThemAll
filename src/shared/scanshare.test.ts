import { describe, expect, it } from 'vitest'
import { mergeSharedScans, withSharedResults } from './scanshare'
import { MAX_SCANS, RESULT_TTL_MS } from './scanrow'
import type { ProviderScan, SharedScan } from './types'

const now = 1_800_000_000_000
const HOUR = 60 * 60 * 1000

const row = (titleKey: string, at: number, verdicts: ProviderScan['verdicts'], extra: Partial<ProviderScan> = {}): ProviderScan => ({
  titleKey,
  at,
  verdicts,
  testedAt: Object.fromEntries(Object.keys(verdicts).map((id) => [id, at])),
  ...extra,
})

const shared = (from: SharedScan['deviceKind'], scan: ProviderScan, deviceId = `${from}-1`): SharedScan => ({
  ...scan,
  deviceId,
  deviceKind: from,
})

const side = (deviceId: string, parts: Partial<{ deviceKind: 'desktop' | 'phone'; providerScans: ProviderScan[]; sharedScans: SharedScan[] }> = {}) => ({
  deviceId,
  deviceKind: parts.deviceKind,
  providerScans: parts.providerScans ?? [],
  sharedScans: parts.sharedScans ?? [],
})

describe('mergeSharedScans', () => {
  it("files a peer's own results under the peer", () => {
    const pcRow = row('tv:tt1', now - HOUR, { a: 'stream', b: 'dead' })
    const merged = mergeSharedScans(side('phone-1'), side('pc-1', { deviceKind: 'desktop', providerScans: [pcRow] }), now)
    expect(merged).toEqual([{ ...pcRow, deviceId: 'pc-1', deviceKind: 'desktop' }])
  })

  it('keeps reds in storage: they withdraw an older green when read', () => {
    const merged = mergeSharedScans(side('phone-1'), side('pc-1', { deviceKind: 'desktop', providerScans: [row('tv:tt1', now, { a: 'dead' })] }), now)
    expect(merged[0]?.verdicts).toEqual({ a: 'dead' })
  })

  it("never files this device's own results, even relayed back by a peer", () => {
    const mine = shared('phone', row('tv:tt1', now, { a: 'stream' }), 'phone-1')
    const merged = mergeSharedScans(side('phone-1'), side('pc-1', { deviceKind: 'desktop', sharedScans: [mine] }), now)
    expect(merged).toEqual([])
  })

  it("relays a third device's results, newest row per device and title winning", () => {
    const older = shared('desktop', row('tv:tt1', now - 2 * HOUR, { a: 'stream' }), 'pc-2')
    const newer = shared('desktop', row('tv:tt1', now - HOUR, { a: 'dead' }), 'pc-2')
    const merged = mergeSharedScans(
      side('phone-1', { sharedScans: [older] }),
      side('pc-1', { deviceKind: 'desktop', sharedScans: [newer] }),
      now,
    )
    expect(merged).toEqual([newer])
  })

  it('imports nothing from a document that does not say what kind of device wrote it', () => {
    const merged = mergeSharedScans(side('phone-1'), side('old-1', { providerScans: [row('tv:tt1', now, { a: 'stream' })] }), now)
    expect(merged).toEqual([])
  })

  it('drops rows past their lifetime and bounds each device like its own rows', () => {
    const stale = row('tv:old', now - RESULT_TTL_MS - 1, { a: 'stream' })
    const many = Array.from({ length: MAX_SCANS + 5 }, (_, i) => row(`tv:tt${i}`, now - (MAX_SCANS + 5 - i), { a: 'stream' }))
    const merged = mergeSharedScans(side('phone-1'), side('pc-1', { deviceKind: 'desktop', providerScans: [stale, ...many] }), now)
    expect(merged).toHaveLength(MAX_SCANS)
    expect(merged.some((r) => r.titleKey === 'tv:old')).toBe(false)
    // The newest titles are the ones kept.
    expect(merged.at(-1)?.titleKey).toBe(`tv:tt${MAX_SCANS + 4}`)
  })
})

describe('withSharedResults', () => {
  it("fills a gap with another device's green, and says where it came from", () => {
    const pc = shared('desktop', row('tv:tt1', now - HOUR, { a: 'stream' }, { timings: { a: 900 }, delivery: { a: 'progressive' } }))
    const { scan, sharedFrom } = withSharedResults(null, [pc], 'tv:tt1', 'phone', now)
    expect(scan?.verdicts).toEqual({ a: 'stream' })
    expect(scan?.timings).toEqual({ a: 900 })
    expect(scan?.delivery).toEqual({ a: 'progressive' })
    expect(sharedFrom).toEqual({ a: 'desktop' })
  })

  it('never lets a red or an amber cross', () => {
    const pc = shared('desktop', row('tv:tt1', now - HOUR, { a: 'dead', b: 'unsure' }))
    const { scan, sharedFrom } = withSharedResults(null, [pc], 'tv:tt1', 'phone', now)
    expect(scan).toBeNull()
    expect(sharedFrom).toEqual({})
  })

  it("keeps this device's own newer result, whatever it says", () => {
    const own = row('tv:tt1', now - HOUR, { a: 'dead' })
    const pc = shared('desktop', row('tv:tt1', now - 2 * HOUR, { a: 'stream' }))
    const { scan, sharedFrom } = withSharedResults(own, [pc], 'tv:tt1', 'phone', now)
    expect(scan?.verdicts).toEqual({ a: 'dead' })
    expect(sharedFrom).toEqual({})
  })

  it("lets another device's newer green replace an older red here", () => {
    // The hotel-wifi red from yesterday, and the desktop at home streaming it today.
    const own = row('tv:tt1', now - 24 * HOUR, { a: 'dead' }, { reasons: { a: { kind: 'unreachable' } } })
    const pc = shared('desktop', row('tv:tt1', now - HOUR, { a: 'stream' }))
    const { scan } = withSharedResults(own, [pc], 'tv:tt1', 'phone', now)
    expect(scan?.verdicts).toEqual({ a: 'stream' })
    expect(scan?.reasons).toEqual({})
  })

  it("reads the phone's green as amber on the desktop, without a timing", () => {
    const phone = shared('phone', row('tv:tt1', now - HOUR, { a: 'stream' }, { timings: { a: 700 }, delivery: { a: 'segmented' } }))
    const { scan, sharedFrom } = withSharedResults(null, [phone], 'tv:tt1', 'desktop', now)
    expect(scan?.verdicts).toEqual({ a: 'unsure' })
    expect(scan?.timings).toEqual({})
    // Castability still crosses: how the source hands out video is about its servers.
    expect(scan?.delivery).toEqual({ a: 'segmented' })
    expect(sharedFrom).toEqual({ a: 'phone' })
  })

  it('does not read a phone green as amber over a play here that came after it', () => {
    const phone = shared('phone', row('tv:tt1', now - 2 * HOUR, { a: 'stream' }))
    const { scan } = withSharedResults(null, [phone], 'tv:tt1', 'desktop', now, { a: now - HOUR })
    expect(scan).toBeNull()
  })

  it('ignores other titles and results past their lifetime', () => {
    const other = shared('desktop', row('tv:tt2', now, { a: 'stream' }))
    const stale = shared('desktop', row('tv:tt1', now - RESULT_TTL_MS - 1, { a: 'stream' }))
    expect(withSharedResults(null, [other, stale], 'tv:tt1', 'phone', now).scan).toBeNull()
  })

  it('takes the newest green when two other devices both have one', () => {
    const pc = shared('desktop', row('tv:tt1', now - 3 * HOUR, { a: 'stream' }, { delivery: { a: 'segmented' } }), 'pc-1')
    const laptop = shared('desktop', row('tv:tt1', now - HOUR, { a: 'stream' }, { delivery: { a: 'progressive' } }), 'pc-2')
    const { scan } = withSharedResults(null, [pc, laptop], 'tv:tt1', 'phone', now)
    expect(scan?.delivery).toEqual({ a: 'progressive' })
    expect(scan?.testedAt).toEqual({ a: now - HOUR })
  })
})
