import { describe, expect, it } from 'vitest'
import type { Provider } from '@shared/types'
import type { PlayRequest } from '@shared/ipc'
import { buildPlayUrl } from './providers'

/**
 * Provider selection rules, tested at the level the IPC handler applies them.
 *
 * The rule these exist to protect: **a disabled provider is never reached.**
 * An earlier version of the handler appended the disabled providers after the
 * enabled ones as a last-resort fallback, which meant a provider the user
 * switched off — because it serves malware, or simply does not work — could
 * still be opened. The toggle has to mean what it says.
 */

const imdbOnly: Provider = {
  id: 'imdb-only',
  name: 'IMDB Only',
  rootUrl: 'https://imdb-only.test/',
  tv: { urlTemplate: '{rootUrl}tv/{imdb}/{season}/{episode}' },
  movie: { urlTemplate: '{rootUrl}movie/{imdb}' },
}

const tmdbOnly: Provider = {
  id: 'tmdb-only',
  name: 'TMDB Only',
  rootUrl: 'https://tmdb-only.test/',
  tv: { urlTemplate: '{rootUrl}tv/{tmdb}/{season}/{episode}' },
  movie: null,
}

const tvRequest: PlayRequest = {
  tmdbId: 125988,
  imdbId: 'tt14688458',
  type: 'tv',
  title: 'Silo',
  season: 1,
  episode: 1,
  providerId: null,
  runtimeMinutes: null,
}

describe('provider selection', () => {
  it('uses the first enabled provider that can build a URL', () => {
    expect(buildPlayUrl([imdbOnly, tmdbOnly], tvRequest)?.url).toBe(
      'https://imdb-only.test/tv/tt14688458/1/1',
    )
  })

  it('honours the requested provider over catalog order', () => {
    const selection = buildPlayUrl([imdbOnly, tmdbOnly], {
      ...tvRequest,
      providerId: 'tmdb-only',
    })
    expect(selection?.url).toBe('https://tmdb-only.test/tv/125988/1/1')
    expect(selection?.provider.id).toBe('tmdb-only')
  })

  it('skips a provider that cannot serve the media type', () => {
    const movie: PlayRequest = { ...tvRequest, type: 'movie', season: null, episode: null }
    // tmdbOnly has no movie template, so it must be passed over rather than
    // producing a broken URL.
    expect(buildPlayUrl([tmdbOnly, imdbOnly], movie)?.url).toBe(
      'https://imdb-only.test/movie/tt14688458',
    )
  })

  it('returns null when the only candidate needs an id the request lacks', () => {
    expect(buildPlayUrl([imdbOnly], { ...tvRequest, imdbId: null })).toBeNull()
  })

  it('still plays via a TMDB-keyed provider when the IMDB id is missing', () => {
    expect(buildPlayUrl([tmdbOnly], { ...tvRequest, imdbId: null })?.url).toBe(
      'https://tmdb-only.test/tv/125988/1/1',
    )
  })

  it('returns null for an empty provider list rather than inventing a URL', () => {
    expect(buildPlayUrl([], tvRequest)).toBeNull()
  })

  it('never reaches a provider outside the list it was given', () => {
    // This is the disabled-provider guarantee expressed at the unit level: the
    // handler passes only enabled providers, so nothing else can be selected.
    const selection = buildPlayUrl([imdbOnly], { ...tvRequest, providerId: 'tmdb-only' })
    expect(selection?.url).toBe('https://imdb-only.test/tv/tt14688458/1/1')
    expect(selection?.url).not.toContain('tmdb-only.test')
  })
})

/**
 * The fallback chain.
 *
 * Cycle 1 returned only the winning URL, so when that provider answered with a
 * 500 there was nothing to fall back to and the user got a blank window. The
 * candidate list is what makes recovery possible without another round trip.
 */
describe('fallback candidates', () => {
  it('lists every provider that can serve the request, not just the winner', () => {
    const selection = buildPlayUrl([imdbOnly, tmdbOnly], tvRequest)
    expect(selection?.candidates.map((c) => c.provider.id)).toEqual(['imdb-only', 'tmdb-only'])
  })

  it('puts the chosen provider first in the candidate list', () => {
    const selection = buildPlayUrl([imdbOnly, tmdbOnly], {
      ...tvRequest,
      providerId: 'tmdb-only',
    })
    expect(selection?.candidates[0]?.provider.id).toBe('tmdb-only')
    expect(selection?.candidates[0]?.url).toBe(selection?.url)
  })

  it('omits providers that cannot serve the request from the candidates', () => {
    const movie: PlayRequest = { ...tvRequest, type: 'movie', season: null, episode: null }
    const selection = buildPlayUrl([imdbOnly, tmdbOnly], movie)
    // tmdbOnly has no movie template — offering it as a fallback would just
    // fail again a second later.
    expect(selection?.candidates.map((c) => c.provider.id)).toEqual(['imdb-only'])
  })

  it('gives every candidate a distinct, already-built URL', () => {
    const selection = buildPlayUrl([imdbOnly, tmdbOnly], tvRequest)
    const urls = selection?.candidates.map((c) => c.url) ?? []
    expect(urls).toEqual([
      'https://imdb-only.test/tv/tt14688458/1/1',
      'https://tmdb-only.test/tv/125988/1/1',
    ])
    expect(new Set(urls).size).toBe(urls.length)
  })
})
