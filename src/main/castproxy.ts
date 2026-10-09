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

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { transportStreamOffset } from '@shared/downloads/transfer'

/**
 * Long enough for a slow provider, short enough not to wedge a connection:
 * how long the source may take to answer, and then how long its body may
 * go without a byte. Not a limit on the whole body: a whole film streams
 * for as long as the receiver reads it (see `handle`).
 */
const UPSTREAM_TIMEOUT_MS = 20_000

/**
 * The most of a body held to give the receiver a length when the source
 * gave none, as `CastProxyServer.java` does: a segment is a few megabytes,
 * and a receiver that insists on a length would stall on every chunked one.
 * Past this the rest streams on without a length; a whole film never fits.
 */
const BUFFERABLE_BYTES = 24 * 1024 * 1024

/**
 * How much of a segment is read before answering, to see whether it is a
 * transport stream disguised as an image (`disguisedStreamOffset`): the
 * search window `transportStreamOffset` uses, plus three packets to confirm.
 */
const DISGUISE_PEEK_BYTES = 4096 + 3 * 188

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

/**
 * Where a transport stream starts behind an image disguise, or 0 when there
 * is none.
 *
 * Some sources serve their segments as pictures: a PNG's opening bytes in
 * front of the transport stream, on an image CDN that would refuse to host
 * video (2Embed's, measured 2026-09-30). The source's own player skips the
 * prefix. A Cast receiver's does not, and the proxy used to pass the prefix
 * through with `image/png` as the type. Downloads strip it already
 * (`transportStreamOffset` in `shared/downloads/transfer.ts`), by the same
 * rule reused here: three sync bytes 188 apart.
 *
 * Only behind a PNG or JPEG signature, so the search never runs over a
 * fragmented-MP4 segment or anything else that merely contains three 0x47
 * bytes at the wrong distances. GIF is left alone: its signature starts
 * with the sync byte itself, and none has been seen.
 */
export function disguisedStreamOffset(head: Uint8Array): number {
  const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
  return png || jpeg ? transportStreamOffset(head) : 0
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
  /**
   * id -> absolute path of a file on this machine: a download's segments
   * (`shared/downloads/castbundle.ts`). The only files this server will read.
   */
  files?: Record<string, string>
}

/** What a download's file is, by its extension (names are the download's own). */
function fileContentType(path: string): string {
  if (path.endsWith('.ts')) return 'video/mp2t'
  if (path.endsWith('.m4s') || path.endsWith('.mp4')) return 'video/mp4'
  return 'application/octet-stream'
}

/** `bytes=a-b`, `bytes=a-`, within `size`; null when absent or unreadable (the whole file is sent). */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null
  if (!match || (match[1] === '' && match[2] === '')) return null
  if (match[1] === '') {
    const length = Math.min(Number(match[2]), size)
    return { start: size - length, end: size - 1 }
  }
  const start = Number(match[1])
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  return start <= end && start < size ? { start, end } : null
}

/** Serve one of a download's files, honouring a range: the receiver may ask for part of a segment. */
async function serveFile(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
  const size = (await stat(path)).size
  const range = byteRange(typeof request.headers.range === 'string' ? request.headers.range : undefined, size)
  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  response.writeHead(range ? 206 : 200, {
    'Content-Type': fileContentType(path),
    'Content-Length': end - start + 1,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  })
  if (request.method === 'HEAD' || size === 0) {
    response.end()
    return
  }
  createReadStream(path, { start, end }).on('error', () => response.destroy()).pipe(response)
}

export interface CastProxyOptions {
  /**
   * Listen on 127.0.0.1 and hand out that address: for the cast check
   * during a test (`castcheck.ts`), which fetches a stream through the
   * proxy's own path from this machine, and must never be reachable from
   * the network.
   */
  loopback?: boolean
}

