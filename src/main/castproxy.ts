/**
 * Serving a provider's stream to a television on the local network.
 *
 * The desktop twin of `CastProxyServer.java`, and deliberately the same design
 * rather than a second one — the reasoning behind it is identical on both
 * platforms and `docs/internal/casting.md` describes it once.
 *
 * The short version: a Chromecast fetches the media itself and the sender API
 * cannot attach headers to those requests, while most providers serve their
 * manifest and segments only to a request carrying the embed page's `Referer`.
 * So the app fetches upstream with the headers it captured, and the receiver
 * fetches from here.
 *
 * ## Two properties worth not losing
 *
 * **No route takes a URL.** Every URL is registered up front by `load` and
 * addressed by an opaque id. The obvious query-string design would turn this
 * machine into an open relay for everything else on the network for as long as
 * a cast runs, and that is not a property that can be restored afterwards.
 *
 * **It binds a wildcard address, unlike `localserver.ts`.** That server is on
 * 127.0.0.1 precisely so nothing off the machine can reach it; this one is
 * useless under that rule, because another device fetching from it is the whole
 * point. The mitigations are the registry above, ids that live only as long as
 * the cast, and `stop()` on every path that ends one.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'

/** Long enough for a slow provider, short enough not to wedge a connection. */
const UPSTREAM_TIMEOUT_MS = 20_000

/**
 * Headers that must never be replayed upstream.
 *
 * `Range` is the one that matters. It was captured from whatever byte the app's
 * own player happened to want, and replaying it on a manifest request returns a
 * slice of the playlist — which parses as a valid but truncated stream, so the
 * failure looks like a bug in the rewriter rather than a stray header.
 */
const NOT_REPLAYED = new Set(['range', 'host', 'connection', 'content-length', 'accept-encoding'])

export function replayableHeaders(captured: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(captured)) {
    if (!NOT_REPLAYED.has(name.toLowerCase())) out[name] = value
  }
  return out
}

/**
 * What to tell the receiver a response is.
 *
 * Providers are careless here: VidSrc serves its transport-stream segments as
 * `text/html`, measured 2026-09-13. mpv ignores the header and plays them; a
 * Cast receiver that sniffs it could decide the segment is a web page. So a
 * text/* answer on binary media is replaced — by what the URL implies where it
 * implies anything, and otherwise by `application/octet-stream`, which claims
 * nothing. A non-text answer is passed through: a provider that bothered to be
 * accurate should be believed.
 */
export function mediaContentType(upstreamType: string | undefined, url: string): string {
  if (!upstreamType) return 'application/octet-stream'
  if (!upstreamType.toLowerCase().startsWith('text/')) return upstreamType

  const path = url.toLowerCase().split('?')[0] ?? ''
  if (path.endsWith('.ts')) return 'video/mp2t'
  if (path.endsWith('.m4s') || path.endsWith('.mp4')) return 'video/mp4'
  if (path.endsWith('.aac')) return 'audio/aac'
  if (path.endsWith('.webm')) return 'video/webm'
  return 'application/octet-stream'
}

/** `/p3.m3u8` -> `p3`, `/s41` -> `s41`. The suffix is for the receiver's sniffing. */
export function idFromPath(rawPath: string): string {
  let path = rawPath.split('?')[0] ?? ''
  if (path.startsWith('/')) path = path.slice(1)
  if (path.endsWith('.m3u8')) path = path.slice(0, -'.m3u8'.length)
  return decodeURIComponent(path)
}

/**
 * The address a television can reach this machine at.
 *
 * Null when there is no non-loopback IPv4 address, which is the honest answer
 * on a machine with no network: casting is impossible and the caller must say
 * so rather than hand out an address that will simply time out.
 */
export function lanAddress(): string | null {
  const candidates: string[] = []
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      // IPv4 only: a Chromecast is reachable over v4 on every home network, and
      // a link-local v6 address needs a scope id the receiver cannot use.
      if (address.family === 'IPv4' && !address.internal) candidates.push(address.address)
    }
  }
  return pickLanAddress(candidates)
}

/**
 * Choose the address a television could actually reach.
 *
 * "First non-internal IPv4" is the obvious rule and it is wrong on any machine
 * running a VPN. This one has Tailscale, and its 100.x address sorts ahead of
 * the real one on some enumerations — handing that to a Chromecast produces a
 * URL that resolves nowhere and a cast that times out with no explanation.
 *
 * So a private LAN range wins, a carrier-grade NAT range (100.64/10, which is
 * what Tailscale uses) is taken only as a last resort, and anything else sits
 * in between. Exported because the ordering is worth testing and cannot be
 * tested through `networkInterfaces`.
 */
