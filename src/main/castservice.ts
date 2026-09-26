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
import type { CastOutcome } from '@shared/types'
import { isCastableFileType } from '@shared/castability'
import { buildCastBundle, isPlaylist, isWholeVideoFile } from './hlsrewrite'
import { createCastCapture, type Candidate, type CastCapture } from './castcapture'
import { createCastProxy, replayableHeaders } from './castproxy'
import { discover } from './castdiscovery'
import { CastSession, ReceiverRefusedError } from './castsender'

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

/** What the receiver should be told it is playing. */
export interface NowPlaying {
  title: string
  subtitle: string
  providerName: string
  startSeconds: number
  /** The title and source being cast, so what the cast learns is filed under them. Null when unknown. */
  titleKey: string | null
  providerId: string | null
}

/**
 * What a beam found out about the source, whether or not it succeeded.
 *
 * A cast is a better measurement than a test: it identified the stream by
 * fetching what the provider's player really fetched, and a television then
 * answered for it. `outcome` is set only where the answer is unambiguous —
 * see `beam`.
 */
export interface CastLearned {
  delivery: 'progressive' | 'segmented'
  outcome: CastOutcome | null
}

export interface BeamResult {
  ok: boolean
  error?: string
  /**
   * No stream has been identified yet — nothing fetched, or nothing fetched
   * that is a playlist or a whole video. Usually a source still on its poster,
   * waiting for its own play button.
   */
  waiting?: boolean
  /** Absent when no stream was identified: then there is nothing to learn. */
  learned?: CastLearned
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
  beam(now: NowPlaying): Promise<BeamResult>
  status(): Promise<CastStatus>
  control(action: 'play' | 'pause' | 'stop' | 'seek', seconds?: number): Promise<void>
  /**
   * The receiver's volume, 0–1, and its mute.
   *
   * Apart from `control` because they address different things on the wire —
   * transport is a media-session command, volume is a receiver command — and
   * because volume works with nothing playing while transport does not.
   */
  setVolume(level: number): Promise<void>
  setMuted(muted: boolean): Promise<void>
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
 * Find the best candidate something other than this app could play.
 *
 * **A whole progressive file is taken before a playlist.** That order was set
 * on 2026-09-13 in the belief that a plain Chromecast refuses HLS; measured
 * again on 2026-09-26 it plays both, as long as the playlist is served with
 * a CORS header, which the proxy always sends (see `shared/castability.ts`).
 * The order stands because a file is the shorter path — one upstream URL, no
 * rewriting — but which of the two gives the better picture is not measured,
 * and a whole file can be a decoy: VidLux's 297 MB "episode" for Silo was an
 * unrelated clip with a warning banner. Worth measuring before relying on it.
 *
 * **Pieces of a film are not the film.** A media fragment plays for six seconds
 * and an initialisation segment for none, and both are served as `video/mp4`
 * exactly like the real thing - see `isWholeVideoFile`. They are skipped rather
 * than reported as an error, because a later candidate is usually the real one.
 */
async function identifyStream(candidates: Candidate[]): Promise<Identified | null> {
  /** The first playlist seen, used only if no whole file turns up. */
  let playlist: Identified | null = null

  for (const candidate of candidates) {
    const headers = replayableHeaders(candidate.headers)

    let response: Awaited<ReturnType<typeof fetchText>>
    try {
      response = await fetchText(candidate.url, headers)
    } catch {
      continue // Unreachable, or a URL that has already expired.
    }

    if (response.status !== 200 && response.status !== 206) continue
    if (isPlaylist(response.body)) {
      playlist ??= { url: candidate.url, headers, kind: 'hls' }
      continue
    }

    // The same test a scan uses to record `progressive`, so "this source
    // casts" and "the cast sends this" cannot disagree.
    if (isCastableFileType(response.contentType) && isWholeVideoFile(response.body)) {
      return { url: candidate.url, headers, kind: 'progressive' }
    }
  }
  return playlist
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

    async beam(now): Promise<BeamResult> {
      if (!session) return { ok: false, error: 'Not connected to a TV.' }

      const candidates = capture.candidates()
      if (candidates.length === 0) {
        return { ok: false, error: 'Nothing to cast yet — start playing first, then try again.', waiting: true }
      }

      /** How the identified stream arrived, once there is one. */
      let delivery: CastLearned['delivery'] | null = null
      try {
        const stream = await identifyStream(candidates)
        if (stream === null) {
          return {
            ok: false,
            error: `${now.providerName} does not hand out a stream a TV can play. Try another source.`,
            waiting: true,
          }
        }

        delivery = stream.kind === 'progressive' ? 'progressive' : 'segmented'
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

        const settled = await session.load({
          // The `.m3u8` suffix is for the receiver, which sniffs the extension
          // before it reads the content type.
          url: stream.kind === 'hls' ? `${base}${bundle.rootId}.m3u8` : `${base}${bundle.rootId}`,
          contentType: stream.kind === 'hls' ? 'application/x-mpegurl' : 'video/mp4',
          title: now.title,
          subtitle: now.subtitle,
          startSeconds: now.startSeconds,
        })

        // Only a load the receiver actually started counts as a cast that
        // played; one still loading when the wait ran out proves nothing.
        return { ok: true, learned: { delivery, outcome: settled === 'started' ? 'played' : null } }
      } catch (error) {
        /*
         * A refusal counts against the source only if the television had
         * already fetched from us. The receiver answers LOAD_FAILED the same
         * way when it cannot reach this computer at all, and filing a Wi-Fi
         * problem as "this source cannot cast" would hide a source that can.
         * Read before `stop`, which resets the count.
         */
        const refused = error instanceof ReceiverRefusedError && proxy.served() > 0
        // The proxy must not outlive a failed attempt: it would sit on the
        // network serving a stream nothing is watching.
        proxy.stop()
        const message = error instanceof Error ? error.message : String(error)
        if (delivery === null) return { ok: false, error: message }
        return { ok: false, error: message, learned: { delivery, outcome: refused ? 'refused' : null } }
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
          volume: 0,
          muted: false,
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
        volume: playback.volume,
        muted: playback.muted,
      }
    },

    /**
     * Volume, which unlike transport needs no media session.
     *
     * A connected receiver can be turned down before anything has been beamed
     * to it, so these are deliberately not guarded on a running stream the way
     * `control` is.
     */
    async setVolume(level: number): Promise<void> {
      if (!session) return
      await session.setVolume(level)
    },

    async setMuted(muted: boolean): Promise<void> {
      if (!session) return
      await session.setVolume(NaN, muted)
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