export interface CastProxy {
  /** Start listening and return the base URL a receiver should be given. */
  start(bundle: CastBundleForProxy): Promise<string>
  stop(): void
  isRunning(): boolean
  /**
   * How many requests for this bundle the receiver has made since `start`.
   *
   * What tells a television that refused a stream it had looked at from one
   * that never reached this machine: only the first says anything about the
   * source. See `beam` in `castservice.ts`.
   */
  served(): number
  /**
   * Of those, how many the source's servers answered with an error status,
   * or did not answer: a segment, a key or a file the receiver asked for and
   * this machine could not get. What tells a source blocking the cast from a
   * television refusing the format (`castOutcomeOf`). Since `start`.
   */
  upstreamFailures(): number
}

/** Whether an upstream answer is one the receiver can use: a 2xx, ranges included. */
export function isUpstreamSuccess(status: number): boolean {
  return status >= 200 && status < 300
}

export function createCastProxy(options: CastProxyOptions = {}): CastProxy {
  let server: Server | null = null
  let playlists = new Map<string, string>()
  let targets = new Map<string, string>()
  let files = new Map<string, string>()
  let headers: Record<string, string> = {}
  let servedCount = 0
  let failedUpstream = 0
  /**
   * Which `start` the counts belong to. A fetch for the previous bundle can
   * still be in flight when the next beam starts, and its failure must not
   * make the new stream look blocked.
   */
  let generation = 0

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const id = idFromPath(request.url ?? '/')
    if (playlists.has(id) || targets.has(id) || files.has(id)) servedCount += 1

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

    const file = files.get(id)
    if (file !== undefined) {
      void serveFile(request, response, file).catch(() => {
        if (response.headersSent) return void response.destroy()
        response.writeHead(404, { 'Access-Control-Allow-Origin': '*' })
        response.end('gone')
      })
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

    const askedFor = generation
    const failed = (): void => {
      if (askedFor === generation) failedUpstream += 1
    }
    // An error status, or no answer at all: the source did not serve it.
    void relay(upstream, forward, request, response, (status) => {
      if (status === null || !isUpstreamSuccess(status)) failed()
    })
  }

  return {
    start(bundle): Promise<string> {
      playlists = new Map(Object.entries(bundle.playlists))
      targets = new Map(Object.entries(bundle.targets))
      files = new Map(Object.entries(bundle.files ?? {}))
      headers = bundle.headers
      servedCount = 0
      failedUpstream = 0
      generation += 1

      const address = options.loopback ? '127.0.0.1' : lanAddress()
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
        next.listen(0, options.loopback ? '127.0.0.1' : '0.0.0.0', () => {
          server = next
          const port = (next.address() as { port: number }).port
          resolve(`http://${address}:${port}/`)
        })
      })
    },

    stop(): void {
      playlists.clear()
      targets.clear()
      files.clear()
      headers = {}
      server?.close()
      server = null
    },

    isRunning(): boolean {
      return server !== null
    },

    served(): number {
      return servedCount
    },

    upstreamFailures(): number {
      return failedUpstream
    },
  }
}

/**
 * Fetch one upstream response and stream it to the receiver; the source's
 * status once answered, which the caller counts.
 *
 * Streamed, as `CastProxyServer.java` streams: until 2.0.19 this read each
 * whole body into memory under one 20-second timeout before answering, so a
 * whole film asked for with an open `Range: bytes=0-` was cut off at twenty
 * seconds and answered 502. Now the timeout covers the source's answer and
 * then each pause in its body, the receiver going away (a seek, a stop)
 * stops the fetch, and a slow receiver slows the fetch rather than filling
 * memory.
 *
 * What is still held: a body the source sent without a length, up to
 * `BUFFERABLE_BYTES`, so a segment reaches the receiver with one; and the
 * opening of a whole segment, to strip an image disguise
 * (`disguisedStreamOffset`), which also names it `video/mp2t`. Only a whole
 * answer (a 200 to no `Range`) is stripped: a range of a disguised segment
 * counts its bytes from the disguise, and moving them would make the
 * receiver's offsets lie.
 */
