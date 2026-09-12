import { describe, expect, it } from 'vitest'
import { chooseActiveProviders } from './activeproviders'
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

  it('drops ids the catalogue no longer has', () => {
    const result = chooseActiveProviders({
      stored: ['alpha', 'deleted', 'beta'],
      known: ['alpha', 'beta', 'gamma', 'deleted'],
      catalogue: CATALOGUE,
    })

    expect(result.active).toEqual(['alpha', 'beta'])
    expect(result.changed).toBe(true)
  })

  it('falls back to core when every stored id is gone', () => {
    // The failure this exists to prevent: a catalogue purge leaving an install
    // with an empty active list, so every play reports "no providers enabled"
    // on an app that worked the day before.
    const result = chooseActiveProviders({
      stored: ['dead-one', 'dead-two'],
      known: ['dead-one', 'dead-two'],
      catalogue: CATALOGUE,
    })

    expect(result.active).toEqual(['alpha', 'beta'])
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
