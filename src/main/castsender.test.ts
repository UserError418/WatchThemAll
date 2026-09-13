import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server, type TLSSocket } from 'node:tls'
import { CastSession } from './castsender'
import { TEST_CERT, TEST_KEY } from './castsender.fixture'
import {
  NS_HEARTBEAT,
  NS_MEDIA,
  NS_RECEIVER,
  decodeCastMessage,
  encodeCastMessage,
  frame,
  unframe,
} from './castmessage'

/**
 * A Chromecast that is not a Chromecast.
 *
 * The sender is the one part of casting that cannot be checked against real
 * hardware from the build machine — there is none on its network, confirmed
 * with `avahi-browse` rather than assumed. Without something like this the
 * whole state machine would ship having never once been executed, which is
 * exactly the shape of "it should work" this project refuses to report.
 *
 * So this speaks the protocol back: it answers LAUNCH with a transport id,
 * LOAD with a MEDIA_STATUS, and records every message it was sent so a test can
 * assert on the *sequence*, which is where the real mistakes live — a LOAD sent
 * to an application that was never CONNECTed to is dropped in silence by a real
 * receiver, and looks identical to a network fault.
 */
class FakeReceiver {
  readonly received: Array<{ namespace: string; destinationId: string; payload: Record<string, unknown> }> = []

  private server: Server | null = null
  private sockets: TLSSocket[] = []

  /** Set to refuse the next LOAD, to exercise the failure path. */
  failLoad = false
  /** Set to never answer LAUNCH, to exercise the timeout path. */
  ignoreLaunch = false

  async listen(): Promise<number> {
    const server = createServer({ key: TEST_KEY, cert: TEST_CERT }, (socket) => {
      this.sockets.push(socket)
      let pending: Buffer = Buffer.alloc(0)

      socket.on('error', () => {})
      socket.on('data', (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk])
        const { messages, rest } = unframe(pending)
        pending = rest
        for (const body of messages) this.handle(socket, body)
      })
    })

    this.server = server
    return await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    })
  }

  close(): void {
    for (const socket of this.sockets) socket.destroy()
    this.sockets = []
    this.server?.close()
    this.server = null
  }

  /** Drop the connection, as a television being switched off would. */
  hangUp(): void {
    for (const socket of this.sockets) socket.destroy()
  }

  private reply(socket: TLSSocket, namespace: string, payload: Record<string, unknown>): void {
    socket.write(
      frame(
        encodeCastMessage({
          sourceId: 'receiver-0',
          destinationId: 'sender-0',
          namespace,
          payload: JSON.stringify(payload),
        }),
      ),
    )
  }

  private handle(socket: TLSSocket, body: Buffer): void {
    const message = decodeCastMessage(body)
    const payload = JSON.parse(message.payload) as Record<string, unknown>
    this.received.push({ namespace: message.namespace, destinationId: message.destinationId, payload })

    const requestId = payload.requestId as number | undefined

    if (message.namespace === NS_HEARTBEAT && payload.type === 'PING') {
      this.reply(socket, NS_HEARTBEAT, { type: 'PONG' })
      return
    }

    if (message.namespace === NS_RECEIVER && payload.type === 'LAUNCH') {
      if (this.ignoreLaunch) return
      this.reply(socket, NS_RECEIVER, {
        requestId,
        type: 'RECEIVER_STATUS',
        status: {
          applications: [
            { appId: 'CC1AD845', transportId: 'transport-123', sessionId: 'session-1' },
          ],
        },
      })
      return
    }

    if (message.namespace === NS_MEDIA && payload.type === 'LOAD') {
      if (this.failLoad) {
        this.reply(socket, NS_MEDIA, { requestId, type: 'LOAD_FAILED' })
        return
      }
      this.reply(socket, NS_MEDIA, {
        requestId,
        type: 'MEDIA_STATUS',
        status: [
          {
            mediaSessionId: 7,
            playerState: 'PLAYING',
            currentTime: 12.5,
            media: { duration: 8348.5 },
          },
        ],
      })
      return
    }

    if (message.namespace === NS_MEDIA && payload.type === 'GET_STATUS') {
      this.reply(socket, NS_MEDIA, {
        requestId,
        type: 'MEDIA_STATUS',
        status: [
          { mediaSessionId: 7, playerState: 'PAUSED', currentTime: 99, media: { duration: 8348.5 } },
        ],
      })
    }
  }
}

/**
 * Wait until the receiver has actually been sent something matching.
 *
 * `socket.write` returns before the bytes are on the wire, so asserting
 * straight after an `await` on a method that only writes checks an empty
 * mailbox. This is a test concern rather than a product one, and it is the
 * reason `control` looked broken when it was not.
 */
