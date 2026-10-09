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
import { buildCastBundle } from '@main/hlsrewrite'
import { chooseCastRoot, PLAYLIST_BYTES, rootRefusal, rootSignature, type FetchedText, type RootFetch } from '@main/castroot'
import {
  blockedCastMessage,
  CAST_ANSWER_WINDOW_MS,
  castOutcomeOf,
  type CastLearned,
  type ProxyCounts,
  type ReceiverAnswer,
} from '@shared/castanswer'
import type { StreamSignature } from '@shared/streamsignature'
import { downloadCastBundle } from '@shared/downloads/castbundle'
import { unguessableId } from '@main/hlsrewrite'

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
  }): Promise<{
    status: number
    contentType: string
    body: string
    /**
     * The whole body's size, from `Content-Range` or a 200's
     * `Content-Length`, when the server said (2.0.19); absent from an
     * older native side, which reads as not said.
     */
    totalBytes?: number
    /** How long the fetch took on the native side, in milliseconds, before the body crossed the bridge (2.0.19). */
    elapsedMs?: number
  }>
  /** A URL's bytes straight into `path` under the app's files directory (`preview-cache/` only). */
  downloadToFile(options: {
    url: string
    headers: Record<string, string>
    path: string
  }): Promise<{ status: number; bytes: number; head: string }>
  startProxy(options: {
    playlists: Record<string, string>
    targets: Record<string, string>
    headers: Record<string, string>
    /** id -> a download's file, as a path under `files/downloads/`. */
    files?: Record<string, string>
  }): Promise<{ base: string }>
  stopProxy(): Promise<void>
  startDiscovery(): Promise<void>
  stopDiscovery(): Promise<void>
  devices(): Promise<{ devices: CastDevice[] }>
  connect(options: { deviceId: string }): Promise<void>
  disconnect(): Promise<void>
  /**
   * Hand the receiver a stream and follow it for its answer, for up to
   * `answerWindowMs` (`LoadAnswer` in `CastPlugin.java`, the rule of
   * `shared/castanswer.ts`), with what the proxy saw meanwhile. Rejects when
   * the load never reached the receiver.
   */
  loadMedia(options: {
    url: string
    title: string
    subtitle: string
    contentType: string
    startSeconds: number
    answerWindowMs: number
    /** HLS of fragmented-MP4 segments: the receiver is told so (`CastMedia.fmp4` in `castsender.ts`). */
    fmp4?: boolean
  }): Promise<LoadAnswer>
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
  addListener(event: 'castProgress', cb: (payload: CastProgress) => void): Promise<{ remove(): void }>
  addListener(
    event: 'castSession',
    cb: (payload: { state: string; deviceName: string; error?: number }) => void,
  ): Promise<{ remove(): void }>
}

/** What `loadMedia` found out: the receiver's answer, and what the proxy saw while it had the stream. */
interface LoadAnswer extends ProxyCounts {
  answer: ReceiverAnswer
  /** The receiver's model (`CastDevice.getModelName()`), when it said; absent from an older native side. */
  model?: string
}

const Cast = registerPlugin<CastNative>('Cast')

/**
 * The native media-capture buffer, and the fetches the provider scan shares.
 *
 * `MediaCapture` on the Java side records every request that looks like it
 * could be a stream, from every frame including a cross-origin one, because
 * `shouldInterceptRequest` is the only hook a WebView offers. Casting reads it
 * to find a URL to hand the television. The scan has its own log per probe
 * session since 1.9.2 (`probeview.ts`) and uses only the fetches below —
 * `peek`, `read` and `peekBytes` — to ask what a request turned out to be.
 *
 * Exported rather than re-registered in `scan.ts` so there is one definition of
 * the native interface. Two `registerPlugin` calls would work and would be two
 * copies of a contract with Java to keep in step.
 *
 * The buffer itself is not here: **it is one buffer with no frame
 * attribution**, which kept the scan to one provider at a time for as long as
 * it read it.
 */
