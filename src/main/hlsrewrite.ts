/**
 * Rewriting an HLS playlist so something other than the app can fetch it.
 *
 * ## Why this is needed at all
 *
 * Casting hands a URL to a device on the network and that device does the
 * fetching. Our streams do not survive that. `streamextract.ts` classifies
 * every provider it measures, and the common verdict is `header-gated`: the
 * manifest and its segments are served only to a request carrying the embed
 * page's `Referer` and `Origin`. A Chromecast sends neither, and the Cast
 * sender API has no way to attach them — the receiver fetches the media itself,
 * and the sender only ever passes it a URL.
 *
 * The way out is to put a proxy on the phone: the receiver fetches from us over
 * the LAN, and we fetch upstream with the headers the provider wants. But a
 * proxy alone is not enough, and the reason is this module's whole job.
 *
 * **A playlist is a list of more URLs.** If the receiver is handed a proxied
 * master playlist whose body still names the provider's own hosts, it will go
 * and fetch those segments *directly* — with no `Referer` — and the proxy is
 * bypassed on every request that actually carries video. The stream fails
 * several seconds in, after the manifest loaded cleanly, which reads as a
 * broken player rather than a missing header.
 *
 * So every URI inside the playlist has to be rewritten to point back at the
 * proxy, at the same time as the playlist itself is proxied.
 *
 * ## Why the parsing lives here and not in the proxy
 *
 * The proxy is native Android code — it has to be, a WebView cannot listen on a
 * socket. Nothing in Kotlin here is covered by this project's four gates or by
 * vitest, and playlist parsing is exactly the kind of work that fails on the
 * one provider whose file has a quirk nobody thought of.
 *
 * Keeping it in `src/main` means the defect-prone half is a pure function over
 * a string, tested against real playlist shapes, and the native half is reduced
 * to a byte pump that never inspects what it moves.
 *
 * ## What is deliberately not handled
 *
 * Live playlists. Every one of these is a film or an episode, so a playlist is
 * fetched once and does not change; `buildCastBundle` resolves the whole tree
 * up front rather than rewriting on each request. A live stream would need the
 * proxy to re-rewrite on every poll, which is a different design and has no
 * caller here.
 */

/** What a URI inside a playlist turns out to be. */
export type UriKind =
  /** Another playlist — a variant stream, or a rendition. Needs rewriting too. */
  | 'playlist'
  /** Media or key material. Proxied verbatim, never parsed. */
  | 'data'

/**
 * Hands back the proxy URL to use in place of `absoluteUrl`.
 *
 * Injected rather than built in so the rewriter stays pure: the tests can hand
 * it an identity-ish function and assert on the shape of the output, and the
 * caller decides what a proxy URL looks like.
 */
export type Allocate = (absoluteUrl: string, kind: UriKind) => string

/**
 * Tags whose `URI=` attribute names another *playlist* rather than media.
 *
 * The distinction matters because a playlist has to be fetched and rewritten in
 * turn, and media must not be — parsing a transport stream as text would be
 * both wrong and enormous.
 */
const PLAYLIST_URI_TAGS = ['#EXT-X-MEDIA:', '#EXT-X-I-FRAME-STREAM-INF:']

/**
 * Tags whose `URI=` attribute names data we only ever pass through.
 *
 * `EXT-X-KEY` is the decryption key and `EXT-X-MAP` is the initialisation
 * segment for fragmented MP4. Both are small, both are fetched by the receiver,
 * and both are gated by the same headers as the segments — a stream whose key
 * request 403s plays as a few seconds of noise and then stops.
 */
const DATA_URI_TAGS = ['#EXT-X-KEY:', '#EXT-X-MAP:', '#EXT-X-PART:', '#EXT-X-PRELOAD-HINT:']

/** Does this playlist point at other playlists rather than at segments? */
export function isMasterPlaylist(body: string): boolean {
  return /^#EXT-X-STREAM-INF:/m.test(body)
}

