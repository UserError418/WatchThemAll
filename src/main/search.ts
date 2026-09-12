/**
 * Unified search across both metadata backends.
 *
 * The two have complementary weaknesses, which is why the original used both
 * and why collapsing to one in cycle 1 was a regression:
 *
 *   TMDB  — rich (artwork, ratings, genres) but its catalogue has gaps, and its
 *           results carry no IMDB id, so playing one costs an extra round trip.
 *   IMDB  — near-total coverage and returns the id providers key on, but the
 *           suggestion payload has no artwork sizes, ratings or genres.
 *
 * So: query both, prefer TMDB's richer record when the same title comes back
 * from each, and let IMDB fill in everything TMDB simply does not have.
 *
 * **Ids are never copied across a fuzzy match.** Titles are matched on name and
 * year, which is good enough to avoid showing the same show twice and *not*
 * good enough to assign an IMDB id to a TMDB record. Getting that wrong would
 * play the wrong programme, which is far worse than an extra request — so a
 * matched TMDB result keeps its own ids and resolves its IMDB id properly when
 * it is opened.
 */

import type { MediaSummary } from '@shared/types'
import type { Paged } from '@shared/ipc'
import * as imdb from './imdb'
import * as tmdb from './tmdb'

/**
 * Reduce a title to something comparable across the two sources.
 *
 * They disagree constantly on punctuation and articles — "Marvel's Daredevil"
 * against "Daredevil", "WALL·E" against "WALL-E". Stripping diacritics and
 * non-alphanumerics catches most of it without the false merges a looser
 * comparison would produce.
 */
function normalize(title: string): string {
  return title
    .normalize('NFKD')
    // Combining marks left behind by NFKD decomposition.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Year, or null. Both sources give `YYYY-MM-DD` after mapping. */
function yearOf(item: MediaSummary): string | null {
  return item.releaseDate ? item.releaseDate.slice(0, 4) : null
}

/**
 * The key two records must share to be considered the same title.
 *
 * Year is part of it because remakes are common and genuinely distinct — the
 * 1978 and 2018 *Suspiria* are not the same film. A record with no year falls
 * back to the title alone, which is the lenient direction: better to merge two
 * records that might differ than to show an obvious duplicate.
 */
function identity(item: MediaSummary): string {
  const year = yearOf(item)
  return year ? `${item.type}:${normalize(item.title)}:${year}` : `${item.type}:${normalize(item.title)}`
}

/** How well a result answers what was actually typed. Lower is better. */
function relevance(item: MediaSummary, normalizedQuery: string): number {
  const title = normalize(item.title)
  if (title === normalizedQuery) return 0
  if (title.startsWith(normalizedQuery)) return 1
  if (title.includes(normalizedQuery)) return 2
  return 3
}

/**
 * Search both backends and merge.
 *
 * Only the first page is federated. TMDB paginates and IMDB does not, so page
 * 2 onwards comes from TMDB alone — merging a fixed IMDB batch into every page
 * would repeat the same results down the list.
 */
export async function search(query: string, page = 1): Promise<Paged<MediaSummary>> {
  const trimmed = query.trim()
  if (!trimmed) return { items: [], page: 1, totalPages: 0 }

  if (page > 1) return tmdb.search(trimmed, page)

  // One backend being down must not take search with it. A partial result the
  // user can act on beats an error message, and this endpoint is undocumented
  // enough that planning for it to vanish is realistic rather than defensive.
  const [tmdbResult, imdbResult] = await Promise.allSettled([
    tmdb.search(trimmed, 1),
    imdb.search(trimmed),
  ])

  const fromTmdb = tmdbResult.status === 'fulfilled' ? tmdbResult.value.items : []
  const fromImdb = imdbResult.status === 'fulfilled' ? imdbResult.value.items : []

  if (tmdbResult.status === 'rejected') console.error('[search] TMDB failed:', tmdbResult.reason)
  if (imdbResult.status === 'rejected') console.error('[search] IMDB failed:', imdbResult.reason)

  const seen = new Set<string>()
  const merged: MediaSummary[] = []

  // TMDB first, so its richer record wins any collision.
  for (const item of [...fromTmdb, ...fromImdb]) {
    const key = identity(item)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(item)
  }

  const normalizedQuery = normalize(trimmed)
  // Stable sort: within equal relevance the TMDB-first ordering above survives.
  merged.sort((a, b) => relevance(a, normalizedQuery) - relevance(b, normalizedQuery))

  return {
    items: merged,
    page: 1,
    // Paging continues against TMDB alone, so its count is the honest one.
    totalPages: tmdbResult.status === 'fulfilled' ? tmdbResult.value.totalPages : 1,
  }
}

/**
 * Fill in the TMDB id for a summary that only has an IMDB id.
 *
 * Everything the detail view shows comes from TMDB, so an IMDB-sourced result
 * has to be bridged before it can be opened. Returns null when TMDB has never
 * heard of the title — which does happen, and is the honest answer rather than
 * a reason to fail the click.
 */
export async function resolve(item: MediaSummary): Promise<MediaSummary | null> {
  if (item.tmdbId > 0) return item
  if (!item.imdbId) return null

  const found = await tmdb.findByImdb(item.imdbId)
  if (!found) return null

  return { ...item, tmdbId: found.tmdbId, type: found.type }
}
