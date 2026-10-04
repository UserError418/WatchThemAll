/**
 * Whether the detail view's main button can play the title.
 *
 * Once TMDB's record has loaded, always. Without one it still can when the
 * title is one TMDB does not carry (`degraded`: an IMDB search result that
 * `/find` could not match), because providers key on the IMDB id. The button
 * used to wait for TMDB's record regardless, and the manual season/episode
 * controls that stand in for it exist for series only, so such a film had
 * nothing to press at all.
 */
export function canPlay(state: { detailLoaded: boolean; degraded: boolean }): boolean {
  return state.detailLoaded || state.degraded
}
