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
import { blockedCastMessage, castOutcomeOf, type CastLearned } from '@shared/castanswer'
import type { StreamSignature } from '@shared/streamsignature'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildCastBundle, unguessableId } from './hlsrewrite'
import { downloadCastBundle } from '@shared/downloads/castbundle'
import { PLAYLIST_FILE } from '@shared/downloads/plan'
import { createCastCapture, type Candidate, type CastCapture } from './castcapture'
import { createCastProxy, replayableHeaders } from './castproxy'
import { discover } from './castdiscovery'
import { CastSession, ReceiverRefusedError } from './castsender'
import { chooseCastRoot, PLAYLIST_BYTES, rootRefusal, rootSignature } from './castroot'
import { desktopRootFetch } from './castfetch'

/** For a receiver that refused a stream it never fetched: see `castOutcomeOf`. */
const UNREACHED_MESSAGE =
  'The TV never fetched the stream from this computer. Check that both are on the same Wi-Fi and that client isolation is off.'

/** What the receiver should be told it is playing. */
export interface NowPlaying {
  title: string
  subtitle: string
  providerName: string
  startSeconds: number
  /** The title and source being cast, so what the cast learns is filed under them. Null when unknown. */
  titleKey: string | null
  providerId: string | null
  /** The episode being cast, null for a film: a cast's result is filed under it. */
  episode: { season: number; episode: number } | null
  /**
   * TMDB's runtime for what is being cast, in minutes, or null: the stream
   * chosen must run about as long (`castroot.ts`), or it is an advert or a
   * decoy.
   */
  runtimeMinutes?: number | null
  /**
   * The download's folder when the player is on a download: then the files
   * are served from it, and nothing is captured. Null for a source.
   */
  downloadDir?: string | null
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
  /**
   * A stream was identified and the attempt failed past that point, so
   * asking again would only repeat it (`final` in the IPC contract).
   */
  final?: boolean
  /**
   * What the television said, with how the stream arrived: filed against the
   * source (`castResults`). Absent unless the receiver played or refused the
   * stream — see `castOutcomeOf`.
   */
  learned?: CastLearned
}

