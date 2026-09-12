/**
 * TMDB client. Lives in the main process because it owns the API key, and
 * because keeping every network call out of the renderer is what lets the main
 * window run with `webSecurity` enabled.
 *
 * TMDB does not advertise rate-limit headers any more, but it does throttle.
 * Responses are cached in memory with a short TTL, which matters most for the
 * browse view: scrolling back up a row must not re-request the page.
 */

import type {
  Episode,
  MediaDetail,
  MediaSummary,
  MediaType,
  Season,
} from '@shared/types'
import type { DiscoverRequest, GenreRowRequest, Paged, RowId, RowRequest } from '@shared/ipc'
import { REQUEST_HEADERS } from './identity'

const BASE = 'https://api.themoviedb.org/3'

/**
 * A widely-shared public key, kept only so a fresh clone works without setup.
 * It is rate-limited across everyone using it — set `VITE_TMDB_KEY` at build
 * time with a personal key for anything beyond trying the app out.
 */
const FALLBACK_KEY = '1f54bd990f1cdfb230adb312546d765d'
const API_KEY = process.env.VITE_TMDB_KEY || FALLBACK_KEY

const CACHE_TTL_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000

const cache = new Map<string, { at: number; value: unknown }>()

async function get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const url = new URL(BASE + path)
  url.searchParams.set('api_key', API_KEY)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))

  const key = url.toString()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T

  const res = await fetch(key, {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`TMDB ${path} responded ${res.status}`)
  const value = (await res.json()) as T

  cache.set(key, { at: Date.now(), value })
  return value
}

/* ── Response shapes ────────────────────────────────────────────────────── */

interface TmdbListItem {
  id: number
  media_type?: string
  name?: string
  title?: string
  poster_path: string | null
  backdrop_path: string | null
  overview?: string
  vote_average?: number
  vote_count?: number
  first_air_date?: string
  release_date?: string
  genre_ids?: number[]
}

interface TmdbPage {
  page: number
  total_pages: number
  results: TmdbListItem[]
}

interface TmdbEpisode {
  season_number?: number
  episode_number: number
  name: string
  air_date: string | null
  overview?: string
  still_path?: string | null
  runtime?: number | null
  vote_average?: number
}

/* ── Mapping ────────────────────────────────────────────────────────────── */

/**
 * TMDB names the same field differently for TV and film (`name`/`title`,
 * `first_air_date`/`release_date`). Normalising once here is what keeps that
 * distinction out of every component downstream.
 */
function toSummary(item: TmdbListItem, fallbackType: MediaType): MediaSummary {
  const type: MediaType =
    item.media_type === 'movie' ? 'movie' : item.media_type === 'tv' ? 'tv' : fallbackType
  return {
    tmdbId: item.id,
    type,
    title: item.title ?? item.name ?? 'Untitled',
    posterPath: item.poster_path,
    backdropPath: item.backdrop_path,
    overview: item.overview ?? '',
    rating: item.vote_average ?? 0,
    voteCount: item.vote_count ?? 0,
    releaseDate: item.release_date ?? item.first_air_date ?? null,
    genreIds: item.genre_ids ?? [],
  }
}

function toPaged(page: TmdbPage, fallbackType: MediaType): Paged<MediaSummary> {
  return {
    // `search/multi` mixes in `person` results, which have no poster and are
    // not playable. Drop them here rather than in every consumer.
    items: page.results
      .filter((r) => r.media_type !== 'person')
      .map((r) => toSummary(r, fallbackType)),
    page: page.page,
    totalPages: page.total_pages,
  }
}

/* ── Public API ─────────────────────────────────────────────────────────── */

const ROW_PATHS: Record<RowId, { path: string; type: MediaType }> = {
  trending: { path: '/trending/tv/week', type: 'tv' },
  topRated: { path: '/tv/top_rated', type: 'tv' },
  onTheAir: { path: '/tv/on_the_air', type: 'tv' },
  upcoming: { path: '/movie/upcoming', type: 'movie' },
  popularMovies: { path: '/movie/popular', type: 'movie' },
}

function isGenreRow(req: RowRequest | GenreRowRequest): req is GenreRowRequest {
  return 'genreId' in req
}

