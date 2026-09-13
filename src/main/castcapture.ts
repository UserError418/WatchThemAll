/**
 * Remembering what the player's provider fetched, so it can be cast.
 *
 * The desktop twin of `MediaCapture.java`, and the same idea: casting needs a
 * URL, and the app never has one — a provider's page resolves its own media
 * inside a frame, so the only way to learn the address is to watch the network.
 *
 * ## Why `onSendHeaders`
 *
 * It is the last event before the wire and the only one where `Cookie` is
 * present: the network stack adds it after `onBeforeSendHeaders`. A provider
 * that gates on a session cookie would otherwise look reachable here and refuse
 * the Chromecast — which is `streamextract.ts`'s `sealed` verdict arriving as a
 * mystery instead of a diagnosis. `streamextract` learned this the same way and
 * says so in its own comment.
 *
 * It is also purely an observer. `onBeforeRequest` and `onBeforeSendHeaders`
 * take a callback that decides the request's fate, and `playerview.ts` and
 * `identity.ts` already own those; adding a third opinion to a request's
 * lifetime would be a way to break playback for a feature that is meant to sit
 * beside it.
 *
 * ## Why it does not decide what a stream is
 *
 * Matching `.m3u8` here is the obvious move and is the known reason the desktop
 * extractor reports "no stream at all" for providers that demonstrably play:
 * several serve manifests from paths with no extension — `…/pl/H4sIAAAA…`,
 * `…/v1/proxy?data=…`. So this keeps candidates and refuses to judge them; the
 * decision is made by fetching one, in `identifyStream`.
 */

import type { Session } from 'electron'

/**
 * How many candidates to keep.
 *
 * A player resolves its stream through two or three chained API calls with a
 * dozen advertising requests around them. Forty holds the whole chain of every
 * provider measured so far and stays small enough to test each one.
 */
const CAPACITY = 40

/**
 * Extensions that are never the thing to cast.
 *
 * `.ts`, `.m4s` and `.aac` are here for a different reason than the rest: they
 * *are* media, but they are segments, and a feature-length stream produces
 * upwards of a thousand. One of those floods would push the manifest out of the
 * buffer within seconds of playback starting — which is exactly when somebody
 * reaches for the cast button.
 */
const IGNORED_EXTENSIONS = [
  '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.html', '.htm', '.vtt', '.srt',
  '.ts', '.m4s', '.aac', '.mp3',
]

export interface Candidate {
  url: string
  headers: Record<string, string>
  atMs: number
}

export interface CastCapture {
  /** Start watching a player session. Safe to call again for a new session. */
  watch(session: Session): void
  /** Everything captured since the last clear, newest first. */
  candidates(): Candidate[]
  /** Forget everything. See below — this is not optional. */
  clear(): void
}

function isWorthKeeping(url: string): boolean {
  let path: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    path = parsed.pathname.toLowerCase()
  } catch {
    return false
  }
  return !IGNORED_EXTENSIONS.some((extension) => path.endsWith(extension))
}

/**
 * Flatten Electron's header shape.
 *
 * `onSendHeaders` reports a value that may be a string or an array of them —
 * `Set-Cookie` style — and everything downstream wants one string per name.
 */
function flatten(headers: Record<string, string | string[]>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    out[name] = Array.isArray(value) ? value.join('; ') : value
  }
  return out
}

export function createCastCapture(): CastCapture {
  let recent: Candidate[] = []
  const watched = new WeakSet<Session>()

  return {
    watch(session: Session): void {
      // A player view may be rebuilt without its session changing; registering
      // twice would double every capture and halve the useful depth of the
      // buffer.
      if (watched.has(session)) return
      watched.add(session)

      session.webRequest.onSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
        if (details.method !== 'GET') return
        if (!isWorthKeeping(details.url)) return

        recent.push({
          url: details.url,
          headers: flatten(details.requestHeaders),
          atMs: Date.now(),
        })
        if (recent.length > CAPACITY) recent = recent.slice(-CAPACITY)
      })
    },

    candidates(): Candidate[] {
      return [...recent].reverse()
    },

    /**
     * Forget everything.
     *
     * Called on every provider, episode and title change. Without it the
     * previous title's manifest is still the newest thing in the buffer for the
     * first few seconds of the next one, and casting would quietly put the
     * wrong film on the television — the same class of error as a provider
     * sweep crediting each provider with its predecessor's stream.
     */
    clear(): void {
      recent = []
    },
  }
}
