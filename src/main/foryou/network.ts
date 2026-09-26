/**
 * The TMDB client, as the personal rows' network.
 *
 * One binding for both platforms: the desktop's IPC handler and the phone's
 * bridge each wired up their own copy of this object, and a dependency added to
 * one and not the other is a row that works on one platform only. Kept out of
 * `index.ts` so the planner and its tests never import the network.
 */

import * as tmdb from '../tmdb'
import type { ForYouNetwork } from './deps'

export const tmdbNetwork: ForYouNetwork = {
  recommendations: tmdb.recommendations,
  discover: tmdb.discover,
  keywords: tmdb.keywords,
  originalLanguage: tmdb.originalLanguage,
  genres: tmdb.genres,
}