/**
 * Sort orders the discovery feed rotates through.
 *
 * Popularity alone gives the same few hundred titles forever, which is the
 * opposite of discovery. Rotating the sort — and the seed picking where in the
 * rotation a session starts — means two sessions explore different parts of the
 * catalogue while each stays internally stable as the user scrolls.
 *
 * Vote-count floors are on the individual sorts that need them: sorting by
 * rating with no floor surfaces films with a single 10/10 vote.
 */
const DISCOVER_SORTS = [
  { sort_by: 'popularity.desc', 'vote_count.gte': 50 },
  { sort_by: 'vote_average.desc', 'vote_count.gte': 300 },
  { sort_by: 'revenue.desc', 'vote_count.gte': 50 },
  { sort_by: 'primary_release_date.desc', 'vote_count.gte': 40 },
  { sort_by: 'vote_count.desc' },
] as const

export async function row(
  req: RowRequest | GenreRowRequest | DiscoverRequest,
): Promise<Paged<MediaSummary>> {
  if (isDiscoverRow(req)) {
    const sort = DISCOVER_SORTS[(req.seed + req.page) % DISCOVER_SORTS.length]!
    const page = await get<TmdbPage>(`/discover/${req.type}`, {
      ...sort,
      // TMDB refuses pages past 500 with a 422, which would surface as an error
      // toast at the bottom of an infinite list. Wrapping is friendlier than
      // stopping, and by page 500 the user has seen 10,000 titles.
      page: ((req.page - 1) % 500) + 1,
      include_adult: 'false',
    })
    return toPaged(page, req.type)
  }

  if (isGenreRow(req)) {
    const page = await get<TmdbPage>(`/discover/${req.type}`, {
      with_genres: req.genreId,
      sort_by: 'popularity.desc',
      page: req.page,
    })
    return toPaged(page, req.type)
  }
  const spec = ROW_PATHS[req.row]
  const page = await get<TmdbPage>(spec.path, { page: req.page })
  return toPaged(page, spec.type)
}

function isDiscoverRow(
  req: RowRequest | GenreRowRequest | DiscoverRequest,
): req is DiscoverRequest {
  return 'discover' in req
}

/**
 * Titles matching any of several genres.
 *
 * `with_genres` joined by `|` is TMDB's OR; a comma would be AND, which for a
 * three-genre profile returns almost nothing. A vote floor keeps the row from
 * filling with titles that match the genres and nothing else.
 */
export async function discoverByGenres(
  type: MediaType,
  genreIds: number[],
  page: number,
): Promise<Paged<MediaSummary>> {
  if (genreIds.length === 0) return { items: [], page, totalPages: 0 }
  const res = await get<TmdbPage>(`/discover/${type}`, {
    with_genres: genreIds.join('|'),
    sort_by: 'popularity.desc',
    'vote_count.gte': 80,
    include_adult: 'false',
    page: Math.max(1, page),
  })
  return toPaged(res, type)
}

export async function search(query: string, page = 1): Promise<Paged<MediaSummary>> {
  if (!query.trim()) return { items: [], page: 1, totalPages: 0 }
  const res = await get<TmdbPage>('/search/multi', { query, page, include_adult: 'false' })
  return toPaged(res, 'tv')
}

export async function detail(tmdbId: number, type: MediaType): Promise<MediaDetail> {
  interface TmdbDetail extends TmdbListItem {
    genres?: Array<{ id: number; name: string }>
    status?: string
    number_of_seasons?: number
    number_of_episodes?: number
    runtime?: number | number[] | null
    episode_run_time?: number[]
    next_episode_to_air?: TmdbEpisode | null
    last_episode_to_air?: TmdbEpisode | null
    external_ids?: { imdb_id?: string | null }
    imdb_id?: string | null
    videos?: { results?: TmdbVideo[] }
  }

  // `append_to_response` folds both sub-resources into the one request. The
  // detail view needs the IMDB id to play and the trailer key to fill the
  // billboard, and three round trips to open one title is what made the
  // original feel slow.
  const d = await get<TmdbDetail>(`/${type}/${tmdbId}`, {
    append_to_response: 'external_ids,videos',
  })
  const summary = toSummary({ ...d, media_type: type }, type)

  const stub = (e: TmdbEpisode | null | undefined) =>
    e
      ? {
          season: e.season_number ?? 0,
          episode: e.episode_number,
          name: e.name,
          airDate: e.air_date,
        }
      : null

  return {
    ...summary,
    // The detail endpoint returns `genres` objects where list endpoints return
    // `genre_ids`. Normalise so both carry the same field.
    genreIds: (d.genres ?? []).map((g) => g.id),
    imdbId: d.external_ids?.imdb_id ?? d.imdb_id ?? null,
    genres: (d.genres ?? []).map((g) => g.name),
    status: d.status ?? 'Unknown',
    seasonCount: d.number_of_seasons ?? 0,
    episodeCount: d.number_of_episodes ?? 0,
    runtime: typeof d.runtime === 'number' ? d.runtime : (d.episode_run_time?.[0] ?? null),
    nextEpisode: stub(d.next_episode_to_air),
    lastEpisode: stub(d.last_episode_to_air),
    trailerKey: pickTrailer(d.videos?.results),
  }
}