export function pickLanAddress(candidates: string[]): string | null {
  const rank = (address: string): number => {
    const [a = 0, b = 0] = address.split('.').map(Number)
    if (a === 192 && b === 168) return 0
    if (a === 10) return 0
    if (a === 172 && b >= 16 && b <= 31) return 0
    // 169.254/16 is link-local: an address the machine gave itself because DHCP
    // failed, so nothing else on the network is expecting it.
    if (a === 169 && b === 254) return 3
    // Tailscale and other CGNAT users. Reachable from another tailnet node, and
    // never from a television.
    if (a === 100 && b >= 64 && b <= 127) return 2
    return 1
  }

  const sorted = [...candidates].sort((x, y) => rank(x) - rank(y))
  return sorted[0] ?? null
}

export interface CastBundleForProxy {
  /** id -> rewritten playlist body, served from memory. */
  playlists: Record<string, string>
  /** id -> upstream URL. The only URLs this server will ever fetch. */
  targets: Record<string, string>
  /** Replayed upstream, already filtered by `replayableHeaders`. */
  headers: Record<string, string>
}

export interface CastProxy {
  /** Start listening and return the base URL a receiver should be given. */
  start(bundle: CastBundleForProxy): Promise<string>
  stop(): void
  isRunning(): boolean
}

export function createCastProxy(): CastProxy {
  let server: Server | null = null
  let playlists = new Map<string, string>()
  let targets = new Map<string, string>()
  let headers: Record<string, string> = {}

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const id = idFromPath(request.url ?? '/')

    const playlist = playlists.get(id)
    if (playlist !== undefined) {
      response.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Content-Length': Buffer.byteLength(playlist),
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      })
      response.end(request.method === 'HEAD' ? undefined : playlist)
      return
    }

    const upstream = targets.get(id)
    if (upstream === undefined) {
      response.writeHead(404, { 'Access-Control-Allow-Origin': '*' })
      response.end('unknown id')
      return
    }

    const forward = { ...headers }
    // The receiver's own range, never the captured one.
    if (typeof request.headers.range === 'string') forward.Range = request.headers.range
    // Refuse compression so the length we report is the length we send.
    forward['Accept-Encoding'] = 'identity'

    void fetch(upstream, { headers: forward, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
      .then(async (upstreamResponse) => {
        const body = Buffer.from(await upstreamResponse.arrayBuffer())
        const contentRange = upstreamResponse.headers.get('content-range')

        response.writeHead(upstreamResponse.status, {
          'Content-Type': mediaContentType(upstreamResponse.headers.get('content-type') ?? undefined, upstream),
          // Measured from what was actually read, so a chunked upstream still
          // produces a well-formed response. A receiver that insists on a
          // length would otherwise stall on every segment.
          'Content-Length': body.length,
          ...(contentRange ? { 'Content-Range': contentRange } : {}),
          'Access-Control-Allow-Origin': '*',
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        })
        response.end(request.method === 'HEAD' ? undefined : body)
      })
      .catch((error: unknown) => {
        if (response.headersSent) {
          response.destroy()
          return
        }
        response.writeHead(502, { 'Access-Control-Allow-Origin': '*' })
        response.end(error instanceof Error ? error.message : String(error))
      })
  }

  return {
    start(bundle): Promise<string> {
      playlists = new Map(Object.entries(bundle.playlists))
      targets = new Map(Object.entries(bundle.targets))
      headers = bundle.headers

      const address = lanAddress()
      if (address === null) {
        return Promise.reject(new Error('no local network address — casting needs a network'))
      }

      if (server) {
        const port = (server.address() as { port: number }).port
        return Promise.resolve(`http://${address}:${port}/`)
      }

      return new Promise((resolve, reject) => {
        const next = createServer(handle)
        next.on('error', reject)
        next.listen(0, '0.0.0.0', () => {
          server = next
          const port = (next.address() as { port: number }).port
          resolve(`http://${address}:${port}/`)
        })
      })
    },

    stop(): void {
      playlists.clear()
      targets.clear()
      headers = {}
      server?.close()
      server = null
    },

    isRunning(): boolean {
      return server !== null
    },
  }
}
