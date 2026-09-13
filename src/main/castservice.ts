/**
 * Casting, assembled — the desktop's answer to `mobile/src/bridge/cast.ts`.
 *
 * The pieces exist separately because each is worth testing on its own:
 * `castcapture` watches the network, `hlsrewrite` rewrites the playlist,
 * `castproxy` serves it, `castdiscovery` finds televisions and `castsender`
 * talks to one. This is the order they go in, and the errors a user can act on.
 *
 * ## What is different from the phone, and what is not
 *
 * Not different: the whole content path. A Chromecast fetches media itself and
 * the sender protocol has nowhere to put a header, while most providers serve
 * only to a request carrying their embed page's `Referer` — so the playlist is
 * rewritten to route through a proxy on this machine either way.
 *
 * Different: everything about *getting to* a Chromecast. Android has Play
 * Services; Electron has a TLS socket and a UDP multicast query, both written
 * out by hand here. See `castsender.ts` for why that was the better trade.
 *
 * ## Errors are sentences
 *
 * Every step fails for a reason the user can do something about — no network,
 * a provider that will not give up its stream, a television that went away,
 * a router that keeps the two apart. A boolean would make them all look like
 * the same shrug, so each resolves with words.
 */

import type { Session } from 'electron'
import type { CastDevice, CastStatus } from '@shared/ipc'
import { buildCastBundle, isPlaylist } from './hlsrewrite'
import { createCastCapture, type Candidate, type CastCapture } from './castcapture'
import { createCastProxy, replayableHeaders } from './castproxy'
import { discover } from './castdiscovery'
import { CastSession } from './castsender'

/**
 * How much of a candidate to read while deciding what it is.
 *
 * A playlist announces itself in its first seven bytes, so this only has to
 * hold a whole one for the case where the candidate *is* the manifest — a
 * feature-length VOD playlist runs to a few hundred kilobytes. Anything bigger
 * is not being parsed anyway, and reading a video file into a string would take
 * the process out.
 */
const SNIFF_LIMIT_BYTES = 2 * 1024 * 1024

const FETCH_TIMEOUT_MS = 15_000

const PROGRESSIVE_TYPES = ['video/mp4', 'video/webm']

/** What the receiver should be told it is playing. */
export interface NowPlaying {
  title: string
  subtitle: string
  providerName: string
  startSeconds: number
}

export interface CastService {
  /** Watch a player session for media requests. */
  watch(session: Session): void
  /** Drop captures, on every provider, episode or title change. */
  forget(): void

  startDiscovery(): Promise<void>
  stopDiscovery(): Promise<void>
  devices(): Promise<CastDevice[]>
  connect(deviceId: string): Promise<{ ok: boolean; error?: string }>
  disconnect(): Promise<void>
  beam(now: NowPlaying): Promise<{ ok: boolean; error?: string }>
  status(): Promise<CastStatus>
  control(action: 'play' | 'pause' | 'stop' | 'seek', seconds?: number): Promise<void>
  /** Called when a session ends on its own, so the caller can put the picture back. */
  onSessionEnded(callback: () => void): void
}

/** Read a URL with headers a browser would refuse to set. */
async function fetchText(url: string, headers: Record<string, string>): Promise<{ status: number; contentType: string; body: string }> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  const buffer = Buffer.from(await response.arrayBuffer())
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body: buffer.subarray(0, SNIFF_LIMIT_BYTES).toString('utf8'),
  }
}

interface Identified {
  url: string
  headers: Record<string, string>
  kind: 'hls' | 'progressive'
}

/**
 * Find the first candidate something other than this app could play.
 *
 * Newest first, because the newest media request belongs to what is on screen
 * now. That ordering plus `forget()` on every source change is the whole
 * defence against casting the previous title.
 */
async function identifyStream(candidates: Candidate[]): Promise<Identified | null> {
  for (const candidate of candidates) {
    const headers = replayableHeaders(candidate.headers)

    let response: Awaited<ReturnType<typeof fetchText>>
    try {
      response = await fetchText(candidate.url, headers)
    } catch {
      continue // Unreachable, or a URL that has already expired.
    }

    if (response.status !== 200 && response.status !== 206) continue
    if (isPlaylist(response.body)) return { url: candidate.url, headers, kind: 'hls' }

    const type = response.contentType.toLowerCase()
    if (PROGRESSIVE_TYPES.some((known) => type.startsWith(known))) {
      return { url: candidate.url, headers, kind: 'progressive' }
    }
  }
  return null
}

