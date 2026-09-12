/**
 * MyAnimeList ids for TMDB series, so AniSkip can be asked about them.
 *
 * AniSkip is keyed by MAL id and nothing else, while every other id in this
 * app is TMDB or IMDB. The bridge is Fribb's `anime-lists`, the mapping the
 * wider anime tooling ecosystem already standardises on — and crucially it
 * carries the *TMDB season* each MAL entry corresponds to, which matters
 * because MAL splits a show by cour where TMDB keeps one series with seasons.
 *
 * ## Why it is downloaded rather than shipped
 *
 * Two reasons, and the first is not negotiable. Bundling somebody else's
 * database into a released binary is redistribution, with whatever licence
 * terms attach; querying and caching it on the user's own machine is not. The
 * second is staleness: a shipped copy is wrong for every anime that airs after
 * the release.
 *
 * The published file is 5.8 MB and 39,304 entries, of which 6,936 are TV with
 * both ids. It is reduced to those three numbers on arrival and only the
 * reduction — about 106 KB — is written to disk. The download is deferred
 * until something actually needs it, which for most users is never: the two
 * general databases answer first, and only anime they both miss gets this far.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SOURCE_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-mini.json'

/** Long enough that nobody downloads it twice, short enough to catch new seasons. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

const CACHE_FILE = 'anime-ids.json'

/** `[malId, tmdbId, tmdbSeason]`. An array rather than objects: it is 6,936 rows. */
type Row = [number, number, number | null]

interface Cache {
  fetchedAt: number
  rows: Row[]
}

let memory: Cache | null = null
/** In flight, so two episodes starting at once do not both download 5.8 MB. */
let loading: Promise<Cache | null> | null = null

export type FetchLike = typeof fetch

/** Reduce the published file to the three fields this app uses. */
export function reduce(published: unknown): Row[] {
  if (!Array.isArray(published)) return []
  const rows: Row[] = []
  for (const raw of published) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Record<string, unknown>
    const mal = entry.mal_id
    const tmdb = entry.themoviedb_id
    // `themoviedb_id` is `{ tv: n }` for series and a bare number for films;
    // only series have episodes to skip an opening in.
    const tv =
      typeof tmdb === 'object' && tmdb !== null ? (tmdb as Record<string, unknown>).tv : undefined
    if (typeof mal !== 'number' || typeof tv !== 'number') continue
    const season = entry.season
    const tmdbSeason =
      typeof season === 'object' && season !== null
        ? (season as Record<string, unknown>).tmdb
        : undefined
    rows.push([mal, tv, typeof tmdbSeason === 'number' ? tmdbSeason : null])
  }
  return rows
}

/**
 * The MAL id for one TMDB season, or null.
 *
 * Exact season matches win outright. A mapping that names no season is used
 * only for season 1, because MAL's default entry is the first cour and
 * applying it to season 4 would ask AniSkip about the wrong show entirely —
 * and AniSkip would answer, confidently, with the first season's opening.
 */
export function lookup(rows: readonly Row[], tmdbId: number, season: number | null): number | null {
  let unseasoned: number | null = null
  for (const [mal, tv, tmdbSeason] of rows) {
    if (tv !== tmdbId) continue
    if (tmdbSeason !== null && tmdbSeason === season) return mal
    if (tmdbSeason === null && unseasoned === null) unseasoned = mal
  }
  return season === null || season === 1 ? unseasoned : null
}

async function readCache(dir: string): Promise<Cache | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, CACHE_FILE), 'utf8')) as Cache
    if (!Array.isArray(parsed.rows) || typeof parsed.fetchedAt !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

async function download(dir: string, fetchImpl: FetchLike, now: number): Promise<Cache | null> {
  try {
    const response = await fetchImpl(SOURCE_URL, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) return null
    const rows = reduce(await response.json())
    if (rows.length === 0) return null

    const fresh: Cache = { fetchedAt: now, rows }
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, CACHE_FILE), JSON.stringify(fresh), 'utf8')
    return fresh
  } catch {
    // No mapping means no AniSkip, which means the other two databases are all
    // there is. That is a smaller feature, not a broken one.
    return null
  }
}

/**
 * The mapping, from memory, then disk, then the network.
 *
 * A stale cache is still returned when the refresh fails: last month's ids are
 * right about every anime that existed last month, which is almost all of them.
 */
export async function load(
  dir: string,
  fetchImpl: FetchLike = fetch,
  now: number = Date.now(),
): Promise<Cache | null> {
  if (memory && now - memory.fetchedAt < MAX_AGE_MS) return memory
  if (loading) return loading

  loading = (async () => {
    const cached = await readCache(dir)
    if (cached && now - cached.fetchedAt < MAX_AGE_MS) {
      memory = cached
      return cached
    }
    const fresh = await download(dir, fetchImpl, now)
    memory = fresh ?? cached
    return memory
  })().finally(() => {
    loading = null
  })

  return loading
}

/** Convenience over `load` + `lookup`. Null whenever anything is missing. */
export async function malIdFor(
  dir: string,
  tmdbId: number,
  season: number | null,
  fetchImpl: FetchLike = fetch,
): Promise<number | null> {
  const cache = await load(dir, fetchImpl)
  return cache ? lookup(cache.rows, tmdbId, season) : null
}

/** Tests only: the module-level cache would otherwise leak between cases. */
export function resetForTests(): void {
  memory = null
  loading = null
}
