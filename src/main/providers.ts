/**
 * Provider URL building.
 *
 * A provider is a URL template; playing something is substitution plus a
 * validity check. This is the one part of the original design worth keeping —
 * embed providers change domains constantly, and editing a template string is
 * the cheapest possible response to that.
 *
 * Note that providers key off **IMDB** ids, not TMDB. That is the whole reason
 * `MediaDetail` carries `imdbId`: TMDB is the metadata source, but the id the
 * provider needs comes from `tv/{id}/external_ids`.
 */

import type { PlayRequest } from '@shared/ipc'
import type { Provider } from '@shared/types'

/**
 * Substitute template placeholders and return an absolute URL, or null if the
 * result is not a valid URL — a template with an unfilled `{imdb}` produces a
 * URL that looks fine as a string and 404s at the provider.
 */
export function renderTemplate(
  provider: Provider,
  req: Pick<PlayRequest, 'imdbId' | 'tmdbId' | 'type' | 'season' | 'episode'>,
): string | null {
  const config = req.type === 'movie' ? provider.movie : provider.tv
  if (!config?.urlTemplate) return null

  const template = config.urlTemplate
  const rootUrl = provider.rootUrl.endsWith('/') ? provider.rootUrl : `${provider.rootUrl}/`

  /**
   * Refuse before substituting, not after.
   *
   * Substituting an empty string leaves a URL that still parses — `{imdb}`
   * missing turns `/tv/{imdb}/{season}/{episode}` into `/tv//2/5`, and the
   * double-slash cleanup below then tidies it into `/tv/2/5`. That reaches the
   * provider, 404s, and surfaces to the user as a blank player window with no
   * explanation. A missing value has to fail here instead.
   */
  const values: Record<string, string | null> = {
    rootUrl,
    imdb: req.imdbId || null,
    tmdb: req.tmdbId ? String(req.tmdbId) : null,
    season: req.season == null ? null : String(req.season),
    episode: req.episode == null ? null : String(req.episode),
  }

  for (const [name, value] of Object.entries(values)) {
    if (template.includes(`{${name}}`) && !value) return null
  }

  let url = template
    .replaceAll('{rootUrl}', rootUrl)
    .replaceAll('{imdb}', values.imdb ?? '')
    .replaceAll('{tmdb}', values.tmdb ?? '')
    .replaceAll('{season}', values.season ?? '')
    .replaceAll('{episode}', values.episode ?? '')

  // Collapse the double slashes that `{rootUrl}` normalisation introduces,
  // without touching the `https://` one.
  url = url.replace(/([^:])\/\//g, '$1/').replace(/\/\?/g, '?')

  try {
    return new URL(url).toString()
  } catch {
    return null
  }
}

/** One provider that can serve a request, and the URL it would be served at. */
export interface PlayCandidate {
  provider: Provider
  url: string
}

/**
 * What playback resolved to.
 *
 * `candidates` carries **every** provider that could serve this request, not
 * just the winner. That is what lets the player window switch source instantly
 * when one fails — the alternatives are already computed, so changing provider
 * is a navigation rather than a round trip back to main.
 */
export interface PlaySelection extends PlayCandidate {
  candidates: PlayCandidate[]
}

/**
 * Resolve a request to a provider and a URL.
 *
 * The requested provider is tried first, then the rest in the order given — so
 * the caller controls fallback ordering (by recorded outcome, by user
 * preference) and
 * this function stays deterministic and easy to test.
 *
 * A provider that cannot serve this media type, or needs an id the request
 * lacks, is skipped rather than failing the play outright.
 */
export function buildPlayUrl(providers: Provider[], req: PlayRequest): PlaySelection | null {
  const preferred = providers.filter((p) => p.id === req.providerId)
  const rest = providers.filter((p) => p.id !== req.providerId)

  const candidates: PlayCandidate[] = []
  for (const provider of [...preferred, ...rest]) {
    const url = renderTemplate(provider, req)
    if (url) candidates.push({ provider, url })
  }

  const chosen = candidates[0]
  return chosen ? { ...chosen, candidates } : null
}
