/**
 * Putting the stream on a television, from the phone.
 *
 * ## The shape of the problem
 *
 * Casting is not "send the video". The app never holds a video: it loads a
 * provider's embed page into an iframe and that page's own script resolves the
 * media, in a cross-origin document nothing here can read. So three things have
 * to happen before a Chromecast can be handed anything at all.
 *
 * 1. **Find out what the player fetched.** The native side records every
 *    plausible request off the WebView, with its headers — `MediaCapture`.
 * 2. **Work out which of those is a stream.** Not by matching `.m3u8`: several
 *    providers serve their manifest from a path with no extension, and the
 *    desktop extractor's URL matching is the known reason two of the best
 *    providers report "no stream" while playing perfectly. This fetches each
 *    candidate and looks at what comes back, which is a fact rather than a
 *    guess.
 * 3. **Make it fetchable by something that is not this WebView.** Most
 *    providers are `header-gated`; the receiver sends no `Referer` and the Cast
 *    API cannot attach one. `buildCastBundle` rewrites the playlist so every
 *    URL in it points back at a proxy on the phone, which replays the headers.
 *
 * Only then is there a URL to cast.
 *
 * ## Why this reports failures in words
 *
 * Every step above can fail for a different reason, and they are reasons a user
 * can act on: no Wi-Fi, a provider that will not give up its stream, a
 * television that went off the network. A single false would make all of them
 * look like the same shrug, so `beam` resolves with a sentence.
 */

import { registerPlugin } from '@capacitor/core'
import type { CastDevice, CastStatus } from '@shared/ipc'
import { buildCastBundle, isPlaylist, isWholeVideoFile } from '@main/hlsrewrite'

/** One request the player made, as the native side recorded it. */
export interface Candidate {
  url: string
  headers: Record<string, string>
  atMs: number
}

interface CastNative {
  candidates(): Promise<{ candidates: Candidate[] }>
  clearCandidates(): Promise<void>
  fetchText(options: {
    url: string
    headers: Record<string, string>
    limitBytes?: number
    /** `base64` returns the raw bytes, encoded; see `capture.peekBytes`. */
    encoding?: 'text' | 'base64'
  }): Promise<{ status: number; contentType: string; body: string }>
  startProxy(options: {
    playlists: Record<string, string>
    targets: Record<string, string>
    headers: Record<string, string>
  }): Promise<{ base: string }>
  stopProxy(): Promise<void>
  startDiscovery(): Promise<void>
  stopDiscovery(): Promise<void>
  devices(): Promise<{ devices: CastDevice[] }>
  connect(options: { deviceId: string }): Promise<void>
  disconnect(): Promise<void>
  loadMedia(options: {
    url: string
    title: string
    subtitle: string
    contentType: string
    startSeconds: number
  }): Promise<void>
  control(options: { action: string; seconds?: number }): Promise<void>
  /**
   * The receiver's volume and mute.
   *
   * One native call for both, with either field optional, because
   * `CastSession` exposes them as two setters against the same session and a
   * pair of plugin methods would be two bridges to keep in step for no gain.
   */
  setVolume(options: { level?: number; muted?: boolean }): Promise<void>
  status(): Promise<CastStatus>
  addListener(event: 'castDevices', cb: (payload: { devices: CastDevice[] }) => void): Promise<{ remove(): void }>
  addListener(
    event: 'castSession',
    cb: (payload: { state: string; deviceName: string; error?: number }) => void,
  ): Promise<{ remove(): void }>
}

const Cast = registerPlugin<CastNative>('Cast')

/**
 * The native media-capture buffer, shared with the provider scan.
 *
 * `MediaCapture` on the Java side records every request that looks like it
 * could be a stream, from every frame including a cross-origin one, because
 * `shouldInterceptRequest` is the only hook a WebView offers. Casting reads it
 * to find a URL to hand the television; the scan reads it to answer a
 * different question — did *anything* stream at all.
 *
 * Exported rather than re-registered in `scan.ts` so there is one definition of
 * the native interface. Two `registerPlugin` calls would work and would be two
 * copies of a contract with Java to keep in step.
 *
 * **It is one buffer with no frame attribution**, which is what forces the scan
 * to be sequential and to stop playback while it runs. See `scan.ts`.
 */
