/**
 * Blocking the advertising on provider pages.
 *
 * The app had none. The player view denied pop-ups and rewrote request headers,
 * and that was the whole of it — no request was ever cancelled. In-page banners,
 * overlay ads and the scripts behind them all loaded, which is why blocking
 * looked provider-specific: it was never happening anywhere, and you only
 * notice on the embeds that are aggressive about it.
 *
 * This matters beyond annoyance. These pages carry malvertising, and they run
 * inside an Electron app rather than a hardened browser.
 *
 * ## The shape of the problem, and why this is not a filter list
 *
 * The obvious move is to ship EasyList. It is the wrong move here:
 *
 * - It is ~80k rules of a syntax this would have to implement a subset of, and
 *   a subset of a filter-list syntax silently mis-parses the rules it does not
 *   support rather than refusing them.
 * - It is tuned for the open web. These pages are a *chain of nested embeds
 *   across unrelated domains* — the video genuinely arrives from a host that
 *   looks exactly as third-party as an ad network does.
 *
 * So the rules here are few, boundary-aware, and every one of them is named.
 * A blocked request reports which rule blocked it, because the failure mode
 * that matters is not "an ad got through", it is "the video stopped working and
 * nobody knows which rule did it".
 *
 * ## The governing bias
 *
 * **Never break playback to win an ad.** A blocked ad is a small gain; a
 * blocked stream is the whole app. So the media itself, the page document and
 * anything the page needs to lay itself out are allowed unconditionally, and
 * the rules only reach things that cannot plausibly be the video.
 */

/** Electron's `resourceType`, plus the ones other Chromium surfaces report. */
export type ResourceType = string

export interface BlockContext {
  url: string
  resourceType: ResourceType
  /** The provider page's own origin, when known. */
  pageOrigin: string | null
}

export interface BlockDecision {
  blocked: boolean
  /** Which rule decided, for the log. Named even when allowing. */
  rule: string
}

const ALLOW = (rule: string): BlockDecision => ({ blocked: false, rule })
const BLOCK = (rule: string): BlockDecision => ({ blocked: true, rule })

/**
 * Resource types that are never blocked, whatever else matches.
 *
 * `media` is the video. `mainFrame` is the page itself — cancelling it does not
 * block an ad, it produces a blank player. Stylesheets and fonts cannot carry
 * an ad payload on their own and blocking them makes the embed render as
 * unstyled HTML, which reads as "broken" rather than "cleaned".
 */
const NEVER_BLOCK = new Set(['mainFrame', 'media', 'stylesheet', 'font'])

/**
 * Hosts whose entire purpose is advertising, tracking or pop-unders.
 *
 * Matched on the registrable-ish suffix, so `a.pop.example` matches
 * `pop.example`. Kept deliberately short and auditable: a long list copied from
 * somewhere is a list nobody here can defend, and the pattern rules below catch
 * the long tail that changes domain every week anyway.
 */
const AD_HOSTS = [
  // Pop-under and "direct link" networks, which is what these embeds monetise
  // with almost exclusively.
  'propellerads.com',
  'propellerclick.com',
  'propu.ch',
  'propellerpops.com',
  'onclickalgo.com',
  'onclicksuper.com',
  'onclickmax.com',
  'popads.net',
  'popcash.net',
  'poptm.com',
  'popunder.net',
  'adcash.com',
  'adsterra.com',
  'adsterranet.com',
  'hilltopads.net',
  'hilltopads.com',
  'clickadu.com',
  'exoclick.com',
  'exosrv.com',
  'juicyads.com',
  'trafficjunky.net',
  'trafficfactory.biz',
  'mgid.com',
  'adskeeper.com',
  'revcontent.com',
  'outbrain.com',
  'taboola.com',
  'bidgear.com',
  'bidvertiser.com',
  'monetag.com',
  'vlitag.com',
  'nitropay.com',
  'aniview.com',
  'smartadserver.com',
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adnxs.com',
  'rubiconproject.com',
  'pubmatic.com',
  'criteo.com',
  'casalemedia.com',
  'openx.net',
  'sharethrough.com',
  'teads.tv',

  // Analytics and session recorders. Not ads, but they profile the user on a
  // page the user did not choose to be profiled on.
  'google-analytics.com',
  'googletagmanager.com',
  'googletagservices.com',
  'scorecardresearch.com',
  'quantserve.com',
  'hotjar.com',
  'mixpanel.com',
  'segment.io',
  'amplitude.com',
  'fullstory.com',
  'clarity.ms',
  'histats.com',
  'statcounter.com',
  'yandex.ru',
  'mc.yandex.ru',
]

