import { afterEach, describe, expect, it, vi } from 'vitest'
import { chooseActiveProviders } from './activeproviders'
import type { StoreCore } from '@shared/store/core'
import { syncOnce } from '@shared/sync/engine'
import { FakeDrive, libraryHost, storeOn } from '@shared/sync/fakedrive.fixture'
import type { Provider } from '@shared/types'

function provider(id: string, tier: 'core' | 'extras' = 'core'): Provider {
  return {
    id,
    name: id,
    rootUrl: `https://${id}.test/`,
    tv: { urlTemplate: '{rootUrl}tv/{imdb}/{season}/{episode}' },
    movie: { urlTemplate: '{rootUrl}movie/{imdb}' },
    tier,
  }
}

const CATALOGUE = [provider('alpha'), provider('beta'), provider('gamma', 'extras')]

describe('chooseActiveProviders', () => {
  it('enables the core tier on a first run', () => {
    const result = chooseActiveProviders({ stored: [], known: undefined, catalogue: CATALOGUE })

    expect(result.active).toEqual(['alpha', 'beta'])
    expect(result.changed).toBe(true)
  })

  it('leaves an established choice alone', () => {
    const result = chooseActiveProviders({
      stored: ['beta', 'gamma'],
      known: ['alpha', 'beta', 'gamma'],
      catalogue: CATALOGUE,
    })

    // `alpha` is core but the user has been offered it and did not take it.
    expect(result.active).toEqual(['beta', 'gamma'])
    expect(result.changed).toBe(false)
  })

  it('keeps the user’s order rather than the catalogue’s', () => {
    const result = chooseActiveProviders({
      stored: ['gamma', 'beta', 'alpha'],
      known: ['alpha', 'beta', 'gamma'],
      catalogue: CATALOGUE,
    })

    expect(result.active).toEqual(['gamma', 'beta', 'alpha'])
  })

  it('keeps ids this catalogue lacks: another device may still offer them', () => {
    const result = chooseActiveProviders({
      stored: ['alpha', 'deleted', 'beta'],
      known: ['alpha', 'beta', 'gamma', 'deleted'],
      catalogue: CATALOGUE,
    })

    expect(result.stored).toEqual(['alpha', 'deleted', 'beta'])
    expect(result.known).toContain('deleted')
    expect(result.changed).toBe(false)
  })

  it('falls back to core when every stored id is gone, for this device only', () => {
    // The failure this exists to prevent: a catalogue purge leaving an install
    // with nothing it can play, so every play reports "no providers enabled"
    // on an app that worked the day before. Nothing is stored for it: another
    // device may still offer what the list holds.
    const result = chooseActiveProviders({
      stored: ['dead-one', 'dead-two'],
      known: ['alpha', 'beta', 'gamma', 'dead-one', 'dead-two'],
      catalogue: CATALOGUE,
    })

    expect(result.active).toEqual(['alpha', 'beta'])
    expect(result.stored).toEqual(['dead-one', 'dead-two'])
    expect(result.changed).toBe(false)
  })

  it('enables the core tier beside ids that are gone, when it was never offered', () => {
    const result = chooseActiveProviders({
      stored: ['dead-one', 'dead-two'],
      known: ['dead-one', 'dead-two'],
      catalogue: CATALOGUE,
    })

    expect(result.active).toEqual(['dead-one', 'dead-two', 'alpha', 'beta'])
    expect(result.changed).toBe(true)
  })

  it('never takes an id off the known list', () => {
    const result = chooseActiveProviders({
      stored: ['alpha'],
      known: ['alpha', 'beta', 'gamma', 'from-a-newer-catalogue'],
      catalogue: CATALOGUE,
    })

    expect(result.known).toContain('from-a-newer-catalogue')
    expect(result.changed).toBe(false)
  })

  it('enables a core provider the user has never been offered', () => {
    const withNew = [...CATALOGUE, provider('vidsrc')]

    const result = chooseActiveProviders({
      stored: ['alpha'],
      known: ['alpha', 'beta', 'gamma'],
      catalogue: withNew,
    })

    expect(result.active).toEqual(['alpha', 'vidsrc'])
    expect(result.known).toContain('vidsrc')
    expect(result.changed).toBe(true)
  })

  it('does not enable a new provider in the extras tier', () => {
    const withNew = [...CATALOGUE, provider('mirror', 'extras')]

    const result = chooseActiveProviders({
      stored: ['alpha'],
      known: ['alpha', 'beta', 'gamma'],
      catalogue: withNew,
    })

    expect(result.active).toEqual(['alpha'])
    // Still recorded as offered, or it would be re-evaluated as new forever.
    expect(result.known).toContain('mirror')
  })

  it('does not re-enable a core provider the user switched off', () => {
    const first = chooseActiveProviders({
      stored: [],
      known: undefined,
      catalogue: CATALOGUE,
    })
    // The user then turns `beta` off.
    const afterToggle = first.active.filter((id) => id !== 'beta')

    const second = chooseActiveProviders({
      stored: afterToggle,
      known: first.known,
      catalogue: CATALOGUE,
    })

    expect(second.active).toEqual(['alpha'])
    expect(second.changed).toBe(false)
  })

  it('treats a missing known list as having offered nothing', () => {
    // An install predating the field. Everything core is new to it, which is
    // the same answer a first run gets — correct, because no record exists.
    const result = chooseActiveProviders({
      stored: ['alpha'],
      known: undefined,
      catalogue: CATALOGUE,
    })

    expect(result.active).toEqual(['alpha', 'beta'])
  })

  it('does not list a provider twice when it is both stored and unseen', () => {
    const result = chooseActiveProviders({
      stored: ['alpha', 'beta'],
      known: [],
      catalogue: CATALOGUE,
    })

    expect(result.active).toEqual(['alpha', 'beta'])
  })
})

