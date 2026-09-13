import { describe, expect, it } from 'vitest'
import type { Provider, ProviderCatalog } from '@shared/types'
import { buildPlayUrl, renderTemplate } from './providers'
import catalogDocument from './providers.json'

const tvPath: Provider = {
  id: 'path-style',
  name: 'Path Style',
  rootUrl: 'https://example.test/',
  tv: { urlTemplate: '{rootUrl}tv/{imdb}/{season}/{episode}' },
  movie: { urlTemplate: '{rootUrl}movie/{imdb}' },
}

const tvQuery: Provider = {
  id: 'query-style',
  name: 'Query Style',
  rootUrl: 'https://query.test/embed/',
  tv: { urlTemplate: '{rootUrl}tv?imdb={imdb}&season={season}&episode={episode}' },
  movie: { urlTemplate: '{rootUrl}movie/{imdb}' },
}

const tmdbOnly: Provider = {
  id: 'tmdb-style',
  name: 'TMDB Style',
  rootUrl: 'https://tmdb.test/player',
  tv: { urlTemplate: '{rootUrl}/{tmdb}/{season}/{episode}' },
  movie: null,
}

const base = {
  imdbId: 'tt0903747',
  tmdbId: 1396,
  type: 'tv' as const,
  season: 2,
  episode: 5,
  runtimeMinutes: null,
}

describe('renderTemplate', () => {
  it('substitutes a path-style TV template', () => {
    expect(renderTemplate(tvPath, base)).toBe('https://example.test/tv/tt0903747/2/5')
  })

  it('substitutes a query-style TV template', () => {
    expect(renderTemplate(tvQuery, base)).toBe(
      'https://query.test/embed/tv?imdb=tt0903747&season=2&episode=5',
    )
  })

  it('uses the movie template and ignores season/episode for films', () => {
    const url = renderTemplate(tvPath, { ...base, type: 'movie', season: null, episode: null })
    expect(url).toBe('https://example.test/movie/tt0903747')
  })

  it('appends a missing trailing slash to rootUrl exactly once', () => {
    const noSlash: Provider = { ...tvPath, rootUrl: 'https://example.test' }
    expect(renderTemplate(noSlash, base)).toBe('https://example.test/tv/tt0903747/2/5')
  })

  it('returns null rather than a URL with an empty id when imdbId is missing', () => {
    // The original substituted an empty string, producing ".../tv//2/5" — a
    // URL that parses fine and 404s at the provider, so the failure surfaced
    // as a blank player window instead of an error.
    expect(renderTemplate(tvPath, { ...base, imdbId: null })).toBeNull()
  })

  it('returns null when the provider does not serve this media type', () => {
    expect(renderTemplate(tmdbOnly, { ...base, type: 'movie' })).toBeNull()
  })

  it('builds TMDB-keyed providers from the numeric id', () => {
    expect(renderTemplate(tmdbOnly, { ...base, imdbId: null })).toBe(
      'https://tmdb.test/player/1396/2/5',
    )
  })

  it('does not mangle the protocol when collapsing double slashes', () => {
    const url = renderTemplate(tvPath, base)
    expect(url?.startsWith('https://')).toBe(true)
  })
})

describe('buildPlayUrl', () => {
  const providers = [tvPath, tvQuery]

  it('prefers the requested provider', () => {
    const selection = buildPlayUrl(providers, { ...base, title: 'x', providerId: 'query-style' })
    expect(selection?.url).toContain('query.test')
  })

  it('falls through to another provider when the preferred one cannot serve it', () => {
    const selection = buildPlayUrl([tmdbOnly, tvPath], {
      ...base,
      type: 'movie',
      season: null,
      episode: null,
      title: 'x',
      providerId: 'tmdb-style',
    })
    expect(selection?.url).toBe('https://example.test/movie/tt0903747')
  })

  it('returns null when no provider can build a URL', () => {
    expect(
      buildPlayUrl([tmdbOnly], {
        ...base,
        type: 'movie',
        title: 'x',
        providerId: null,
        season: null,
        episode: null,
      }),
    ).toBeNull()
  })
})