export const capture = {
  async list(): Promise<Candidate[]> {
    return (await Cast.candidates()).candidates
  },
  clear(): Promise<void> {
    return Cast.clearCandidates()
  },
  /**
   * Fetch the start of one captured request, replaying its headers.
   *
   * For the scan, which sometimes has to ask what a URL *is* because its shape
   * says nothing — see `isMediaResponse`. Small on purpose: the answer is in
   * the type and the first line, and the candidate may well be a segment
   * several megabytes long.
   */
  peek(candidate: Candidate): Promise<{ status: number; contentType: string; body: string }> {
    return Cast.fetchText({
      url: candidate.url,
      headers: replayable(candidate.headers),
      limitBytes: PEEK_LIMIT_BYTES,
    })
  },
  /**
   * Fetch a captured playlist whole, replaying its headers.
   *
   * For the scan's quality reading, where `peek`'s 16 KB is not enough: a
   * film's media playlist runs past it, and the length the reading checks
   * against the title (see `lengthVerdict`) is the sum of every segment's.
   */
  read(candidate: Candidate): Promise<{ status: number; contentType: string; body: string }> {
    return Cast.fetchText({
      url: candidate.url,
      headers: replayable(candidate.headers),
      limitBytes: SNIFF_LIMIT_BYTES,
    })
  },
  /**
   * Fetch the first bytes of a URL a captured request led to, as bytes.
   *
   * For the scan's quality reading: a media playlist's init segment, or the
   * head of its first segment, is where the stream states its picture size.
   * Neither is in the capture buffer by then, necessarily, so this takes the
   * URL from the playlist and the headers from the playlist's own request —
   * the same player asked the same host a moment earlier.
   */
  async peekBytes(
    url: string,
    via: Candidate,
    range: { offset: number; length: number },
  ): Promise<{ status: number; bytes: Uint8Array }> {
    const response = await Cast.fetchText({
      url,
      headers: { ...replayable(via.headers), Range: `bytes=${range.offset}-${range.offset + range.length - 1}` },
      limitBytes: range.length,
      encoding: 'base64',
    })
    const binary = atob(response.body)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return { status: response.status, bytes }
  },
}

/**
 * Enough for a playlist's first lines and a response type; see `capture.peek`.
 * Exported so a caller can tell a whole body from one this cut short.
 */
export const PEEK_LIMIT_BYTES = 16 * 1024

/**
 * How much of a candidate to read while deciding what it is.
 *
 * A playlist announces itself in the first seven bytes, so this only has to be
 * large enough to hold a whole one for the case where the candidate *is* the
 * manifest — a feature-length VOD playlist with a segment every six seconds
 * runs to a few hundred kilobytes. Anything larger is not being parsed anyway,
 * and reading a video file into a string would take the app out.
 */
const SNIFF_LIMIT_BYTES = 2 * 1024 * 1024

/** Content types that are worth casting without being a playlist. */
const PROGRESSIVE_TYPES = ['video/mp4', 'video/webm']

/**
 * Headers we replay upstream, minus the ones that must not be.
 *
 * `Range` is the important exclusion: it was captured from whatever byte the
 * player happened to want, and replaying it on a manifest request returns a
 * slice of the playlist — which parses as a valid but truncated stream, the
 * kind of failure that looks like a bug in the rewriter.
 */
const NOT_REPLAYED = new Set(['range', 'host', 'connection', 'content-length', 'accept-encoding'])

function replayable(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!NOT_REPLAYED.has(name.toLowerCase())) out[name] = value
  }
  return out
}

/** What a candidate turned out to be. */
interface Identified {
  url: string
  headers: Record<string, string>
  kind: 'hls' | 'progressive'
}

/**
 * Find the first candidate that something other than this WebView could play.
 *
 * Newest first, because the newest media request is the one belonging to what is
 * on screen now. That ordering is the whole defence against casting the
 * *previous* title — the same class of error as a provider sweep crediting each
 * provider with its predecessor's stream — and `clearCandidates` on every
 * provider or episode change is the other half of it.
 */
/**
 * Find the best candidate something other than this app could play.
 *
 * **A whole progressive file beats a playlist.** That is the opposite of what
 * quality would suggest, and it is what the receiver measured: a plain
 * Chromecast running the Default Media Receiver plays an HTTP MP4 and rejects
 * HLS outright with `LOAD_FAILED`, before it fetches anything. That was checked
 * against a textbook HLS stream generated locally by ffmpeg, with no provider,
 * no rewriting and no proxy involved, across four content types - so it is the
 * device, not this code. A playlist is still returned when nothing else is
 * available: it costs nothing, and a receiver that *can* play one then does.
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
    const headers = replayable(candidate.headers)

    let response: { status: number; contentType: string; body: string }
    try {
      response = await Cast.fetchText({ url: candidate.url, headers, limitBytes: SNIFF_LIMIT_BYTES })
    } catch {
      continue // Unreachable host, or a URL that has already expired.
    }

    if (response.status !== 200 && response.status !== 206) continue

    if (isPlaylist(response.body)) {
      playlist ??= { url: candidate.url, headers, kind: 'hls' }
      continue
    }

    const type = response.contentType.toLowerCase()
    if (
      PROGRESSIVE_TYPES.some((known) => type.startsWith(known)) &&
      isWholeVideoFile(response.body)
    ) {
      return { url: candidate.url, headers, kind: 'progressive' }
    }
  }
  return playlist
}

/** What the cast needs to know about what is on screen. */
export interface NowPlaying {
  title: string
  subtitle: string
  providerName: string
  /** Where to start on the television, if the app knows a position. */
  startSeconds: number
}