export const capture = {
  /** What the WebView's frames fetched, newest first: the player's surface and the preview alike. */
  async list(): Promise<Candidate[]> {
    return (await Cast.candidates()).candidates
  },
  /** A URL's text, with a captured request's headers replayed; for the preview cache. */
  text(url: string, headers: Record<string, string>, limitBytes = SNIFF_LIMIT_BYTES): Promise<{ status: number; contentType: string; body: string }> {
    return Cast.fetchText({ url, headers: replayable(headers), limitBytes })
  },
  /** A URL's bytes into a file under `preview-cache/`, with a captured request's headers replayed. */
  async download(url: string, headers: Record<string, string>, path: string): Promise<{ status: number; bytes: number; head: Uint8Array }> {
    const result = await Cast.downloadToFile({ url, headers: replayable(headers), path })
    const binary = atob(result.head)
    const head = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) head[i] = binary.charCodeAt(i)
    return { status: result.status, bytes: result.bytes, head }
  },
  /** A small URL's bytes (a key, an init segment, a poster), with a captured request's headers replayed; for downloads. */
  async bytes(url: string, headers: Record<string, string>, limitBytes: number): Promise<{ status: number; bytes: Uint8Array }> {
    const response = await Cast.fetchText({ url, headers: replayable(headers), limitBytes, encoding: 'base64' })
    const binary = atob(response.body)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return { status: response.status, bytes }
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
 * How much of a playlist to read when it is read whole: for the bundle, and
 * for the scan's quality reading. A feature-length VOD playlist with a segment
 * every six seconds runs to a few hundred kilobytes. Anything larger is not
 * being parsed anyway, and reading a video file into a string would take the
 * app out. Deciding what a candidate is takes only its start (`PEEK_LIMIT_BYTES`).
 */
const SNIFF_LIMIT_BYTES = 2 * 1024 * 1024

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

/** Base64 from the native side as bytes. */
function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * The phone's network for choosing what to cast (`castroot.ts`): the native
 * fetch, which can send the `Referer` and `Origin` a WebView refuses to set,
 * reading only as far as asked. The same client the proxy fetches with.
 */
export const phoneRootFetch: RootFetch = {
  async text(url, headers, limitBytes): Promise<FetchedText | null> {
    try {
      const answer = await Cast.fetchText({ url, headers, limitBytes })
      return { status: answer.status, contentType: answer.contentType, totalBytes: answer.totalBytes ?? null, body: answer.body }
    } catch {
      return null // Unreachable host, or a URL that has already expired.
    }
  },
  async bytes(url, headers, limitBytes) {
    try {
      const answer = await Cast.fetchText({ url, headers, limitBytes, encoding: 'base64' })
      return { status: answer.status, bytes: bytesOf(answer.body) }
    } catch {
      return null
    }
  },
}

/**
 * What a beam did, and what the television said.
 *
 * Since 2.0.18 the native `loadMedia` follows the receiver for its answer, as
 * the desktop does, so this carries the same: `learned` once the receiver has
 * played or refused the stream, and nothing to file otherwise. Until then it
 * resolved as soon as the request was sent and every beam was filed by the
 * delivery it had seen, played or not.
 */
export interface PhoneBeamResult {
  ok: boolean
  error?: string
  providerName?: string
  /** A stream was identified and the attempt failed past that point: asking again would only repeat it. */
  final?: boolean
  /** What the television said, with how the stream arrived; absent unless it answered. See `castOutcomeOf`. */
  learned?: CastLearned
}

/** What the cast needs to know about what is on screen. */
export interface NowPlaying {
  title: string
  subtitle: string
  providerName: string
  /** Where to start on the television, if the app knows a position. */
  startSeconds: number
  /** TMDB's runtime in minutes, or null: the stream chosen must run about as long (`castroot.ts`). */
  runtimeMinutes?: number | null
  /**
   * The download the player is on, with its local playlist: then its files
   * are served from the phone and nothing is captured. Absent for a source.
   */
  download?: { id: string; playlist: string } | null
}

export interface CastBridge {
  available(): Promise<boolean>
  startDiscovery(): Promise<void>
  stopDiscovery(): Promise<void>
  devices(): Promise<CastDevice[]>
  connect(deviceId: string): Promise<{ ok: boolean; error?: string }>
  disconnect(): Promise<void>
  beam(now: NowPlaying): Promise<PhoneBeamResult>
  status(): Promise<CastStatus>
  control(action: 'play' | 'pause' | 'stop' | 'seek', seconds?: number): Promise<void>
  /** The receiver's own volume, 0–1. See `CastStatus.volume`. */
  setVolume(level: number): Promise<void>
  setMuted(muted: boolean): Promise<void>
  /** Drop captured candidates — call on every provider, episode or title change. */
  forget(): Promise<void>
  onDevices(cb: (devices: CastDevice[]) => void): () => void
  onSession(cb: (state: string, deviceName: string) => void): () => void
  /**
   * The television's position, every five seconds while a stream is served
   * to it, from native code — which, unlike a JavaScript timer, still runs
   * promptly with the app in the background. See `progressTick` in
   * `CastPlugin.java`.
   */
  onProgress(cb: (progress: CastProgress) => void): () => void
}

/** One `castProgress` event. */
export interface CastProgress {
  seconds: number
  duration: number
  playing: boolean
  /** Played to the end; see `CastStatus.finished`. */
  finished: boolean
}

/**
 * Cast a download: its playlist with every file named by an id, the files
 * served by the native proxy from `files/downloads/<id>/`
 * (`shared/downloads/castbundle.ts`). No source is involved, so nothing is
 * learned about one.
 */
async function beamDownload(now: NowPlaying, download: { id: string; playlist: string }): Promise<PhoneBeamResult> {
  let proxyLoaded = false
  try {
    const bundle = downloadCastBundle(download.playlist, unguessableId)
    if (bundle === null) return { ok: false, error: 'This download is damaged; download it again.' }
    const { base } = await Cast.startProxy({
      playlists: bundle.playlists,
      targets: {},
      headers: {},
      files: Object.fromEntries(Object.entries(bundle.files).map(([id, name]) => [id, `${download.id}/${name}`])),
    })
    proxyLoaded = true
    const loaded = await Cast.loadMedia({
      url: `${base}${bundle.rootId}.m3u8`,
      title: now.title,
      subtitle: now.subtitle,
      contentType: 'application/x-mpegurl',
      startSeconds: now.startSeconds,
      answerWindowMs: CAST_ANSWER_WINDOW_MS,
    })
    if (loaded.answer === 'refused') {
      // Said, and nothing more: a download is no source to file anything against.
      await stopProxyQuietly()
      return { ok: false, error: refusalMessage(loaded, 'The TV will not play this download.'), final: true }
    }
    return { ok: true, providerName: now.providerName }
  } catch (error) {
    if (proxyLoaded) await Cast.stopProxy().catch(() => {})
    return { ok: false, error: messageOf(error) }
  }
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

    async beam(now: NowPlaying): Promise<PhoneBeamResult> {
      if (now.download) return beamDownload(now, now.download)
      /** How the identified stream arrived, once there is one. */
      let delivery: CastLearned['delivery'] | undefined
      /** This attempt has replaced what the proxy serves; see the catch. */
      let proxyLoaded = false
      try {
        const { candidates } = await Cast.candidates()
        if (candidates.length === 0) {
          return { ok: false, error: 'Nothing to cast yet — start playing first, then try again.' }
        }

        // Each candidate asked about with its own headers (`castroot.ts`); the
        // root then served with its headers alone, as the proxy replays one set.
        const runtime = now.runtimeMinutes ?? null
        const choice = await chooseCastRoot(
          candidates.map((c) => ({ url: c.url, headers: replayable(c.headers) })),
          phoneRootFetch,
          runtime,
        )
        const root = choice.root
        if (root === null) {
          return {
            ok: false,
            error:
              rootRefusal(choice.passedOver, now.providerName, runtime) ??
              `${now.providerName} does not hand out a stream that a TV can play. Try another source.`,
          }
        }

        delivery = root.kind === 'hls' ? 'segmented' : 'progressive'
        const bundle = await buildCastBundle(root.url, root.kind, async (url) => {
          // The master playlist, and its first variant, were read seconds ago
          // while choosing the stream; the player itself fetched them too.
          const known = choice.bodies.get(url)
          if (known !== undefined) return known
          const response = await Cast.fetchText({ url, headers: root.headers, limitBytes: PLAYLIST_BYTES })
          if (response.status !== 200 && response.status !== 206) {
            throw new Error(`the source answered ${response.status}`)
          }
          return response.body
        })

        const { base } = await Cast.startProxy({
          playlists: Object.fromEntries(bundle.playlists.map((p) => [p.id, p.body])),
          targets: Object.fromEntries(bundle.targets.map((t) => [t.id, t.url])),
          headers: root.headers,
        })
        proxyLoaded = true

        // Read while the receiver loads, so the answer is filed under what it
        // was handed, and the beam waits no longer for it.
        const signature: Promise<StreamSignature | null> = rootSignature(root, phoneRootFetch).catch(() => null)
        const loaded = await Cast.loadMedia({
          // The `.m3u8` suffix is for the receiver's benefit: it sniffs the
          // extension before it looks at the content type.
          url: root.kind === 'hls' ? `${base}${bundle.rootId}.m3u8` : `${base}${bundle.rootId}`,
          title: now.title,
          subtitle: now.subtitle,
          contentType: root.kind === 'hls' ? 'application/x-mpegurl' : 'video/mp4',
          startSeconds: now.startSeconds,
          answerWindowMs: CAST_ANSWER_WINDOW_MS,
          fmp4: root.kind === 'hls' && root.media.init !== null,
        })
        const learnedOf = async (outcome: CastLearned['outcome']): Promise<CastLearned> => ({
          delivery: delivery!,
          outcome,
          receiver: loaded.model ?? null,
          signature: await signature,
        })

        // Still loading at the end of the window: it goes ahead, as it always
        // did, and nothing is filed.
        if (loaded.answer === 'unsettled') return { ok: true, providerName: now.providerName }
        if (loaded.answer === 'played') return { ok: true, providerName: now.providerName, learned: await learnedOf('played') }

        // Refused. What the proxy saw says whose doing it was.
        await stopProxyQuietly()
        const outcome = castOutcomeOf('refused', loaded)
        const error =
          outcome === 'blocked'
            ? blockedCastMessage(now.providerName)
            : refusalMessage(loaded, 'The TV will not play this stream. Try another source.')
        return { ok: false, error, final: true, ...(outcome === null ? {} : { learned: await learnedOf(outcome) }) }
      } catch (error) {
        // The proxy must not outlive an attempt that failed after loading it:
        // it would sit on the network serving a stream nothing is watching.
        // One that failed earlier (a variant playlist refused, say) never
        // touched it, and the proxy may still be serving the film the
        // television is playing from an earlier beam: "Change source" to a
        // source that would not give up its stream stopped the working one.
        if (proxyLoaded) await stopProxyQuietly()
        return { ok: false, error: messageOf(error), final: delivery !== undefined }
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
          finished: false,
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

    onProgress(cb): () => void {
      const handle = Cast.addListener('castProgress', cb)
      return () => void handle.then((h) => h.remove())
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Stop serving after a failed attempt; a proxy already down is the state wanted. */
async function stopProxyQuietly(): Promise<void> {
  try {
    await Cast.stopProxy()
  } catch {
    // Already down.
  }
}

/**
 * The sentence for a refused load, by whether the receiver ever reached the
 * phone. One that never fetched anything could not get to it, which is the
 * network's doing (client isolation, another network), not the stream's.
 */
function refusalMessage(seen: ProxyCounts, refused: string): string {
  if (seen.served === 0) {
    return 'The TV never fetched the stream from this phone. Check that both are on the same Wi-Fi and that client isolation is off.'
  }
  return refused
}
