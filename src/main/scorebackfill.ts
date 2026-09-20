/**
 * Fill in the TMDB score for titles saved before the app stored one.
 *
 * ## Why this is needed at all
 *
 * Scores are copied into each saved entry rather than fetched when a list
 * renders — that was a deliberate decision, because the alternative is one
 * detail request per saved title every time a view opens, and the same
 * reasoning already governs `genreIds` and `episodeCount`. New entries get
 * their score for free, from the summary they were created from.
 *
 * What that leaves is everything saved *before* the field existed, which for a
 * real library is all of it. Those entries would only ever gain a score by the
 * user happening to open each title one at a time, so the feature would ship
 * looking broken to exactly the people with the most data.
 *
 * ## Why it is safe to do once
 *
 * This is bounded work, not per-render work: one request per title, ever. The
 * result is written to the store, so a title topped up here is never fetched
 * again — and a run that is interrupted simply resumes next launch, because
 * what remains is defined by the data rather than by a cursor.
 *
 * It is deliberately slow. A library of a few hundred titles is a few hundred
 * requests, and firing those as fast as TMDB will take them is how an app gets
 * its key rate-limited for no user-visible gain. Nothing is waiting on it.
 */

import type { MediaType } from '@shared/types'

/** Pause between requests. Nothing waits on this work; being polite is free. */
const GAP_MS = 250

/**
 * How many titles to top up per launch.
 *
 * A cap rather than the whole library at once, so a very large imported
 * catalogue spreads over a few sessions instead of making one launch spend
 * several minutes talking to TMDB. What is left is picked up next time.
 */
const PER_LAUNCH = 120

export interface BackfillTarget {
  tmdbId: number
  type: MediaType
}

export interface BackfillDeps {
  /** Entries missing a score, newest-first is fine — order is not meaningful. */
  pending: () => BackfillTarget[]
  /** Fetch one title's score. Returns 0 when TMDB has none or the call fails. */
  score: (tmdbId: number, type: MediaType) => Promise<number>
  /** Persist one result. Called per title so an interrupted run keeps its work. */
  save: (tmdbId: number, score: number) => void
  wait?: (ms: number) => Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Returns how many scores were actually written. */
export async function backfillScores(deps: BackfillDeps): Promise<number> {
  const wait = deps.wait ?? sleep
  const targets = deps.pending().filter((t) => t.tmdbId > 0).slice(0, PER_LAUNCH)

  let written = 0
  for (const target of targets) {
    let score: number
    try {
      score = await deps.score(target.tmdbId, target.type)
    } catch {
      // A title that cannot be fetched now is simply pending again next
      // launch. Aborting the whole run over one failure would strand every
      // title behind it.
      continue
    }

    if (score > 0) {
      deps.save(target.tmdbId, score)
      written += 1
    }
    await wait(GAP_MS)
  }
  return written
}
