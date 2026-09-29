/**
 * The preview cache's book-keeping: which windows are kept, which one a
 * preview may start from, and which go when there is no more room.
 *
 * One window per title, the latest: the preview plays where Resume would, and
 * that is where the viewer last stopped. The owner's limits (2026-09-29): 40
 * titles and a 1 GB hard limit, the oldest window replaced first. Pure: the
 * platforms keep the files and this index (a JSON file beside them), and ask
 * here what to do with both.
 */

export interface CachedWindow {
  /** The window's directory name: letters, digits and dashes only. */
  id: string
  /** `titleKey` of the request (`tv:tt0386676`, `movie:tt0137523`). */
  titleKey: string
  season: number | null
  episode: number | null
  /** The source it was cut from. A preview only uses a window from its own source. */
  providerId: string
  /** Film time of the kept video's first frame, and of its last. */
  startSeconds: number
  endSeconds: number
  bytes: number
  savedAt: number
}

export const CACHE_MAX_TITLES = 40
export const CACHE_MAX_BYTES = 1_000_000_000

/**
 * Worth starting from only with this much left in it: the source's own
 * preview needs seconds to load behind it, and a window about to run out
 * would show a few frames and then hold the last one.
 */
export const MIN_CACHE_AHEAD_SECONDS = 8

/**
 * How far before its first frame a place may be and still start there: a
 * window is cut from the segment playing at the place, so it can begin a few
 * seconds early, and a place saved a moment before can be behind it.
 */
const EARLY_TOLERANCE_SECONDS = 2

/**
 * Add a window. Returns the index to keep and the windows whose files go: the
 * title's previous window, then the oldest until both limits hold. The new
 * window itself is never dropped for being new, but a single window larger
 * than the whole budget is refused.
 */
export function admitWindow(
  index: readonly CachedWindow[],
  added: CachedWindow,
  limits = { titles: CACHE_MAX_TITLES, bytes: CACHE_MAX_BYTES },
): { index: CachedWindow[]; drop: CachedWindow[] } {
  if (added.bytes > limits.bytes) return { index: [...index], drop: [added] }
  const drop = index.filter((w) => w.titleKey === added.titleKey)
  const kept = index.filter((w) => w.titleKey !== added.titleKey).sort((a, b) => a.savedAt - b.savedAt)
  let bytes = kept.reduce((sum, w) => sum + w.bytes, 0) + added.bytes
  while (kept.length > 0 && (kept.length + 1 > limits.titles || bytes > limits.bytes)) {
    const oldest = kept.shift()!
    bytes -= oldest.bytes
    drop.push(oldest)
  }
  return { index: [...kept, added], drop }
}

/** The window a preview of this episode, from this source, may start at `seconds` from. */
export function windowFor(
  index: readonly CachedWindow[],
  where: { titleKey: string; season: number | null; episode: number | null; providerId: string },
  seconds: number,
): CachedWindow | null {
  const found = index.find(
    (w) =>
      w.titleKey === where.titleKey &&
      w.season === where.season &&
      w.episode === where.episode &&
      w.providerId === where.providerId,
  )
  if (!found) return null
  const from = Math.max(seconds, found.startSeconds)
  if (seconds < found.startSeconds - EARLY_TOLERANCE_SECONDS) return null
  if (found.endSeconds - from < MIN_CACHE_AHEAD_SECONDS) return null
  return found
}

/** A title's window, whatever episode: the one that goes when the title gets a new one. */
export function windowOfTitle(index: readonly CachedWindow[], titleKey: string): CachedWindow | null {
  return index.find((w) => w.titleKey === titleKey) ?? null
}

/** Only well-formed entries: the index is a file on disk and may be from an older build or damaged. */
export function readIndex(raw: unknown): CachedWindow[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { windows?: unknown }).windows)) return []
  return ((raw as { windows: unknown[] }).windows).filter((w): w is CachedWindow => {
    if (typeof w !== 'object' || w === null) return false
    const v = w as Record<string, unknown>
    return (
      typeof v.id === 'string' &&
      /^[a-z0-9-]+$/.test(v.id) &&
      typeof v.titleKey === 'string' &&
      (v.season === null || typeof v.season === 'number') &&
      (v.episode === null || typeof v.episode === 'number') &&
      typeof v.providerId === 'string' &&
      typeof v.startSeconds === 'number' &&
      typeof v.endSeconds === 'number' &&
      typeof v.bytes === 'number' &&
      typeof v.savedAt === 'number'
    )
  })
}

export function writeIndex(index: readonly CachedWindow[]): string {
  return JSON.stringify({ windows: index })
}

/** A directory name for a new window: unique, and safe in a URL path and on any file system. */
export function windowId(where: { titleKey: string; season: number | null; episode: number | null }, now: number): string {
  const title = where.titleKey.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const episode = where.season === null ? 'm' : `${where.season}-${where.episode ?? 0}`
  return `${title}-${episode}-${now.toString(36)}`
}
