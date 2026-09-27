/**
 * Keep a provider's page where the app put it.
 *
 * Measured 2026-09-27 on the desktop (the 2.0.0 controls study, see
 * `docs/internal/own-controls-research.md`): about ten seconds after loading,
 * Videasy and VidZee replaced their own page with an advert site, with no
 * click. It happened in every load (5 of 5, 4 of 4), with the ad blocker off
 * and no debugger attached. The chains ran through throwaway `.cfd` domains
 * to tradedoubler and gambling sites. The player then showed black or the
 * advert, and a source test saw no stream: the page that would have played
 * was gone.
 *
 * Popups were already refused (`setWindowOpenHandler`). This covers the other
 * way out: the provider's document navigating itself. The rule is "stay on
 * the site you are on". A navigation of the provider's document to a web page
 * on a different site is cancelled. The same site, the site the source's own
 * URL names, the first load into an empty frame, and anything that is not a
 * web page all pass.
 *
 * Plain logic with no Electron in it, so the rule is tested
 * (`navguard.test.ts`). The event wiring lives in `playerview.ts` and
 * `streamprobe.ts`.
 */

/**
 * The part of a host name that says whose site it is: `player.videasy.to`
 * and `www.videasy.to` are both `videasy.to`.
 *
 * The last two labels, which is the registrable domain for every provider in
 * the catalogue (`.to`, `.net`, `.xyz`, `.ru`, `.club`, `.wtf`). Under a
 * two-level public suffix like `co.uk` it would call two strangers the same
 * site. That errs toward letting a navigation through, which is the safe
 * direction: a missed advert is today's behaviour, and a blocked provider
 * would be a new failure.
 */
function siteOf(host: string): string {
  // An IP address is its own site; its last two octets are not a domain.
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host
  return host.split('.').slice(-2).join('.')
}

function webHost(url: string | null): string | null {
  if (url === null) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : null
  } catch {
    return null
  }
}

/**
 * Should the provider document's navigation from `from` to `to` be stopped?
 *
 * `providerUrl` is the URL the app loaded for this source. It is allowed as
 * well as `from`, because a provider may have landed on a mirror by a server
 * redirect and still name the original in its own links.
 */
export function isForeignNavigation(from: string, to: string, providerUrl: string | null): boolean {
  const target = webHost(to)
  // about:blank, blob:, data:, javascript: and the like. None of the adverts
  // measured went that way, and a player may use them for itself.
  if (target === null) return false
  const current = webHost(from)
  // The frame's first load, from nothing. That navigation is the app's own.
  if (current === null) return false
  const site = siteOf(target)
  if (site === siteOf(current)) return false
  const provider = webHost(providerUrl)
  return provider === null || site !== siteOf(provider)
}
