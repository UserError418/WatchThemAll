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
import { shouldStorePosition } from './resume'
import type { ResumeOffer } from './resume'

/**
 * Put the start position into the URL, for providers that read one.
 *
 * This is the *only* mechanism that resumes on Android. The desktop sets
 * `currentTime` inside the provider's frame through `WebFrameMain`, which has
 * no equivalent in a WebView: `evaluateJavascript` reaches the main frame only,
 * and most providers nest their player an iframe deeper. So a phone either
 * asks the provider to start in the right place or starts over.
 *
 * Reused on the desktop rather than kept mobile-only, and that is not just
 * tidiness. Seeking after load makes the user watch the first seconds of the
 * episode before being yanked forward; arriving at the right frame is simply
 * better. The existing seek stays as the fallback and stands down on its own —
 * `shouldSeek` declines once the provider has already restored the position.
 *
 * The same threshold as storing, deliberately: a position not worth writing
 * down is not worth resuming into either, and the two drifting apart is how you
 * get an app that offers to drop the user into the closing credits.
 */
function withResume(url: string, provider: Provider, resume: ResumeOffer | null): string {
  if (resume === null || !provider.resumeParam) return url
  if (!shouldStorePosition(resume.seconds, resume.duration ?? 0)) return url

  try {
    const parsed = new URL(url)
    /**
     * Never overwrite something the template already set.
     *
     * The catalogue is a remote document, and a `resumeParam` of `imdb` on a
     * template that carries `?imdb=` would replace the title's id with a number
     * of seconds. That is a typo away, and it would present as the provider
     * playing the wrong thing rather than as a bad catalogue.
     */
    if (parsed.searchParams.has(provider.resumeParam)) return url
    // Whole seconds. No provider measured here wanted more precision, and a
    // fractional value is one more thing for a strict parser to reject.
    parsed.searchParams.set(provider.resumeParam, String(Math.floor(resume.seconds)))
    return parsed.toString()
  } catch {
    // `renderTemplate` already parsed this once, so failing here would be
    // surprising — but a URL without the position beats no URL at all.
    return url
  }
}

/**
 * Substitute template placeholders and return an absolute URL, or null if the
 * result is not a valid URL — a template with an unfilled `{imdb}` produces a
 * URL that looks fine as a string and 404s at the provider.
 */
export function renderTemplate(
  provider: Provider,
  req: Pick<PlayRequest, 'imdbId' | 'tmdbId' | 'type' | 'season' | 'episode'>,
  resume: ResumeOffer | null = null,
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
    return withResume(new URL(url).toString(), provider, resume)
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
export function buildPlayUrl(
  providers: Provider[],
  req: PlayRequest,
  /**
   * Applied to every candidate, not only the winner. Falling back to another
   * source mid-episode used to restart the title from the beginning, which is
   * the moment a resume matters most.
   */
  resume: ResumeOffer | null = null,
): PlaySelection | null {
  const preferred = providers.filter((p) => p.id === req.providerId)
  const rest = providers.filter((p) => p.id !== req.providerId)

  const candidates: PlayCandidate[] = []
  for (const provider of [...preferred, ...rest]) {
    const url = renderTemplate(provider, req, resume)
    if (url) candidates.push({ provider, url })
  }

  const chosen = candidates[0]
  return chosen ? { ...chosen, candidates } : null
}
