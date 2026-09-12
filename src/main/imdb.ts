/**
 * IMDB suggestion-API client — the general search backend.
 *
 * This is the endpoint that powers the search box on imdb.com. It is
 * undocumented and unversioned, which is a real risk, but it earns its place:
 * it covers essentially every title that exists, it is fast, and critically it
 * returns the **IMDB id directly**.
 *
 * That last point is why cycle 1 was wrong to drop it. Providers key on IMDB
 * ids. Searching TMDB instead means every play needs a second `external_ids`
 * round trip, and any title TMDB has no `imdb_id` for becomes unplayable rather
 * than merely slower.
 *
 * The division of labour with TMDB:
 *
 *   IMDB  → search, the id, breadth of catalogue
 *   TMDB  → artwork, episode lists, air dates, release countdowns
 *
 * Because it is undocumented, every field is treated as optional and a shape we
 * do not recognise is skipped rather than crashing the search.
 */

import type { MediaSummary, MediaType } from '@shared/types'
import type { Paged } from '@shared/ipc'
import { REQUEST_HEADERS } from './identity'

const BASE = 'https://v3.sg.media-imdb.com/suggestion'

const CACHE_TTL_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 8_000

const cache = new Map<string, { at: number; value: ImdbResponse }>()

/* ── Response shape ─────────────────────────────────────────────────────── */

interface ImdbSuggestion {
  /** `tt…` for a title, `nm…` for a person, `in…` for a franchise. */
  id?: string
  /** Label — the title. */
  l?: string
  /** Type id, e.g. `tvSeries`, `movie`, `tvMiniSeries`. */
  qid?: string
  /** Human-readable type, e.g. "TV series". Present only on titles. */
  q?: string
  /** Year of release, or first air year. */
  y?: number
  /** Year range for series, e.g. "2008-2013". */
  yr?: string
  /** Cast line, e.g. "Bryan Cranston, Aaron Paul". */
  s?: string
  /** Popularity rank; lower is more popular. */
  rank?: number
  i?: { imageUrl?: string; width?: number; height?: number }
}

interface ImdbResponse {
  d?: ImdbSuggestion[]
}

/* ── Mapping ────────────────────────────────────────────────────────────── */

/**
 * IMDB's `qid` vocabulary collapsed to the two types the app understands.
 *
 * Carried over from the original's `parser.js`, including its default: an
 * unrecognised type is treated as TV, because the TV template also carries
 * season and episode and therefore degrades more gracefully than the reverse.
 */
function toMediaType(qid: string | undefined): MediaType {
  if (!qid) return 'tv'
  // Only things with a season/episode structure. A `tvMovie` or `tvSpecial` is
  // a single programme that happened to air on television — routing it through
  // a provider's `/tv/{id}/{season}/{episode}` template 404s every time.
  if (/^(tvSeries|tvMiniSeries|tvEpisode)$/i.test(qid)) return 'tv'
  if (/^(movie|tvMovie|tvSpecial|tvShort|short|video|videoGame|musicVideo)$/i.test(qid))
    return 'movie'
  return 'tv'
}

/** Only titles are playable. People (`nm…`) and franchises (`in…`) are not. */
function isTitle(item: ImdbSuggestion): boolean {
  return typeof item.id === 'string' && item.id.startsWith('tt')
}

function toSummary(item: ImdbSuggestion): MediaSummary {
  return {
    // Unresolved: IMDB does not know TMDB's ids. Filled in on demand.
    tmdbId: 0,
    imdbId: item.id ?? null,
    source: 'imdb',
    type: toMediaType(item.qid),
    title: item.l ?? 'Untitled',
    // An absolute URL rather than a TMDB path. `posterUrl()` handles both.
    posterPath: item.i?.imageUrl ?? null,
    // IMDB's suggestion payload has no landscape art. The detail view fills
    // this in from TMDB once the title is opened.
    backdropPath: null,
    // `s` is the cast line, not a synopsis, but it is the only prose IMDB
    // returns here and it is more useful under a search tile than nothing.
    overview: item.s ?? '',
    // No rating in this payload. 0 reads as "unrated" throughout the UI.
    rating: 0,
    releaseDate: item.y ? `${item.y}-01-01` : null,
    genreIds: [],
  }
}

/* ── Fetching ───────────────────────────────────────────────────────────── */

async function get(path: string): Promise<ImdbResponse> {
  const url = `${BASE}/${path}`

  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value

  const res = await fetch(url, {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`IMDB suggestion responded ${res.status}`)
  const value = (await res.json()) as ImdbResponse

  cache.set(url, { at: Date.now(), value })
  return value
}

/* ── Public API ─────────────────────────────────────────────────────────── */

/**
 * Search IMDB.
 *
 * The endpoint takes the query as a **path segment**, not a query parameter,
 * and returns a single un-paginated batch — so `totalPages` is always 1 and the
 * caller must not try to page it.
 */
export async function search(query: string): Promise<Paged<MediaSummary>> {
  const trimmed = query.trim()
  if (!trimmed) return { items: [], page: 1, totalPages: 0 }

  const res = await get(`x/${encodeURIComponent(trimmed.toLowerCase())}.json`)
  const items = (res.d ?? [])
    .filter(isTitle)
    .map(toSummary)

  return { items, page: 1, totalPages: 1 }
}

/**
 * Look one title up by its IMDB id.
 *
 * The same endpoint answers an id as readily as a phrase, which makes it the
 * cheapest way to put a title back on screen for a library entry that has an
 * IMDB id but no TMDB id — every entry migrated from the original app.
 */
export async function byId(imdbId: string): Promise<MediaSummary | null> {
  if (!/^tt\d+$/.test(imdbId)) return null
  const res = await get(`x/${encodeURIComponent(imdbId)}.json`)
  const match = (res.d ?? []).find((item) => item.id === imdbId)
  return match ? toSummary(match) : null
}
