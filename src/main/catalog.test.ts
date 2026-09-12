import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { validateCatalog, resolveProviders, CATALOG_VERSION, type CachedCatalog } from './catalog'
import type { Provider, ProviderCatalog } from '@shared/types'
import bundledDocument from './providers.json'

/**
 * The managed provider list.
 *
 * These tests exist because of one property: a bad remote document must change
 * nothing. The remote list is fetched from the internet and applied without a
 * human looking at it, so every way it can be wrong has to end in "keep the
 * list we already had" rather than in a user who cannot play anything.
 */

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'p1',
    name: 'Provider One',
    rootUrl: 'https://example.com/',
    tv: { urlTemplate: '{rootUrl}tv/{imdb}/{season}/{episode}' },
    movie: { urlTemplate: '{rootUrl}movie/{imdb}' },
    ...overrides,
  }
}

function document(providers: Provider[], overrides: Record<string, unknown> = {}): unknown {
  return { version: CATALOG_VERSION, updatedAt: '2026-09-06', providers, ...overrides }
}

describe('accepting a good document', () => {
  it('accepts a well-formed catalogue', () => {
    const result = validateCatalog(document([provider()]))
    expect(result.ok).toBe(true)
  })

  it('accepts a provider that serves only films', () => {
    const result = validateCatalog(document([provider({ tv: null })]))
    expect(result.ok).toBe(true)
  })

  it('accepts fields it has never heard of', () => {
    // An older client must not reject the list because a newer one publishes a
    // key it does not know — otherwise adding any field breaks every install
    // that has not updated yet.
    const withFuture = { ...provider(), quality: 'uhd', region: 'eu' }
    const result = validateCatalog(document([withFuture as Provider]))
    expect(result.ok).toBe(true)
  })
})

