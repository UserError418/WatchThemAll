/**
 * Driving a Chromecast over its own protocol.
 *
 * One TLS socket to port 8009 carrying framed `CastMessage` envelopes
 * (`castmessage.ts`), each holding a JSON payload. The sequence a receiver
 * expects never varies:
 *
 *   1. CONNECT to `receiver-0`, or it ignores everything that follows
 *   2. PING every few seconds, or it closes the socket
 *   3. LAUNCH the receiver application, and wait for its transport id
 *   4. CONNECT again, this time to that transport id
 *   5. LOAD the media, and from then on PLAY / PAUSE / SEEK / STOP
 *
 * Steps 1 and 4 are the ones people miss: a `CONNECT` is per *destination*, not
 * per socket, so a LOAD sent to a freshly launched application that was never
 * connected to is silently dropped. There is no error — the television simply
 * sits on its idle screen.
 *
 * ## The certificate
 *
 * A Chromecast presents a certificate signed by Google's own device CA, for a
 * hostname that is an IP address. It cannot validate against the public trust
 * store and is not meant to; the connection is encrypted, unauthenticated, and
 * on the local network. `rejectUnauthorized: false` is the protocol working as
 * designed rather than a shortcut — but it is the reason nothing secret may
 * ever travel over this socket, and nothing does: the payloads are a URL on
 * this machine's own LAN address and a title.
 *
 * ## Failure reporting
 *
 * This is the one part of casting that cannot be tested from the build machine
 * — there is no Chromecast reachable from it, confirmed with `avahi-browse`
 * rather than assumed. So every step has its own timeout and its own sentence,
 * and a failure says which of the five above it got to. That is worth more here
 * than anywhere else in the feature, because the first real run happens on
 * somebody else's network.
 */

import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import {
  DEFAULT_MEDIA_RECEIVER,
  NS_CONNECTION,
  NS_HEARTBEAT,
  NS_MEDIA,
  NS_RECEIVER,
  decodeCastMessage,
  encodeCastMessage,
  frame,
  unframe,
} from './castmessage'

const SENDER_ID = 'sender-0'
const RECEIVER_ID = 'receiver-0'

/** The receiver closes a socket that stops pinging; five seconds is its own default. */
const HEARTBEAT_MS = 5000

/** How long any one step may take before it is reported as that step failing. */
const STEP_TIMEOUT_MS = 12_000

export interface CastMedia {
  /** A URL on this machine's LAN address. See `castproxy.ts`. */
  url: string
  contentType: string
  title: string
  subtitle: string
  startSeconds: number
}

export interface CastPlaybackStatus {
  connected: boolean
  playing: boolean
  seconds: number
  duration: number
  /**
   * The receiver's own volume, 0–1, and its mute.
   *
   * Receiver-level, not media-level, which is why it does not arrive with the
   * position: it comes in `RECEIVER_STATUS` on a different namespace, from a
   * different transport id. It is also the television's volume on a set that
   * does HDMI-CEC, which is the reason the remote labels the slider.
   */
  volume: number
  muted: boolean
}

/** A JSON payload from the receiver, with the fields this file reads. */
interface ReceiverPayload {
  type?: string
  requestId?: number
  status?: {
    applications?: Array<{ appId?: string; transportId?: string; sessionId?: string }>
    mediaSessionId?: number
    volume?: { level?: number; muted?: boolean }
  }
  // MEDIA_STATUS puts an array here rather than an object.
  [key: string]: unknown
}

interface MediaStatusEntry {
  mediaSessionId?: number
  playerState?: string
  currentTime?: number
  media?: { duration?: number }
}

/**
 * The receiver answered a LOAD with LOAD_FAILED or LOAD_CANCELLED.
 *
 * Its own type because it is the one failure that says something about the
 * source rather than about the connection: the television was reached, was
 * handed the stream, and said no. `castservice.ts` records it against the
 * source and title, so the cast list stops offering what this TV refused.
 */
export class ReceiverRefusedError extends Error {}

export class CastSession {
  private socket: TLSSocket | null = null
  private pending: Buffer = Buffer.alloc(0)
  private heartbeat: NodeJS.Timeout | null = null
  private requestId = 1

  /** Set once the receiver application is running. */
  private transportId: string | null = null
  private mediaSessionId: number | null = null

  private lastStatus: CastPlaybackStatus = {
    connected: false,
    playing: false,
    seconds: 0,
    duration: 0,
    volume: 0,
    muted: false,
  }

  /** requestId -> resolver, for the messages that expect an answer. */
  private waiting = new Map<number, (payload: ReceiverPayload) => void>()

  private onClosed: (() => void) | null = null

  constructor(
    readonly address: string,
    readonly port: number,
    readonly deviceName: string,
  ) {}

