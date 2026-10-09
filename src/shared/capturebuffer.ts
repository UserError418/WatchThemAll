/**
 * What a cast keeps of a page's requests, and in which order it offers them:
 * shared by the player's cast capture (`src/main/castcapture.ts`, the
 * phone's `MediaCapture.java` follows the same rule) and by the source
 * tests' cast check, so a test looks at exactly what a cast would.
 *
 * Request-side only: a capture sees a request before any answer, so it
 * cannot tell an extensionless manifest from an extensionless segment. The
 * cast's choice (`castroot.ts`) decides by fetching.
 */

/**
 * How many candidates to keep.
 *
 * A player resolves its stream through two or three chained API calls with a
 * dozen advertising requests around them. Forty holds the whole chain of every
 * provider measured so far and stays small enough to test each one.
 */
export const CAPACITY = 40

/**
 * How many of the first requests after a `clear` are kept for the whole load.
 *
 * A player resolves its stream once, at the start of a load: the manifest is
 * among its first requests. After that an adaptive player fetches segments for
 * as long as the film plays, and some sources name them with no extension the
 * filter below could drop (MoviesAPI's `workers.dev/file2/…`, VidRock,
 * 111Movies' `/api?d=…`). Measured 2026-10-09: twenty seconds into a MoviesAPI
 * play the forty newest requests were all segments, the manifest had gone, and
 * the cast found nothing to send although the source casts. So the first
 * requests are held apart from the rolling forty, and offered first.
 */
export const HEAD_CAPACITY = 20

/**
 * Extensions that are never the thing to cast.
 *
 * `.ts`, `.m4s` and `.aac` are here for a different reason than the rest: they
 * *are* media, but they are segments, and a feature-length stream produces
 * upwards of a thousand. One of those floods would push the manifest out of the
 * buffer within seconds of playback starting — which is exactly when somebody
 * reaches for the cast button.
 */
export const IGNORED_EXTENSIONS = [
  '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.html', '.htm', '.vtt', '.srt',
  '.ts', '.m4s', '.aac', '.mp3',
]

/**
 * The candidates of one load: its first `HEAD_CAPACITY` for good, and the
 * newest `CAPACITY` rolling. Pure, so the rule is tested without a session.
 */
export class CaptureBuffer<T> {
  private head: T[] = []
  private recent: T[] = []

  add(candidate: T): void {
    if (this.head.length < HEAD_CAPACITY) this.head.push(candidate)
    this.recent.push(candidate)
    if (this.recent.length > CAPACITY) this.recent = this.recent.slice(-CAPACITY)
  }

  /**
   * The load's first requests, newest of them first, then the rest of the
   * rolling newest, newest first. The first ones lead because they hold the
   * manifest, and the cast's choice asks about only so many
   * (`MAX_CANDIDATES` in `castroot.ts`); each candidate once.
   */
  candidates(): T[] {
    const head = new Set(this.head)
    return [...[...this.head].reverse(), ...[...this.recent].reverse().filter((c) => !head.has(c))]
  }

  clear(): void {
    this.head = []
    this.recent = []
  }
}

/** Whether a request could be the thing to cast: http(s), and not a page asset or a named segment. */
export function isWorthKeeping(url: string): boolean {
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