async function relay(
  upstream: string,
  forward: Record<string, string>,
  request: IncomingMessage,
  response: ServerResponse,
  /** The source's status as soon as it answers, or null when it did not answer at all. */
  answered: (status: number | null) => void,
): Promise<void> {
  const abort = new AbortController()
  let idle = setTimeout(() => abort.abort(new Error('the source took too long to answer')), UPSTREAM_TIMEOUT_MS)
  const stillReading = (): void => {
    clearTimeout(idle)
    idle = setTimeout(() => abort.abort(new Error('the source stopped sending')), UPSTREAM_TIMEOUT_MS)
  }
  // The receiver hung up before the answer was through: a seek or a stop.
  // Nothing more is wanted from the source, and what stops is not its fault.
  let receiverGone = false
  response.on('close', () => {
    receiverGone = !response.writableFinished
    abort.abort()
  })

  let status: number | null = null
  try {
    const answer = await fetch(upstream, { headers: forward, signal: abort.signal })
    status = answer.status
    answered(status)
    stillReading()
    const reader = request.method === 'HEAD' ? null : (answer.body?.getReader() ?? null)
    if (reader === null) await answer.body?.cancel().catch(() => {})

    // The source's own length, unless the body was decoded on the way in.
    const encoded = (answer.headers.get('content-encoding') ?? 'identity') !== 'identity'
    const declared = Number(answer.headers.get('content-length'))
    let length: number | null = !encoded && answer.headers.has('content-length') && Number.isFinite(declared) ? declared : null

    // Read ahead: the opening of a whole segment, or a body with no length up to the cap.
    const wholeAnswer = answer.status === 200 && typeof request.headers.range !== 'string'
    const readAhead = length === null ? BUFFERABLE_BYTES + 1 : wholeAnswer ? DISGUISE_PEEK_BYTES : 0
    const held: Uint8Array[] = []
    let heldBytes = 0
    let finished = reader === null
    while (reader !== null && heldBytes < readAhead) {
      const { done, value } = await reader.read()
      stillReading()
      if (done) {
        finished = true
        break
      }
      held.push(value)
      heldBytes += value.byteLength
    }
    let opening = Buffer.concat(held)
    if (finished) length = opening.byteLength

    const offset = wholeAnswer ? disguisedStreamOffset(opening) : 0
    if (offset > 0) {
      opening = opening.subarray(offset)
      if (length !== null) length -= offset
    }
    const contentRange = answer.headers.get('content-range')
    response.writeHead(answer.status, {
      'Content-Type': offset > 0 ? 'video/mp2t' : mediaContentType(answer.headers.get('content-type') ?? undefined, upstream),
      ...(length !== null ? { 'Content-Length': length } : {}),
      ...(contentRange ? { 'Content-Range': contentRange } : {}),
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    })
    if (reader === null) {
      response.end()
      return
    }
    if (opening.byteLength > 0 && !response.write(opening)) await drained(response)
    while (!finished && !receiverGone) {
      const { done, value } = await reader.read()
      stillReading()
      if (done) break
      // Backpressure: a receiver reading slowly slows the fetch, rather than the film piling up here.
      if (!response.write(value)) await drained(response)
    }
    response.end()
  } catch (error) {
    if (receiverGone) return
    if (response.headersSent) {
      // Cut off mid-body: the receiver sees the connection close short of the length.
      response.destroy()
      return
    }
    // Unreachable, timed out, or cut off before the receiver got a byte: the
    // source did not serve it. An error status was counted when it came.
    if (status === null || isUpstreamSuccess(status)) answered(null)
    response.writeHead(502, { 'Access-Control-Allow-Origin': '*' })
    response.end(error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(idle)
  }
}

/** Until the response can take more, or the receiver has gone. */
function drained(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      response.off('drain', done)
      response.off('close', done)
      resolve()
    }
    response.on('drain', done)
    response.on('close', done)
  })
}