describe('bundled provider catalog', () => {
  const providers = (catalogDocument as ProviderCatalog).providers

  it('is non-empty and every entry has an id, name and rootUrl', () => {
    expect(providers.length).toBeGreaterThan(0)
    for (const p of providers) {
      expect(p.id, `${p.name} needs an id`).toBeTruthy()
      expect(p.name, `${p.id} needs a name`).toBeTruthy()
      expect(() => new URL(p.rootUrl), `${p.id} rootUrl must parse`).not.toThrow()
    }
  })

  it('has unique provider ids', () => {
    const ids = providers.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('produces a usable URL from every catalog entry that claims TV support', () => {
    // Guards the catalog itself: a template typo here is invisible until
    // somebody selects that provider and gets a blank window.
    for (const p of providers.filter((p) => p.tv)) {
      expect(renderTemplate(p, base), `${p.id} tv template`).not.toBeNull()
    }
  })
})


/**
 * Resuming through the URL.
 *
 * The phone has no other way: it cannot reach into a cross-origin frame to set
 * `currentTime`, so a provider either takes the position as a parameter or the
 * episode starts over. Every rule here is about *not* sending a position that
 * would make things worse than sending none.
 */
describe('resume position in the URL', () => {
  const resuming: Provider = { ...tvPath, id: 'resuming', resumeParam: 'progress' }
  const resumingQuery: Provider = { ...tvQuery, id: 'resuming-query', resumeParam: 'startAt' }

  it('appends the parameter the provider reads', () => {
    expect(renderTemplate(resuming, base, { seconds: 1200, duration: 3600 })).toBe(
      'https://example.test/tv/tt0903747/2/5?progress=1200',
    )
  })

  it('joins an existing query string rather than starting a second one', () => {
    const url = renderTemplate(resumingQuery, base, { seconds: 900, duration: 3600 })
    expect(url).toContain('season=2')
    expect(url).toContain('startAt=900')
    expect(url?.match(/\?/g)).toHaveLength(1)
  })

  it('sends whole seconds', () => {
    // No provider measured wanted more precision, and a fractional value is one
    // more thing for a strict parser to reject.
    expect(renderTemplate(resuming, base, { seconds: 1200.87, duration: 3600 })).toBe(
      'https://example.test/tv/tt0903747/2/5?progress=1200',
    )
  })

  it('leaves a provider that reads no parameter completely alone', () => {
    // Appending an unknown parameter is not free: some providers 404 on one.
    expect(renderTemplate(tvPath, base, { seconds: 1200, duration: 3600 })).toBe(
      'https://example.test/tv/tt0903747/2/5',
    )
  })

  it('does not resume into the first minute', () => {
    // The normal state of a stream that has just loaded. Resuming into it is
    // indistinguishable from not resuming, and costs a parameter.
    expect(renderTemplate(resuming, base, { seconds: 30, duration: 3600 })).toBe(
      'https://example.test/tv/tt0903747/2/5',
    )
  })

  it('does not resume into the credits', () => {
    // The same line that decides "watched". A position past it has nothing left
    // to resume into, and using it drops the user into the closing titles.
    expect(renderTemplate(resuming, base, { seconds: 3590, duration: 3600 })).toBe(
      'https://example.test/tv/tt0903747/2/5',
    )
  })

  it('still resumes when the provider never reported a duration', () => {
    // Common — several providers report a position and no length. Only the
    // "past the credits" half of the check is unanswerable, and the first
    // minute rule still applies.
    expect(renderTemplate(resuming, base, { seconds: 1200, duration: null })).toBe(
      'https://example.test/tv/tt0903747/2/5?progress=1200',
    )
  })

  it('gives the position to every candidate, not only the winner', () => {
    // Falling back to another source mid-episode used to restart the title,
    // which is the moment a resume matters most.
    const selection = buildPlayUrl(
      [resuming, resumingQuery],
      { ...base, title: 'x', providerId: 'resuming' },
      { seconds: 1200, duration: 3600 },
    )
    expect(selection?.candidates).toHaveLength(2)
    expect(selection?.candidates.every((c) => /progress=1200|startAt=1200/.test(c.url))).toBe(true)
  })

  it('is absent by default, so nothing changes for a provider not measured', () => {
    const selection = buildPlayUrl([tvPath], { ...base, title: 'x', providerId: 'path-style' })
    expect(selection?.url).toBe('https://example.test/tv/tt0903747/2/5')
  })
})
