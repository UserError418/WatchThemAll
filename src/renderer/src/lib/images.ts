/**
 * TMDB image URL construction.
 *
 * TMDB serves every image at a fixed set of widths. Requesting the right one
 * matters more here than anywhere else in the app: a browse row holds dozens of
 * posters, and asking for `original` on each is the difference between a view
 * that settles instantly and one that streams tens of megabytes.
 */

const BASE = 'https://image.tmdb.org/t/p'

/** Widths TMDB actually serves. Anything else silently falls back to original. */
export const POSTER_SIZES = ['w154', 'w185', 'w342', 'w500'] as const
export const BACKDROP_SIZES = ['w300', 'w780', 'w1280', 'original'] as const
export const STILL_SIZES = ['w185', 'w300'] as const

export type PosterSize = (typeof POSTER_SIZES)[number]
export type BackdropSize = (typeof BACKDROP_SIZES)[number]
export type StillSize = (typeof STILL_SIZES)[number]

/**
 * Ask IMDB's CDN for a specific width.
 *
 * IMDB encodes transforms in the filename: `...._V1_.jpg` is the full-size
 * original, and inserting directives before the extension resizes it. Without
 * this a search row pulls full-resolution artwork — one poster came back at
 * 2650x4096, which is heavier than the entire rest of the view.
 */
function resizeImdb(absoluteUrl: string, width: number): string {
  return absoluteUrl.replace(/\._V1_.*?\.jpg$/i, `._V1_QL75_UX${width}_.jpg`)
}

/** Widths to request from IMDB, keyed by the TMDB size name we were asked for. */
const IMDB_WIDTHS: Record<string, number> = {
  w154: 154,
  w185: 185,
  w300: 300,
  w342: 342,
  w500: 500,
  w780: 780,
  w1280: 1280,
  original: 1280,
}

function url(path: string | null, size: string): string | null {
  if (!path) return null
  // IMDB search results carry a complete URL rather than a TMDB path fragment.
  // Prefixing the TMDB base onto one produces a 404 that renders as a broken
  // tile, so absolute URLs pass through — resized, but otherwise untouched.
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return resizeImdb(path, IMDB_WIDTHS[size] ?? 342)
  }
  return `${BASE}/${size}${path}`
}

/** Row tiles use w342; it is the smallest size that stays sharp on HiDPI. */
export const posterUrl = (path: string | null, size: PosterSize = 'w342'): string | null =>
  url(path, size)

export const backdropUrl = (path: string | null, size: BackdropSize = 'w1280'): string | null =>
  url(path, size)

export const stillUrl = (path: string | null, size: StillSize = 'w300'): string | null =>
  url(path, size)

/**
 * A `srcset` for poster tiles, so HiDPI displays get the sharper asset without
 * forcing it on everyone.
 */
export function posterSrcset(path: string | null): string | null {
  if (!path) return null
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return [185, 342, 500].map((w) => `${resizeImdb(path, w)} ${w}w`).join(', ')
  }
  return `${BASE}/w185${path} 185w, ${BASE}/w342${path} 342w, ${BASE}/w500${path} 500w`
}
