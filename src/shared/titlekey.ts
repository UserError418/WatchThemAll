/**
 * The key for a *title*, ignoring which episode: `tv:tt0903747`, or
 * `movie:tmdb550` for a title TMDB knows no IMDB id for.
 *
 * Every test result, play and preview is filed under it, and every reader of
 * them looks it up by it (`sourceresults.ts`). Episode-level keys exist too
 * (`outcomes.mediaKey`), because coverage is episode-level: a provider
 * routinely carries a series' first season and not its fourth. But the source
 * picker is answering a coarser question — "does this provider work for this
 * show" — and an episode-level answer would leave almost every dot blank, since
 * the user is rarely re-picking a source for an episode they have already
 * watched.
 *
 * Here rather than in `main/outcomes.ts`, where it began and from where it is
 * still exported, so the renderer can name a title the way its results are
 * filed: `resultsChanged` and a test run's progress say which titles they are
 * about by this key, and a source list compares it with its own title's. One
 * definition, imported, rather than a second one written in the renderer that
 * agrees until the day someone changes the separator.
 */
export function titleKey(req: {
  type: 'tv' | 'movie'
  imdbId: string | null
  tmdbId: number
}): string {
  const id = req.imdbId || `tmdb${req.tmdbId}`
  return `${req.type}:${id}`
}