export interface CastBridge {
  available(): Promise<boolean>
  startDiscovery(): Promise<void>
  stopDiscovery(): Promise<void>
  devices(): Promise<CastDevice[]>
  connect(deviceId: string): Promise<{ ok: boolean; error?: string }>
  disconnect(): Promise<void>
  beam(now: NowPlaying): Promise<{ ok: boolean; error?: string; providerName?: string }>
  status(): Promise<CastStatus>
  control(action: 'play' | 'pause' | 'stop' | 'seek', seconds?: number): Promise<void>
  /** The receiver's own volume, 0–1. See `CastStatus.volume`. */
  setVolume(level: number): Promise<void>
  setMuted(muted: boolean): Promise<void>
  /** Drop captured candidates — call on every provider, episode or title change. */
  forget(): Promise<void>
  onDevices(cb: (devices: CastDevice[]) => void): () => void
  onSession(cb: (state: string, deviceName: string) => void): () => void
}

export function createCastBridge(): CastBridge {
  return {
    async available(): Promise<boolean> {
      try {
        return (await Cast.status()).available
      } catch {
        return false
      }
    },

    startDiscovery: () => Cast.startDiscovery(),
    stopDiscovery: () => Cast.stopDiscovery(),

    async devices(): Promise<CastDevice[]> {
      try {
        return (await Cast.devices()).devices
      } catch {
        return []
      }
    },

    async connect(deviceId: string): Promise<{ ok: boolean; error?: string }> {
      try {
        await Cast.connect({ deviceId })
        return { ok: true }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    disconnect: () => Cast.disconnect(),

    async beam(now: NowPlaying): Promise<{ ok: boolean; error?: string; providerName?: string }> {
      try {
        const { candidates } = await Cast.candidates()
        if (candidates.length === 0) {
          return { ok: false, error: 'Nothing to cast yet — start playing first, then try again.' }
        }

        const stream = await identifyStream(candidates)
        if (stream === null) {
          return {
            ok: false,
            error: `${now.providerName} does not hand out a stream that a TV can play. Try another source.`,
          }
        }

        const bundle = await buildCastBundle(stream.url, stream.kind === 'hls' ? 'hls' : 'progressive', async (url) => {
          const response = await Cast.fetchText({ url, headers: stream.headers, limitBytes: SNIFF_LIMIT_BYTES })
          if (response.status !== 200 && response.status !== 206) {
            throw new Error(`the source answered ${response.status}`)
          }
          return response.body
        })

        const { base } = await Cast.startProxy({
          playlists: Object.fromEntries(bundle.playlists.map((p) => [p.id, p.body])),
          targets: Object.fromEntries(bundle.targets.map((t) => [t.id, t.url])),
          headers: stream.headers,
        })

        await Cast.loadMedia({
          // The `.m3u8` suffix is for the receiver's benefit: it sniffs the
          // extension before it looks at the content type.
          url: stream.kind === 'hls' ? `${base}${bundle.rootId}.m3u8` : `${base}${bundle.rootId}`,
          title: now.title,
          subtitle: now.subtitle,
          contentType: stream.kind === 'hls' ? 'application/x-mpegurl' : 'video/mp4',
          startSeconds: now.startSeconds,
        })

        return { ok: true, providerName: now.providerName }
      } catch (error) {
        // The proxy must not outlive a failed attempt: it would sit on the
        // network serving a stream nothing is watching.
        try {
          await Cast.stopProxy()
        } catch {
          // Already down, which is the state we wanted.
        }
        return { ok: false, error: messageOf(error) }
      }
    },

    async status(): Promise<CastStatus> {
      try {
        return await Cast.status()
      } catch {
        return {
          available: false,
          connected: false,
          deviceName: '',
          playing: false,
          seconds: 0,
          duration: 0,
          proxyRunning: false,
          volume: 0,
          muted: false,
        }
      }
    },

    control: (action, seconds) => Cast.control({ action, seconds }),

    /*
     * Swallowed rather than thrown. A volume change is a nudge, not a
     * transaction: a receiver that refuses one has nothing the user can do
     * about it, and an exception here would surface as a red error over a
     * remote that is otherwise working perfectly.
     */
    setVolume: async (level) => {
      try {
        await Cast.setVolume({ level })
      } catch {
        // The next status poll will show the volume did not move.
      }
    },

    setMuted: async (muted) => {
      try {
        await Cast.setVolume({ muted })
      } catch {
        // As above.
      }
    },

    forget: () => Cast.clearCandidates(),

    onDevices(cb): () => void {
      const handle = Cast.addListener('castDevices', (payload) => cb(payload.devices))
      return () => void handle.then((h) => h.remove())
    },

    onSession(cb): () => void {
      const handle = Cast.addListener('castSession', (payload) => cb(payload.state, payload.deviceName))
      return () => void handle.then((h) => h.remove())
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
