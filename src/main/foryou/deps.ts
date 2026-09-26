/**
 * What the personal rows need from the network, injected rather than imported.
 *
 * Both platforms supply the same TMDB client (`network.ts`); tests supply
 * fakes. Injecting it is what makes every decision in `foryou/` testable
 * without a network.
 */

import type { MediaSummary, MediaType } from '@shared/types'
import type { Paged } from '@shared/ipc'
import type { DiscoverQuery } from '../tmdb'

export interface ForYouDeps {
  recommendations: (tmdbId: number, type: MediaType, page: number) => Promise<Paged<MediaSummary>>
  discover: (type: MediaType, query: DiscoverQuery, page: number) => Promise<Paged<MediaSummary>>
  /** A title's TMDB keywords. Empty when TMDB has none or cannot be reached. */
  keywords: (tmdbId: number, type: MediaType) => Promise<Array<{ id: number; name: string }>>
  /** A title's original language, or null when TMDB cannot say. */
  originalLanguage: (tmdbId: number, type: MediaType) => Promise<string | null>
}

/** Everything a platform supplies: the network, including genre names. */
export interface ForYouNetwork extends ForYouDeps {
  genres: (type: MediaType) => Promise<Array<{ id: number; name: string }>>
}
