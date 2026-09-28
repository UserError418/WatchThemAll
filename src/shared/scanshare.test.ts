import { describe, expect, it } from 'vitest'
import { mergeSharedScans } from './scanshare'
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