/**
 * The decision as each device makes it after every load and every sync
 * (`library.applyEverything`): decide, and seed the lists when they changed.
 * The library goes between the two through an in-memory Drive.
 */
describe('provider lists on two devices', () => {
  function reconcile(store: StoreCore, catalogue: Provider[]): boolean {
    const view = store.read()
    const decision = chooseActiveProviders({
      stored: view.activeProviderIds,
      known: view.knownProviderIds,
      catalogue,
    })
    if (decision.changed) store.seedPatch({ activeProviderIds: decision.stored, knownProviderIds: decision.known })
    return decision.changed
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a newly installed device leaves the configured choices alone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 8, 1))
    const drive = new FakeDrive()
    const desktop = await storeOn('desktop')
    // The user's own choices, through `store.write` as the settings screen sends them.
    desktop.applyPatch({
      activeProviderIds: ['beta'],
      knownProviderIds: ['alpha', 'beta', 'gamma'],
      providerOrder: ['beta', 'alpha', 'gamma'],
    })
    const desktopBackend = drive.backend()
    await syncOnce(libraryHost(desktop), desktopBackend)

    // A week later the app is installed on a phone and opened, then paired.
    vi.setSystemTime(Date.UTC(2026, 8, 8))
    const phone = await storeOn('phone')
    expect(reconcile(phone, CATALOGUE)).toBe(true)
    phone.seedPreference('providerOrder', ['alpha', 'beta', 'gamma']) // `providerOrder()` on first use
    vi.setSystemTime(Date.UTC(2026, 8, 8, 0, 10))
    await syncOnce(libraryHost(phone), drive.backend())
    reconcile(phone, CATALOGUE)
    await syncOnce(libraryHost(desktop), desktopBackend)

    for (const store of [desktop, phone]) {
      expect(store.read().activeProviderIds).toEqual(['beta'])
      expect(store.read().providerOrder).toEqual(['beta', 'alpha', 'gamma'])
    }
  })

  it('a core provider switched off stays off while the other device has an older catalogue', async () => {
    const newer = [...CATALOGUE, provider('delta')]
    const drive = new FakeDrive()
    const desktop = await storeOn('desktop')
    const phone = await storeOn('phone')
    const desktopBackend = drive.backend()
    const phoneBackend = drive.backend()
    desktop.applyPatch({ activeProviderIds: ['alpha', 'beta'], knownProviderIds: ['alpha', 'beta', 'gamma', 'delta'] })
    await syncOnce(libraryHost(desktop), desktopBackend)

    const rewrites: boolean[] = []
    for (let round = 0; round < 3; round += 1) {
      await syncOnce(libraryHost(phone), phoneBackend)
      rewrites.push(reconcile(phone, CATALOGUE))
      await syncOnce(libraryHost(phone), phoneBackend)
      await syncOnce(libraryHost(desktop), desktopBackend)
      rewrites.push(reconcile(desktop, newer))
      await syncOnce(libraryHost(desktop), desktopBackend)
    }

    expect(desktop.read().activeProviderIds).toEqual(['alpha', 'beta'])
    expect(rewrites.filter(Boolean)).toEqual([])
  })

  it('an extras provider switched on stays on while the other device does not offer it', async () => {
    const newer = [...CATALOGUE, provider('epsilon', 'extras')]
    const drive = new FakeDrive()
    const desktop = await storeOn('desktop')
    const phone = await storeOn('phone')
    desktop.applyPatch({
      activeProviderIds: ['alpha', 'beta', 'epsilon'],
      knownProviderIds: ['alpha', 'beta', 'gamma', 'epsilon'],
    })
    await syncOnce(libraryHost(desktop), drive.backend())
    await syncOnce(libraryHost(phone), drive.backend())
    reconcile(phone, CATALOGUE)
    await syncOnce(libraryHost(phone), drive.backend())
    await syncOnce(libraryHost(desktop), drive.backend())
    reconcile(desktop, newer)

    expect(desktop.read().activeProviderIds).toEqual(['alpha', 'beta', 'epsilon'])
  })

  it('a core provider new to one catalogue reaches the other device, and the syncs then go quiet', async () => {
    const newer = [...CATALOGUE, provider('delta')]
    const drive = new FakeDrive()
    const desktop = await storeOn('desktop')
    const phone = await storeOn('phone')
    const desktopBackend = drive.backend()
    const phoneBackend = drive.backend()
    desktop.applyPatch({ activeProviderIds: ['alpha', 'beta'], knownProviderIds: ['alpha', 'beta', 'gamma'] })
    await syncOnce(libraryHost(desktop), desktopBackend)
    await syncOnce(libraryHost(phone), phoneBackend)

    // The desktop's catalogue gains `delta` before the phone's does.
    expect(reconcile(desktop, newer)).toBe(true)
    await syncOnce(libraryHost(desktop), desktopBackend)
    await syncOnce(libraryHost(phone), phoneBackend)
    reconcile(phone, CATALOGUE)
    expect(phone.read().activeProviderIds).toEqual(['alpha', 'beta', 'delta'])

    drive.uploads = 0
    for (let round = 0; round < 3; round += 1) {
      await syncOnce(libraryHost(phone), phoneBackend)
      reconcile(phone, CATALOGUE)
      await syncOnce(libraryHost(desktop), desktopBackend)
      reconcile(desktop, newer)
    }
    expect(drive.uploads).toBe(0)
  })
})