describe('rejecting a bad document, wholesale', () => {
  const cases: [string, unknown][] = [
    ['not an object', 'nonsense'],
    ['null', null],
    ['an array', [provider()]],
    ['a future schema version', document([provider()], { version: 99 })],
    ['a missing updatedAt', { version: CATALOG_VERSION, providers: [provider()] }],
    ['providers not an array', document([], { providers: 'lots' })],
    ['an empty provider list', document([])],
    ['a provider with no id', document([provider({ id: '' })])],
    ['a provider with no name', document([provider({ name: '  ' })])],
    ['a provider with an unparseable rootUrl', document([provider({ rootUrl: 'not a url' })])],
    ['a provider served over plain HTTP', document([provider({ rootUrl: 'http://example.com/' })])],
    ['a provider that serves neither type', document([provider({ tv: null, movie: null })])],
    ['a provider with an empty template', document([provider({ tv: { urlTemplate: '' } })])],
    ['two providers sharing an id', document([provider(), provider()])],
  ]

  for (const [description, raw] of cases) {
    it(`rejects ${description}`, () => {
      expect(validateCatalog(raw).ok).toBe(false)
    })
  }

  /**
   * The case this whole design is for.
   *
   * A truncated download parses as valid JSON far more often than intuition
   * suggests, and a partial catalogue is indistinguishable from a correct one
   * that happens to be missing the provider you needed. Rejecting the document
   * because *one* entry is malformed is the only way that failure is visible.
   */
  it('rejects the whole document when a single entry is malformed', () => {
    const result = validateCatalog(
      document([provider({ id: 'good-1' }), provider({ id: 'broken', rootUrl: 'nope' }), provider({ id: 'good-2' })]),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('index 1')
  })
})

describe('deciding which list is in force', () => {
  const bundledList = [provider({ id: 'a' }), provider({ id: 'b' })]

  function cache(providers: Provider[]): CachedCatalog {
    return { catalog: { version: CATALOG_VERSION, updatedAt: '2026-09-06', providers }, etag: null, fetchedAt: 1 }
  }

  it('falls back to the bundled list when nothing has been fetched', () => {
    expect(resolveProviders(bundledList, null, []).map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('lets the remote list replace the bundled one entirely', () => {
    // Replacement, not merging: this is what lets a provider that has died stop
    // being offered. A merge could only ever add.
    const resolved = resolveProviders(bundledList, cache([provider({ id: 'c' })]), [])
    expect(resolved.map((p) => p.id)).toEqual(['c'])
  })

  it('keeps custom providers through a refresh', () => {
    const custom = provider({ id: 'mine', name: 'My Own' })
    const resolved = resolveProviders(bundledList, cache([provider({ id: 'c' })]), [custom])
    expect(resolved.map((p) => p.id)).toEqual(['c', 'mine'])
  })

  it('lets a custom provider override a catalogue entry of the same id', () => {
    // Editing an entry is a deliberate act. A background refresh silently
    // reverting it would be a bug the user has no way to diagnose.
    const custom = provider({ id: 'a', name: 'My Fixed Version', rootUrl: 'https://fixed.example/' })
    const resolved = resolveProviders(bundledList, null, [custom])

    expect(resolved.filter((p) => p.id === 'a')).toHaveLength(1)
    expect(resolved.find((p) => p.id === 'a')?.name).toBe('My Fixed Version')
  })
})

/**
 * The bundled list is the offline floor, so it has to satisfy everything the
 * remote list must — it is loaded by exactly the same code path.
 */
describe('the bundled catalogue', () => {
  const providers = (bundledDocument as ProviderCatalog).providers

  it('passes the same validation a fetched document has to pass', () => {
    // Literally the same call: the bundled list is loaded by the same code path
    // as a fetched one, so a bundled list that would be rejected over the wire
    // is a list that only works by accident.
    expect(validateCatalog(bundledDocument).ok).toBe(true)
  })

  it('has no duplicate ids', () => {
    const ids = providers.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('has no two entries pointing at the same origin', () => {
    // Two ids on one origin is a mirror that was never grouped, which is the
    // clutter this cleanup exists to remove.
    const origins = providers.map((p) => new URL(p.rootUrl).origin)
    expect(new Set(origins).size).toBe(origins.length)
  })

  it('gives every grouped provider at least one sibling', () => {
    // A group of one is a mistake — either the sibling was removed and the
    // group should go too, or the sibling was never added.
    const counts = new Map<string, number>()
    for (const p of providers) {
      if (p.group) counts.set(p.group, (counts.get(p.group) ?? 0) + 1)
    }
    const lonely = [...counts.entries()].filter(([, n]) => n < 2).map(([g]) => g)
    expect(lonely).toEqual([])
  })

  it('uses only placeholders the renderer knows how to substitute', () => {
    const known = new Set(['rootUrl', 'imdb', 'tmdb', 'season', 'episode'])
    for (const p of providers) {
      for (const template of [p.tv?.urlTemplate, p.movie?.urlTemplate]) {
        for (const match of (template ?? '').matchAll(/\{(\w+)\}/g)) {
          expect(known, `${p.id} uses {${match[1]}}`).toContain(match[1])
        }
      }
    }
  })

  it('never asks a film template for a season or an episode', () => {
    // A film has neither, so the placeholder can never be filled and
    // `renderTemplate` correctly refuses — meaning the provider silently never
    // appears as a candidate for any film at all.
    for (const p of providers) {
      const template = p.movie?.urlTemplate ?? ''
      expect(template, `${p.id} film template`).not.toMatch(/\{(season|episode)\}/)
    }
  })
})

/**
 * The published list and the bundled floor.
 *
 * `catalog/providers.json` is what installs actually fetch. It is allowed to be
 * *newer* than the bundled copy — that is the entire point — but it must always
 * be a document this build would accept, or publishing it silently disables the
 * managed list for everyone and nobody finds out until a provider dies.
 */
describe('the published catalogue', () => {
  it('is a document this build would accept', async () => {
    const raw = await readFile(new URL('../../catalog/providers.json', import.meta.url), 'utf8')
    const result = validateCatalog(JSON.parse(raw))

    expect(result.ok, result.ok ? '' : result.reason).toBe(true)
  })
})