  /** Called when the receiver goes away for any reason. */
  onDisconnect(callback: () => void): void {
    this.onClosed = callback
  }

  isConnected(): boolean {
    return this.socket !== null && this.transportId !== null
  }

  /* ── Connecting ───────────────────────────────────────────────────────── */

  async connect(): Promise<void> {
    await this.openSocket()
    this.send(NS_CONNECTION, RECEIVER_ID, { type: 'CONNECT' })
    this.startHeartbeat()
    await this.launch()
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`${this.deviceName} did not answer on the network`))
      }, STEP_TIMEOUT_MS)

      const socket = tlsConnect(
        {
          host: this.address,
          port: this.port,
          // See this file's header: a Chromecast's certificate is signed by
          // Google's device CA for an IP address and cannot validate publicly.
          rejectUnauthorized: false,
        },
        () => {
          clearTimeout(timer)
          this.socket = socket
          resolve()
        },
      )

      socket.on('error', (error) => {
        clearTimeout(timer)
        this.teardown()
        reject(new Error(`could not reach ${this.deviceName}: ${error.message}`))
      })
      socket.on('close', () => {
        this.teardown()
        this.onClosed?.()
      })
      socket.on('data', (chunk: Buffer) => this.receive(chunk))
    })
  }

  /**
   * Start the Default Media Receiver and remember where to talk to it.
   *
   * The transport id is the whole point of this step. It is not the app id and
   * it is not stable across launches; every later message goes to it, and
   * without a second CONNECT addressed to it the receiver discards them.
   */
  private async launch(): Promise<void> {
    const status: ReceiverPayload = await this.request(NS_RECEIVER, RECEIVER_ID, {
      type: 'LAUNCH',
      appId: DEFAULT_MEDIA_RECEIVER,
    }, 'the TV would not start its media player')

    // The launch answer is the first receiver status of the session, and the
    // only place the volume is known before anything has been played.
    this.readReceiverStatus(status)

    const app = status.status?.applications?.find((entry) => entry.appId === DEFAULT_MEDIA_RECEIVER)
    if (!app?.transportId) {
      throw new Error('the TV started its media player but did not say where to reach it')
    }

    // A relaunch means the media session behind the old id is gone; keeping it
    // would let a later `control()` address a session the receiver forgot.
    if (this.transportId !== app.transportId) this.mediaSessionId = null

    this.transportId = app.transportId
    // The CONNECT that is easy to miss. Without it, LOAD below is dropped in
    // silence and the television sits on its idle screen.
    this.send(NS_CONNECTION, this.transportId, { type: 'CONNECT' })
    this.lastStatus = { ...this.lastStatus, connected: true }
  }

  /* ── Playback ─────────────────────────────────────────────────────────── */

  async load(media: CastMedia): Promise<void> {
    if (!this.socket) throw new Error('not connected to a TV')

    /*
     * Relaunch before every load, rather than trusting the transport id from
     * `connect()`.
     *
     * The Default Media Receiver shuts itself down after a spell with nothing
     * playing, and it takes its transport id with it. The socket survives —
     * the platform receiver is still there and still answering heartbeats — so
     * nothing here notices, and the next LOAD is addressed to an application
     * that no longer exists and is dropped without a reply. The user sees a
     * cast that worked once and then never again, from the same app, the same
     * provider and the same television.
     *
     * LAUNCH is idempotent: for an app that is already running it returns the
     * running session, so this costs one round trip and nothing else.
     */
    await this.launch()
    if (!this.transportId) throw new Error('not connected to a TV')

    const answer = await this.request(
      NS_MEDIA,
      this.transportId,
      {
        type: 'LOAD',
        autoplay: true,
        currentTime: media.startSeconds,
        media: {
          contentId: media.url,
          contentType: media.contentType,
          streamType: 'BUFFERED',
          metadata: {
            metadataType: 0,
            title: media.title,
            subtitle: media.subtitle,
          },
        },
      },
      'the TV did not accept the stream',
    )

    if (answer.type === 'LOAD_FAILED' || answer.type === 'LOAD_CANCELLED') {
      /*
       * Two causes, and the wrong guess sends the user to the router for an
       * hour.
       *
       * A playlist the receiver could not play is about the stream: the proxy
       * serves every playlist with the CORS header the receiver's HLS player
       * needs, so what is left is the stream itself — a codec, an encrypted
       * segment, a source that answers the proxy with an error. (It was once
       * blamed on the receiver refusing HLS altogether. Measured 2026-09-26,
       * it does not: the 2026-09-13 test that said so served no CORS header.)
       *
       * For a plain file the network is the first suspect: the receiver has
       * to reach this machine, so client isolation, a firewall or the wrong
       * interface all surface exactly here and nowhere earlier.
       */
      if (media.contentType.includes('mpegurl')) {
        throw new ReceiverRefusedError(
          `${this.deviceName} will not play this stream. Try another source.`,
        )
      }
      throw new ReceiverRefusedError(
        `${this.deviceName} could not load the stream. It has to reach this computer over the network; check that both are on the same Wi-Fi and that client isolation is off.`,
      )
    }

    this.readMediaStatus(answer)
  }

  async control(action: 'play' | 'pause' | 'stop' | 'seek', seconds = 0): Promise<void> {
    if (!this.transportId) throw new Error('not connected to a TV')
    if (this.mediaSessionId === null) throw new Error('nothing is playing on the TV yet')

    /*
     * Every media command needs a `requestId`, and a real receiver silently
     * ignores one without it.
     *
     * Measured against a Chromecast on 2026-09-13: PLAY, PAUSE and SEEK were
     * accepted onto the wire and changed nothing — the film kept playing and a
     * seek to 3600s left the position where it was. The loopback tests had
     * passed because the fake receiver answered anything put in front of it,
     * which is the failure mode of a fake that is more permissive than the
     * thing it stands in for. `castsender.test.ts` now rejects a command with
     * no requestId, so this cannot regress unnoticed.
     */
    const base = { mediaSessionId: this.mediaSessionId, requestId: this.requestId++ }
    const payload =
      action === 'play'
        ? { ...base, type: 'PLAY' }
        : action === 'pause'
          ? { ...base, type: 'PAUSE' }
          : action === 'stop'
            ? { ...base, type: 'STOP' }
            : { ...base, type: 'SEEK', currentTime: seconds }

    this.send(NS_MEDIA, this.transportId, payload)
  }

  /**
   * The last thing the receiver said, refreshed on request.
   *
   * Polled rather than pushed because the renderer already polls once a second
   * for the phone, and one shape for both platforms is worth more than the
   * handful of milliseconds a push would save.
   */
  async status(): Promise<CastPlaybackStatus> {
    if (!this.transportId) {
      return { connected: false, playing: false, seconds: 0, duration: 0, volume: 0, muted: false }
    }
    try {
      const answer = await this.request(
        NS_MEDIA,
        this.transportId,
        { type: 'GET_STATUS' },
        'the TV stopped answering',
      )
      this.readMediaStatus(answer)
    } catch {
      // A status that cannot be fetched is not worth tearing the session down
      // for; the next poll may well succeed, and the heartbeat is what actually
      // decides whether the receiver is still there.
    }
    return this.lastStatus
  }

  private readMediaStatus(payload: ReceiverPayload): void {
    const entries = payload.status as MediaStatusEntry[] | undefined
    const entry = Array.isArray(entries) ? entries[0] : undefined
    if (!entry) return

    if (typeof entry.mediaSessionId === 'number') this.mediaSessionId = entry.mediaSessionId
    this.lastStatus = {
      ...this.lastStatus,
      connected: true,
      playing: entry.playerState === 'PLAYING',
      seconds: entry.currentTime ?? this.lastStatus.seconds,
      duration: entry.media?.duration ?? this.lastStatus.duration,
    }
  }

  /**
   * Volume, out of any receiver-level status.
   *
   * Called for solicited answers *and* for the unsolicited broadcasts, which
   * is what makes the slider follow the television's own remote rather than
   * only the app's. A receiver announces `RECEIVER_STATUS` whenever its volume
   * changes, whoever changed it.
   */
  private readReceiverStatus(payload: ReceiverPayload): void {
    const volume = payload.status?.volume
    if (!volume) return
    this.lastStatus = {
      ...this.lastStatus,
      volume: typeof volume.level === 'number' ? clampLevel(volume.level) : this.lastStatus.volume,
      muted: typeof volume.muted === 'boolean' ? volume.muted : this.lastStatus.muted,
    }
  }

  /**
   * Set the receiver's volume, or its mute.
   *
   * Addressed to `RECEIVER_ID` on the receiver namespace, **not** to the media
   * transport that `control` uses. That distinction is the whole reason this
   * is not another `control` verb: sent to the media session a `SET_VOLUME` is
   * accepted onto the wire and ignored, which is the same silent nothing that
   * a missing `requestId` produced in September and took hardware to find.
   *
   * No media session is needed, so this works from the moment a device is
   * connected — before anything has been beamed to it.
   */
  async setVolume(level: number, muted?: boolean): Promise<void> {
    if (!this.socket) throw new Error('not connected to a TV')

    const volume: Record<string, unknown> = {}
    if (Number.isFinite(level)) volume.level = clampLevel(level)
    if (typeof muted === 'boolean') volume.muted = muted

    const answer = await this.request(
      NS_RECEIVER,
      RECEIVER_ID,
      { type: 'SET_VOLUME', volume },
      'the TV did not accept the volume change',
    )
    this.readReceiverStatus(answer)
  }

  /* ── Teardown ─────────────────────────────────────────────────────────── */

  close(): void {
    if (this.socket && this.transportId) {
      try {
        // Politeness that matters: without it the receiver holds the session
        // open and the next cast from any device finds the TV busy.
        this.send(NS_RECEIVER, RECEIVER_ID, { type: 'STOP' })
        this.send(NS_CONNECTION, this.transportId, { type: 'CLOSE' })
      } catch {
        // The socket is already gone, which is the state we were aiming for.
      }
    }
    /*
     * `end()`, not `destroy()`.
     *
     * `destroy()` discards whatever is still in the write buffer, and the two
     * messages above were written microseconds earlier — measured against a
     * fake receiver, the STOP arrived and the CLOSE did not. A receiver that
     * never gets the CLOSE holds the session open, and the next cast from any
     * device finds the television busy.
     *
     * The socket is captured first because `teardown` nulls it, and destroyed
     * shortly after in case the peer never completes the close.
     */
    const socket = this.socket
    socket?.end()
    setTimeout(() => socket?.destroy(), 500)
    this.teardown()
  }

  private teardown(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    this.socket = null
    this.transportId = null
    this.mediaSessionId = null
    this.pending = Buffer.alloc(0)
    for (const resolve of this.waiting.values()) resolve({ type: 'DISCONNECTED' })
    this.waiting.clear()
    // Volume is not reset: it belongs to the television, which still has it
    // after our socket goes away. Zeroing it here would make the slider claim
    // the set had been silenced by a dropped connection.
    this.lastStatus = {
      ...this.lastStatus,
      connected: false,
      playing: false,
      seconds: 0,
      duration: 0,
    }
  }

  /* ── Wire ─────────────────────────────────────────────────────────────── */

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      try {
        this.send(NS_HEARTBEAT, RECEIVER_ID, { type: 'PING' })
      } catch {
        // Socket gone; the close handler has already run or is about to.
      }
    }, HEARTBEAT_MS)
  }

  private send(namespace: string, destinationId: string, payload: Record<string, unknown>): void {
    if (!this.socket) throw new Error('not connected to a TV')
    this.socket.write(
      frame(
        encodeCastMessage({
          sourceId: SENDER_ID,
          destinationId,
          namespace,
          payload: JSON.stringify(payload),
        }),
      ),
    )
  }

  /** Send something that expects an answer, and wait for the matching one. */
  private request(
    namespace: string,
    destinationId: string,
    payload: Record<string, unknown>,
    failureMessage: string,
  ): Promise<ReceiverPayload> {
    const id = this.requestId++

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error(failureMessage))
      }, STEP_TIMEOUT_MS)

      this.waiting.set(id, (answer) => {
        clearTimeout(timer)
        if (answer.type === 'DISCONNECTED') {
          reject(new Error(`${this.deviceName} disconnected`))
          return
        }
        resolve(answer)
      })

      try {
        this.send(namespace, destinationId, { ...payload, requestId: id })
      } catch (error) {
        clearTimeout(timer)
        this.waiting.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private receive(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk])
    const { messages, rest } = unframe(this.pending)
    this.pending = rest

    for (const body of messages) {
      let payload: ReceiverPayload
      let namespace: string
      try {
        const message = decodeCastMessage(body)
        namespace = message.namespace
        payload = JSON.parse(message.payload) as ReceiverPayload
      } catch {
        continue // A message we cannot read is not a reason to drop the session.
      }

      if (namespace === NS_HEARTBEAT && payload.type === 'PING') {
        // Receivers ping too, and one that is not answered closes the socket.
        try {
          this.send(NS_HEARTBEAT, RECEIVER_ID, { type: 'PONG' })
        } catch {
          // Gone; the close handler will deal with it.
        }
        continue
      }

      if (namespace === NS_MEDIA && payload.type === 'MEDIA_STATUS') {
        this.readMediaStatus(payload)
      }

      // Unsolicited as well as solicited: a receiver broadcasts this whenever
      // its volume moves, including from the television's own remote.
      if (namespace === NS_RECEIVER && payload.type === 'RECEIVER_STATUS') {
        this.readReceiverStatus(payload)
      }

      if (typeof payload.requestId === 'number') {
        const resolve = this.waiting.get(payload.requestId)
        if (resolve) {
          this.waiting.delete(payload.requestId)
          resolve(payload)
        }
      }
    }
  }
}

/** 0–1, whatever a receiver or a slider hands over. */
function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 0
  return Math.max(0, Math.min(1, level))
}