/** Is this text an HLS playlist at all? */
export function isPlaylist(body: string): boolean {
  return body.trimStart().startsWith('#EXTM3U')
}

/**
 * Resolve a playlist reference against the playlist's own URL.
 *
 * Returns null for anything that will not resolve, which the caller leaves
 * untouched rather than replacing with a broken proxy URL — a playlist we
 * cannot fully rewrite should still play for the parts we can.
 */
function resolve(reference: string, base: string): string | null {
  try {
    return new URL(reference, base).toString()
  } catch {
    return null
  }
}

/**
 * Rewrite the `URI="..."` attribute of a tag line, leaving everything else
 * byte-identical.
 *
 * Attribute-list order is not significant in HLS but players are not uniformly
 * tolerant of being handed a re-serialised tag, so this is a surgical
 * replacement of one quoted value rather than a parse-and-emit.
 */
function rewriteUriAttribute(line: string, base: string, kind: UriKind, allocate: Allocate): string {
  return line.replace(/URI="([^"]*)"/g, (whole, reference: string) => {
    if (!reference) return whole
    const absolute = resolve(reference, base)
    if (absolute === null) return whole
    return `URI="${allocate(absolute, kind)}"`
  })
}

/**
 * Rewrite every URI in one playlist to point at the proxy.
 *
 * `playlistUrl` is where this body was fetched from, and it is what relative
 * references resolve against — getting it wrong is silent, because the result
 * is still a well-formed playlist, just one pointing at URLs that 404.
 */
export function rewritePlaylist(body: string, playlistUrl: string, allocate: Allocate): string {
  // Split on \n and keep any \r as part of the line, so CRLF playlists come out
  // CRLF. A player that tolerates one and not the other is rare, but rewriting
  // line endings is a change this function has no reason to make.
  const lines = body.split('\n')

  /**
   * Set by `#EXT-X-STREAM-INF`, consumed by the URI line that must follow it.
   *
   * This is the one place HLS is stateful: a variant stream's URI is on its own
   * line *after* the tag describing it, and is otherwise indistinguishable from
   * a segment.
   */
  let nextUriIsPlaylist = false

  return lines
    .map((rawLine) => {
      const carriageReturn = rawLine.endsWith('\r')
      const line = carriageReturn ? rawLine.slice(0, -1) : rawLine
      const restore = (value: string): string => (carriageReturn ? `${value}\r` : value)

      if (line.trim() === '') return rawLine

      if (line.startsWith('#')) {
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
          nextUriIsPlaylist = true
          return rawLine
        }
        for (const tag of PLAYLIST_URI_TAGS) {
          if (line.startsWith(tag)) {
            return restore(rewriteUriAttribute(line, playlistUrl, 'playlist', allocate))
          }
        }
        for (const tag of DATA_URI_TAGS) {
          if (line.startsWith(tag)) {
            return restore(rewriteUriAttribute(line, playlistUrl, 'data', allocate))
          }
        }
        return rawLine
      }

      // A bare line: a segment, or the variant playlist announced above.
      const kind: UriKind = nextUriIsPlaylist ? 'playlist' : 'data'
      nextUriIsPlaylist = false

      const absolute = resolve(line.trim(), playlistUrl)
      if (absolute === null) return rawLine
      return restore(allocate(absolute, kind))
    })
    .join('\n')
}

/* ── Assembling a castable bundle ───────────────────────────────────────── */

/** One thing the proxy will fetch upstream on the receiver's behalf. */
export interface ProxyTarget {
  /** Opaque id the receiver asks for. Never the upstream URL — see below. */
  id: string
  url: string
}

/** A playlist the proxy serves from memory, already rewritten. */
export interface ProxyPlaylist {
  id: string
  body: string
}

export interface CastBundle {
  /** The id the Cast receiver should be pointed at. */
  rootId: string
  playlists: ProxyPlaylist[]
  targets: ProxyTarget[]
}

/**
 * Fetch a playlist's text. Injected so the bundle builder is testable without
 * a network, and because on the device this has to go through native code to
 * carry the provider's headers.
 */