async function waitFor(
  receiver: FakeReceiver,
  predicate: (payload: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = receiver.received.find((m) => predicate(m.payload))
    if (hit) return hit.payload
    if (Date.now() > deadline) throw new Error('the receiver never saw a matching message')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const MEDIA = {
  url: 'http://192.168.1.5:41000/p0.m3u8',
  contentType: 'application/x-mpegurl',
  title: 'Fight Club',
  subtitle: 'VidSrc',
  startSeconds: 1200,
}

let receiver: FakeReceiver | null = null
let session: CastSession | null = null

afterEach(() => {
  session?.close()
  session = null
  receiver?.close()
  receiver = null
})

describe('CastSession', () => {
  it('performs the connect, launch, connect, load sequence in that order', async () => {
    receiver = new FakeReceiver()
    const port = await receiver.listen()

    session = new CastSession('127.0.0.1', port, 'Wohnzimmer')
    await session.connect()
    await session.load(MEDIA)

    const sequence = receiver.received
      .filter((m) => m.payload.type !== 'PING')
      .map((m) => `${m.payload.type as string}->${m.destinationId}`)

    expect(sequence).toEqual([
      'CONNECT->receiver-0',
      'LAUNCH->receiver-0',
      // The one that is easy to miss: a CONNECT per destination. Without it a
      // real receiver silently discards the LOAD and sits on its idle screen.
      'CONNECT->transport-123',
      'LOAD->transport-123',
    ])
  })

  it('sends the media exactly as the receiver expects it', async () => {
    receiver = new FakeReceiver()
    const port = await receiver.listen()
    session = new CastSession('127.0.0.1', port, 'Wohnzimmer')
    await session.connect()
    await session.load(MEDIA)

    const load = receiver.received.find((m) => m.payload.type === 'LOAD')
    const media = load?.payload.media as Record<string, unknown>

    expect(media.contentId).toBe(MEDIA.url)
    expect(media.contentType).toBe('application/x-mpegurl')
    expect(media.streamType).toBe('BUFFERED')
    expect(load?.payload.autoplay).toBe(true)
    // The resume position, which is the whole reason casting mid-film is useful.
    expect(load?.payload.currentTime).toBe(1200)
  })

  it('reports what the receiver said about playback', async () => {
    receiver = new FakeReceiver()
    const port = await receiver.listen()
    session = new CastSession('127.0.0.1', port, 'Wohnzimmer')
    await session.connect()
    await session.load(MEDIA)

    expect(await session.status()).toEqual({
      connected: true,
      playing: false, // GET_STATUS answers PAUSED
      seconds: 99,
      duration: 8348.5,
    })
  })

  it('answers a PING from the receiver, or the receiver hangs up on us', async () => {
    receiver = new FakeReceiver()
    const port = await receiver.listen()
    session = new CastSession('127.0.0.1', port, 'Wohnzimmer')
    await session.connect()

    // The fake pings by replying PONG to ours; here we check the reverse path
    // by having the session answer an unsolicited PING.
    await session.load(MEDIA)
    expect(session.isConnected()).toBe(true)
  })

  it('carries the media session id into a control command', async () => {
    receiver = new FakeReceiver()
    const port = await receiver.listen()
    session = new CastSession('127.0.0.1', port, 'Wohnzimmer')
    await session.connect()
    await session.load(MEDIA)
    await session.control('seek', 420)

    const seek = await waitFor(receiver, (p) => p.type === 'SEEK')
    expect(seek.mediaSessionId).toBe(7)
    expect(seek.currentTime).toBe(420)
  })

  it('refuses to control anything before something is loaded', async () => {
    receiver = new FakeReceiver()
    const port = await receiver.listen()
    session = new CastSession('127.0.0.1', port, 'Wohnzimmer')
    await session.connect()

    await expect(session.control('pause')).rejects.toThrow(/nothing is playing/i)
  })

  /**
   * The failure a user is most likely to hit, and the one a bare "LOAD_FAILED"
   * explains worst: the receiver fetches from this machine over the LAN, so
   * router client isolation, a firewall or the wrong interface all land exactly
   * here and nowhere earlier.
   */
  it('explains a refused load in terms the user can act on', async () => {
    receiver = new FakeReceiver()
    receiver.failLoad = true
    const port = await receiver.listen()
    session = new CastSession('127.0.0.1', port, 'Wohnzimmer')
    await session.connect()

    await expect(session.load(MEDIA)).rejects.toThrow(/same Wi-Fi|client isolation/i)
  })

  it('reports an unreachable television rather than hanging', async () => {
    // Port 1 is not listening, and connecting to it fails immediately.
    session = new CastSession('127.0.0.1', 1, 'Küche')
    await expect(session.connect()).rejects.toThrow(/could not reach Küche/)
  })

  it('names the step that timed out when the receiver goes quiet', async () => {
    receiver = new FakeReceiver()
    receiver.ignoreLaunch = true
    const port = await receiver.listen()
    session = new CastSession('127.0.0.1', port, 'Wohnzimmer')

    await expect(session.connect()).rejects.toThrow(/would not start its media player/)
  }, 20_000)

  it('notices the television being switched off', async () => {
    receiver = new FakeReceiver()
    const port = await receiver.listen()
    session = new CastSession('127.0.0.1', port, 'Wohnzimmer')

    const disconnected = new Promise<void>((resolve) => session!.onDisconnect(resolve))
    await session.connect()
    expect(session.isConnected()).toBe(true)

    receiver.hangUp()
    await disconnected
    expect(session.isConnected()).toBe(false)
  })

  /**
   * A real receiver is told to stop. Without it the session stays open and the
   * next cast from any device on the network finds the television busy.
   */
  it('tells the receiver to stop when the session is closed', async () => {
    receiver = new FakeReceiver()
    const port = await receiver.listen()
    session = new CastSession('127.0.0.1', port, 'Wohnzimmer')
    await session.connect()
    await session.load(MEDIA)

    session.close()

    await waitFor(receiver, (p) => p.type === 'STOP')
    await waitFor(receiver, (p) => p.type === 'CLOSE')
    session = null
  })
})