export function createCastService(): CastService {
  const capture: CastCapture = createCastCapture()
  const proxy = createCastProxy()

  let known: CastDevice[] = []
  /** Address and port per device, kept so `connect` needs no second discovery. */
  const routes = new Map<string, { address: string; port: number; name: string }>()

  let session: CastSession | null = null
  let sessionEnded: (() => void) | null = null

  const endSession = (): void => {
    session?.close()
    session = null
    proxy.stop()
  }

  const refresh = async (): Promise<void> => {
    const found = await discover(3000)
    for (const device of found) routes.set(device.id, { address: device.address, port: device.port, name: device.name })
    known = found.map((device) => ({
      id: device.id,
      name: device.name,
      selected: session !== null && session.deviceName === device.name,
    }))
  }

  return {
    watch: (electronSession) => capture.watch(electronSession),
    forget: () => capture.clear(),

    /**
     * Discovery is a one-shot query rather than a subscription.
     *
     * mDNS has no "list" — a responder answers a question — so "start
     * discovery" means "ask now" and `devices()` reads what came back. The
     * picker calls both, which keeps the UI identical to the phone's even
     * though Play Services really does maintain a live list there.
     */
    startDiscovery: () => refresh(),
    stopDiscovery: () => Promise.resolve(),
    devices: async () => known,

    async connect(deviceId): Promise<{ ok: boolean; error?: string }> {
      const route = routes.get(deviceId)
      if (!route) return { ok: false, error: 'That TV is no longer on the network.' }

      endSession()
      const next = new CastSession(route.address, route.port, route.name)
      next.onDisconnect(() => {
        // Only react if this is still the session we care about; a reconnect
        // would otherwise tear down its own successor.
        if (session !== next) return
        session = null
        proxy.stop()
        sessionEnded?.()
      })

      try {
        await next.connect()
        session = next
        return { ok: true }
      } catch (error) {
        next.close()
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },

    async disconnect(): Promise<void> {
      endSession()
    },

    async beam(now): Promise<{ ok: boolean; error?: string }> {
      if (!session) return { ok: false, error: 'Not connected to a TV.' }

      const candidates = capture.candidates()
      if (candidates.length === 0) {
        return { ok: false, error: 'Nothing to cast yet — start playing first, then try again.' }
      }

      try {
        const stream = await identifyStream(candidates)
        if (stream === null) {
          return {
            ok: false,
            error: `${now.providerName} does not hand out a stream a TV can play. Try another source.`,
          }
        }

        const bundle = await buildCastBundle(stream.url, stream.kind, async (url) => {
          const response = await fetchText(url, stream.headers)
          if (response.status !== 200 && response.status !== 206) {
            throw new Error(`the source answered ${response.status}`)
          }
          return response.body
        })

        const base = await proxy.start({
          playlists: Object.fromEntries(bundle.playlists.map((p) => [p.id, p.body])),
          targets: Object.fromEntries(bundle.targets.map((t) => [t.id, t.url])),
          headers: stream.headers,
        })

        await session.load({
          // The `.m3u8` suffix is for the receiver, which sniffs the extension
          // before it reads the content type.
          url: stream.kind === 'hls' ? `${base}${bundle.rootId}.m3u8` : `${base}${bundle.rootId}`,
          contentType: stream.kind === 'hls' ? 'application/x-mpegurl' : 'video/mp4',
          title: now.title,
          subtitle: now.subtitle,
          startSeconds: now.startSeconds,
        })

        return { ok: true }
      } catch (error) {
        // The proxy must not outlive a failed attempt: it would sit on the
        // network serving a stream nothing is watching.
        proxy.stop()
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },

    async status(): Promise<CastStatus> {
      if (!session) {
        return {
          available: true,
          connected: false,
          deviceName: '',
          playing: false,
          seconds: 0,
          duration: 0,
          proxyRunning: proxy.isRunning(),
        }
      }
      const playback = await session.status()
      return {
        available: true,
        connected: playback.connected,
        deviceName: session.deviceName,
        playing: playback.playing,
        seconds: playback.seconds,
        duration: playback.duration,
        proxyRunning: proxy.isRunning(),
      }
    },

    async control(action, seconds = 0): Promise<void> {
      if (!session) return
      await session.control(action, seconds)
    },

    onSessionEnded(callback): void {
      sessionEnded = callback
    },
  }
}
