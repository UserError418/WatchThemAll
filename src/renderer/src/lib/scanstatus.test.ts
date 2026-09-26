import { describe, expect, it } from 'vitest'
import type { ScanInFlight } from '@shared/ipc'
import { listOf, scanStatus } from './scanstatus'

const test = (providerName: string, recheck = false): ScanInFlight => ({ providerId: providerName.toLowerCase(), providerName, recheck })

describe('scanStatus', () => {
  it('names every source under test, not only the latest to start', () => {
    const line = scanStatus([test('VidLux'), test('VidFast'), test('CinemaOS')], 4, 9)
    expect(line).toBe('Testing VidLux, VidFast and CinemaOS · 4 of 9 done')
  })

  it('says which are second tests of a red', () => {
    expect(scanStatus([test('VidSrc'), test('VidFast', true)], 7, 9)).toBe(
      'Testing VidSrc, double-checking VidFast · 7 of 9 done',
    )
  })

  it('drops the count once only second tests remain, so it does not read as stuck', () => {
    expect(scanStatus([test('VidFast', true), test('VidLux', true)], 9, 9)).toBe('Double-checking VidFast and VidLux')
  })

  it('says it is starting before anything is under test', () => {
    expect(scanStatus([], 0, 9)).toBe('Starting…')
  })
})

describe('listOf', () => {
  it('joins one, two and three names the way a sentence does', () => {
    expect(listOf(['A'])).toBe('A')
    expect(listOf(['A', 'B'])).toBe('A and B')
    expect(listOf(['A', 'B', 'C'])).toBe('A, B and C')
  })
})