export type FetchText = (url: string) => Promise<string>

/**
 * How deep to follow playlists pointing at playlists.
 *
 * Two is enough for every shape HLS actually uses — master to variant, and a
 * variant's audio rendition — and a bound is what keeps a provider that serves
 * a self-referential playlist from hanging the cast instead of failing it.
 */
const MAX_PLAYLIST_DEPTH = 3

/**
 * Resolve a stream into something a Cast receiver can be handed.
 *
 * ## Why ids rather than a URL parameter
 *
 * The obvious proxy takes the upstream URL in the query string. That turns the
 * phone into an **open relay for anything on the LAN** for as long as a cast is
 * running: any device could ask it to fetch any URL, with the phone's IP and
 * whatever headers were configured. Enumerating every URL up front and handing
 * out opaque ids means the proxy can only ever fetch things this function
 * already decided to fetch, which is a property the query-string design cannot
 * have.
 *
 * ## Why the whole tree is resolved now
 *
 * The receiver fetches playlists itself, so a variant playlist that is proxied
 * verbatim would carry the provider's own segment URLs and be fetched without
 * headers — see this module's header comment. Rewriting has to happen before
 * the receiver ever sees a playlist, and that means fetching them here.
 *
 * A progressive MP4 needs none of this and takes the early return: one target,
 * no playlists, nothing parsed.
 *
 * ## Why the rewritten URIs are relative
 *
 * `allocate` emits bare ids — `p1.m3u8`, `s7` — not absolute URLs. The receiver
 * resolves them against the playlist it is reading, which is already a proxy
 * URL, so they land back on the proxy without this function ever being told the
 * phone's address. That matters: the LAN address is not known until the proxy
 * binds, and it can change under a running cast when the phone roams.
 */
export async function buildCastBundle(
  streamUrl: string,
  kind: 'hls' | 'dash' | 'progressive',
  fetchText: FetchText,
): Promise<CastBundle> {
  const playlists: ProxyPlaylist[] = []
  const targets: ProxyTarget[] = []

  /** url -> id, so a segment referenced twice is registered once. */
  const assigned = new Map<string, string>()
  let counter = 0

  const idFor = (url: string, prefix: string): string => {
    const existing = assigned.get(url)
    if (existing !== undefined) return existing
    const id = `${prefix}${counter++}`
    assigned.set(url, id)
    return id
  }

  /**
   * DASH and progressive are handed over whole. DASH manifests have the same
   * nested-URL problem as HLS and would need their own rewriter; no provider
   * measured so far serves DASH in a form that plays outside its page at all
   * (`CinemaOS` is `sealed`), so building one now would be speculative.
   */
  if (kind !== 'hls') {
    const id = idFor(streamUrl, 's')
    targets.push({ id, url: streamUrl })
    return { rootId: id, playlists: [], targets }
  }

  /** Playlists still to fetch, with the depth at which they were found. */
  const pending: Array<{ id: string; url: string; depth: number }> = []
  const rootId = idFor(streamUrl, 'p')
  pending.push({ id: rootId, url: streamUrl, depth: 0 })

  while (pending.length > 0) {
    const next = pending.shift()
    if (!next) break

    const body = await fetchText(next.url)

    const rewritten = rewritePlaylist(body, next.url, (absolute, uriKind) => {
      if (uriKind === 'playlist' && next.depth < MAX_PLAYLIST_DEPTH) {
        const known = assigned.get(absolute)
        const id = idFor(absolute, 'p')
        // Only queue it the first time; a rendition shared between variants is
        // otherwise fetched once per reference.
        if (known === undefined) pending.push({ id, url: absolute, depth: next.depth + 1 })
        return `${id}.m3u8`
      }
      return idFor(absolute, 's')
    })

    playlists.push({ id: next.id, body: rewritten })
  }

  // Everything that was not resolved into a playlist is a thing to fetch.
  for (const [url, id] of assigned) {
    if (id.startsWith('s')) targets.push({ id, url })
  }

  return { rootId, playlists, targets }
}