/* ── Trailers ───────────────────────────────────────────────────────────── */

interface TmdbVideo {
  key: string
  site: string
  type: string
  official?: boolean
  name?: string
  published_at?: string
}

/**
 * Choose the video to autoplay behind the billboard.
 *
 * TMDB returns everything from official trailers to fan-made recaps in no
 * useful order, so preference is explicit: an official Trailer first, then any
 * Trailer, then a Teaser. Anything else (featurettes, clips, bloopers) is
 * rejected — they open mid-scene and make a poor first frame.
 *
 * YouTube only, because that is the only origin the renderer's CSP will allow.
 */
function pickTrailer(videos: TmdbVideo[] | undefined): string | null {
  const usable = (videos ?? []).filter((v) => v.site === 'YouTube' && v.key)

  const rank = (v: TmdbVideo): number => {
    if (v.type === 'Trailer') return v.official ? 0 : 1
    if (v.type === 'Teaser') return v.official ? 2 : 3
    return 99
  }

  const best = usable
    .map((v) => ({ v, score: rank(v) }))
    .filter((x) => x.score < 99)
    .sort((a, b) => a.score - b.score)[0]

  return best?.v.key ?? null
}

/** Trailer key for a title we only hold a summary for, e.g. a hovered card. */
export async function trailer(tmdbId: number, type: MediaType): Promise<string | null> {
  const res = await get<{ results?: TmdbVideo[] }>(`/${type}/${tmdbId}/videos`)
  return pickTrailer(res.results)
}

/* ── Cross-referencing ──────────────────────────────────────────────────── */

/**
 * Resolve an IMDB id to a TMDB id.
 *
 * This is the bridge between the two backends: IMDB search and the original
 * app's migrated library both identify titles by IMDB id, while everything the
 * app displays — artwork, episodes, air dates — comes from TMDB.
 *
 * Returns the type alongside the id because IMDB's own type guess is derived
 * from an undocumented vocabulary, and TMDB knowing a title as a film is
 * better evidence than IMDB's `qid` suggesting a series.
 */
export async function findByImdb(
  imdbId: string,
): Promise<{ tmdbId: number; type: MediaType } | null> {
  if (!/^tt\d+$/.test(imdbId)) return null

  const res = await get<{ movie_results?: TmdbListItem[]; tv_results?: TmdbListItem[] }>(
    `/find/${imdbId}`,
    { external_source: 'imdb_id' },
  )

  const tv = res.tv_results?.[0]
  if (tv) return { tmdbId: tv.id, type: 'tv' }

  const movie = res.movie_results?.[0]
  if (movie) return { tmdbId: movie.id, type: 'movie' }

  return null
}

export async function season(tmdbId: number, seasonNumber: number): Promise<Season> {
  const s = await get<{ name: string; episodes: TmdbEpisode[] }>(
    `/tv/${tmdbId}/season/${seasonNumber}`,
  )
  const episodes: Episode[] = s.episodes.map((e) => ({
    season: e.season_number ?? seasonNumber,
    episode: e.episode_number,
    name: e.name,
    airDate: e.air_date,
    overview: e.overview ?? '',
    stillPath: e.still_path ?? null,
    runtime: e.runtime ?? null,
    rating: e.vote_average ?? 0,
  }))
  return { season: seasonNumber, name: s.name, episodes }
}

export async function genres(type: MediaType): Promise<Array<{ id: number; name: string }>> {
  const res = await get<{ genres: Array<{ id: number; name: string }> }>(`/genre/${type}/list`)
  return res.genres
}