/**
 * Path segments that mean advertising, matched on **segment boundaries**.
 *
 * Substring matching is the trap here and it is not hypothetical: HLS delivery
 * is full of the word `adaptive`, and `/ad` as a substring matches it. Every
 * pattern below is compared against a whole `/`-delimited segment or a whole
 * dot-delimited filename part, never against the raw string.
 */
const AD_SEGMENTS = new Set([
  'ads',
  'ad',
  'adv',
  'advert',
  'adverts',
  'advertising',
  'advertisement',
  'adserver',
  'adservice',
  'adframe',
  'adhandler',
  'banner',
  'banners',
  'popunder',
  'popup',
  'pop-under',
  'interstitial',
  'prebid',
  'sponsor',
  'sponsors',
  'affiliate',
  'taboola',
  'outbrain',
])

/** Filenames that are an ad script whatever host they are served from. */
const AD_FILENAMES = [
  'ads.js',
  'ad.js',
  'adsbygoogle.js',
  'prebid.js',
  'popunder.js',
  'pop.js',
  'gpt.js',
  'analytics.js',
  'gtag.js',
]

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** Whether `host` is, or is a subdomain of, `suffix`. */
function matchesHost(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`)
}

/**
 * Whether two URLs share a registrable-looking base domain.
 *
 * Deliberately approximate — the last two labels — because the alternative is
 * shipping a public-suffix list for one comparison. Being wrong here is safe in
 * the direction that matters: `co.uk` style hosts collapse to `co.uk` and are
 * treated as *related*, which allows rather than blocks.
 */
function sameBaseDomain(a: string, b: string): boolean {
  const base = (host: string): string => host.split('.').slice(-2).join('.')
  return base(a) === base(b)
}

/**
 * Decide one request.
 *
 * Pure, so the rules can be tested without Electron, a network or a provider.
 */
export function decide(context: BlockContext): BlockDecision {
  const { url, resourceType, pageOrigin } = context

  if (url.startsWith('data:') || url.startsWith('blob:')) return ALLOW('inline')
  if (NEVER_BLOCK.has(resourceType)) return ALLOW(`never-block:${resourceType}`)

  const host = hostname(url)
  if (host === null) return ALLOW('unparseable')

  // A beacon exists only to report on the user. Nothing renders because of it.
  if (resourceType === 'ping') return BLOCK('ping')

  for (const suffix of AD_HOSTS) {
    if (matchesHost(host, suffix)) return BLOCK(`ad-host:${suffix}`)
  }

  let path: string
  try {
    path = new URL(url).pathname.toLowerCase()
  } catch {
    return ALLOW('unparseable-path')
  }

  const file = path.slice(path.lastIndexOf('/') + 1)
  for (const name of AD_FILENAMES) {
    if (file === name) return BLOCK(`ad-file:${name}`)
  }

  /**
   * Path segments, but only for requests that are not the page's own.
   *
   * The provider's own origin gets the benefit of the doubt: these sites proxy
   * their streams through paths this app has no business guessing about, and a
   * false positive there is a dead video rather than a surviving banner.
   */
  const pageHost = pageOrigin === null ? null : hostname(pageOrigin)
  const related = pageHost !== null && sameBaseDomain(host, pageHost)
  if (!related) {
    for (const segment of path.split('/')) {
      if (segment !== '' && AD_SEGMENTS.has(segment)) return BLOCK(`ad-path:${segment}`)
    }
  }

  return ALLOW('default')
}
