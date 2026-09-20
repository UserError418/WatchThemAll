/**
 * Scores, and what counts as having one.
 *
 * Every score in this app is TMDB's `vote_average` on a 0–10 scale. That is a
 * deliberate choice rather than an accident of what was available: the number
 * already arrives with every summary, every detail and every episode, so it
 * costs nothing to show, needs no API key and cannot rate-limit. The app's
 * `imdb.ts` is a *search* client and returns no ratings at all — showing real
 * IMDb numbers would mean a new data source, and that is a separate decision.
 *
 * ## Zero is not a score
 *
 * TMDB reports `0` for anything nobody has rated, which is most unaired
 * episodes and a fair number of obscure titles. Drawing that as "0.0" is a
 * confident lie — it reads as *rated, and terrible*, rather than *not rated*.
 * Everything here treats 0 as absent, and the UI draws nothing for it.
 */

/** Whether there is a score worth drawing. */
export function hasScore(rating: number | null | undefined): boolean {
  return typeof rating === 'number' && Number.isFinite(rating) && rating > 0
}

/** `8.4`. One decimal, which is the precision TMDB's own numbers deserve. */
export function formatScore(rating: number): string {
  return rating.toFixed(1)
}

/**
 * A season's score, averaged from its episodes.
 *
 * TMDB has no season-level `vote_average` in the payload this app fetches, and
 * asking for one would be an extra request per season purely to draw a number.
 * The mean of the episodes that *have* been rated is the honest alternative:
 * unrated episodes are left out rather than counted as zero, which would drag
 * every currently-airing season down as its unaired episodes accumulate.
 *
 * Returns 0 — "no score" — when nothing in the season has been rated.
 */
export function seasonScore(episodes: ReadonlyArray<{ rating: number }>): number {
  const rated = episodes.filter((e) => hasScore(e.rating))
  if (rated.length === 0) return 0
  return rated.reduce((sum, e) => sum + e.rating, 0) / rated.length
}