export interface CastService {
  /** Watch a player session for media requests. */
  watch(session: Session): void
  /** Drop captures, on every provider, episode or title change. */
  forget(): void
  /** What the player's page fetched since the last `forget`, newest first (the preview cache reads it too). */
  candidates(): Candidate[]

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

export function createCastService(): CastService {
  const capture: CastCapture = createCastCapture()
  const proxy = createCastProxy()

  let known: CastDevice[] = []
  /** Address and port per device, kept so `connect` needs no second discovery. */
  const routes = new Map<string, { address: string; port: number; name: string; model: string | null }>()

  let session: CastSession | null = null
  /** The connected television's model (mDNS `md`), filed with what it says about a stream. */
  let sessionModel: string | null = null
  let sessionEnded: (() => void) | null = null

  const endSession = (): void => {
    session?.close()
    session = null
    proxy.stop()
  }

  /**
   * Cast a download: its playlist with every file named by an id, the files
   * served from its folder (`shared/downloads/castbundle.ts`). Nothing is
   * learned about any source, since none is involved.
   */
  const beamDownload = async (live: CastSession, now: NowPlaying, dir: string): Promise<BeamResult> => {
    try {
      const playlist = await readFile(join(dir, PLAYLIST_FILE), 'utf8')
      const bundle = downloadCastBundle(playlist, unguessableId)
      if (bundle === null) return { ok: false, error: 'This download is damaged; download it again.' }
      const base = await proxy.start({
        playlists: bundle.playlists,
        targets: {},
        headers: {},
        files: Object.fromEntries(Object.entries(bundle.files).map(([id, name]) => [id, join(dir, name)])),
      })
      await live.load({
        url: `${base}${bundle.rootId}.m3u8`,
        contentType: 'application/x-mpegurl',
        title: now.title,
        subtitle: now.subtitle,
        startSeconds: now.startSeconds,
      })
      return { ok: true }
    } catch (error) {
      proxy.stop()
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const refresh = async (): Promise<void> => {
    const found = await discover(3000)
    for (const device of found) {
      routes.set(device.id, { address: device.address, port: device.port, name: device.name, model: device.model ?? null })
    }
    known = found.map((device) => ({
      id: device.id,
      name: device.name,
      selected: session !== null && session.deviceName === device.name,
      ...(device.model === undefined ? {} : { model: device.model }),
      ...(device.capabilities === undefined ? {} : { capabilities: device.capabilities }),
    }))
  }

  return {
    watch: (electronSession) => capture.watch(electronSession),
    forget: () => capture.clear(),
    candidates: () => capture.candidates(),

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
        sessionModel = route.model
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
      if (now.downloadDir) return beamDownload(session, now, now.downloadDir)

      const candidates = capture.candidates()
      if (candidates.length === 0) {
        return { ok: false, error: 'Nothing to cast yet — start playing first, then try again.', waiting: true }
      }

      /** How the identified stream arrived, once there is one. */
      let delivery: CastLearned['delivery'] | null = null
      /** What the stream holds, read beside the load; see `learnedOf`. */
      let signature: Promise<StreamSignature | null> = Promise.resolve(null)
      const receiver = sessionModel
      const learnedOf = async (outcome: CastLearned['outcome']): Promise<CastLearned> => ({
        delivery: delivery!,
        outcome,
        receiver,
        signature: await signature,
      })
      try {
        // Each candidate asked about with its own headers; the root then
        // served with its headers alone, as the proxy replays one set.
        const runtime = now.runtimeMinutes ?? null
        const choice = await chooseCastRoot(
          candidates.map((c) => ({ url: c.url, headers: replayableHeaders(c.headers) })),
          desktopRootFetch,
          runtime,
        )
        const root = choice.root
        if (root === null) {
          return {
            ok: false,
            error:
              rootRefusal(choice.passedOver, now.providerName, runtime) ??
              `${now.providerName} does not hand out a stream a TV can play. Try another source.`,
            waiting: true,
          }
        }

        delivery = root.kind === 'progressive' ? 'progressive' : 'segmented'
        const bundle = await buildCastBundle(root.url, root.kind, async (url) => {
          // The playlists the choice read a moment ago; the rest with the root's headers.
          const known = choice.bodies.get(url)
          if (known !== undefined) return known
          const response = await desktopRootFetch.text(url, root.headers, PLAYLIST_BYTES)
          if (response === null) throw new Error('the source did not answer')
          if (response.status !== 200 && response.status !== 206) {
            throw new Error(`the source answered ${response.status}`)
          }
          return response.body
        })

        const base = await proxy.start({
          playlists: Object.fromEntries(bundle.playlists.map((p) => [p.id, p.body])),
          targets: Object.fromEntries(bundle.targets.map((t) => [t.id, t.url])),
          headers: root.headers,
        })

        // Read while the receiver loads, so the answer is filed under what
        // it was handed and the beam waits no longer for it.
        signature = rootSignature(root, desktopRootFetch).catch(() => null)
        const answer = await session.load({
          // The `.m3u8` suffix is for the receiver, which sniffs the extension
          // before it reads the content type.
          url: root.kind === 'hls' ? `${base}${bundle.rootId}.m3u8` : `${base}${bundle.rootId}`,
          contentType: root.kind === 'hls' ? 'application/x-mpegurl' : 'video/mp4',
          title: now.title,
          subtitle: now.subtitle,
          startSeconds: now.startSeconds,
          fmp4: root.kind === 'hls' && root.media.init !== null,
        })

        // A load still loading or buffering when the wait ran out goes ahead,
        // as it always has, and proves nothing either way: nothing is filed.
        if (answer === 'unsettled') return { ok: true }
        return { ok: true, learned: await learnedOf('played') }
      } catch (error) {
        // Only a refusal is an answer; anything else failed before there was
        // one. Read before `stop`: what the proxy saw decides what it says.
        const counts = { served: proxy.served(), upstreamFailures: proxy.upstreamFailures() }
        const refused = error instanceof ReceiverRefusedError
        const outcome = refused ? castOutcomeOf('refused', counts) : null
        // The proxy must not outlive a failed attempt: it would sit on the
        // network serving a stream nothing is watching.
        proxy.stop()
        // A receiver that refused without fetching anything never got here:
        // say that, rather than blame a stream it never saw.
        const message =
          refused && counts.served === 0
            ? UNREACHED_MESSAGE
            : error instanceof Error
              ? error.message
              : String(error)
        if (delivery === null) return { ok: false, error: message }
        if (outcome === null) return { ok: false, error: message, final: true }
        return {
          ok: false,
          // The receiver's own sentence blames the stream; a block is the source's doing.
          error: outcome === 'blocked' ? blockedCastMessage(now.providerName) : message,
          final: true,
          learned: await learnedOf(outcome),
        }
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
          finished: false,
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
        finished: playback.finished,
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
