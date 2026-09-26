/**
 * MyAnimeList XML exports.
 *
 * MAL's export is the only bulk source of a user's watch history this app can
 * accept, and it arrives with more information than the existing import format
 * carries: a per-title status (watching, completed, on hold, dropped, plan to
 * watch) and a 0–10 score. Both are worth keeping — the status decides which of
 * our lists a title belongs in, and the score is the only pre-existing signal
 * the recommendation has to work from on a fresh install.
 *
 * ## Why parsing happens without touching TMDB
 *
 * A MAL export routinely holds several hundred titles — the file this was built
 * against has 311. Resolving every one to a TMDB id before showing the user a
 * preview would mean several hundred searches to answer a question they might
 * answer with "cancel", and it would take minutes behind a spinner.
 *
 * So the preview is built from the XML alone. Titles are resolved only for the
 * entries the user actually keeps, at import time, where the work is
 * proportional to what was asked for.
 *
 * ## Why a hand-rolled parser
 *
 * The format is a fixed, flat, machine-generated shape: a repeating `<anime>`
 * block of leaf elements, values in `CDATA` or plain text, no attributes and no
 * nesting to speak of. A DOM parser would be a dependency and a bundling
 * problem in the main process for a document this regular. What it would buy —
 * correctness on arbitrary XML — is not needed, because this is not arbitrary
 * XML, and the failure mode is a title we skip rather than data we corrupt.
 */

import type { RatingValue } from '@shared/types'
import { isRatingValue } from '@shared/rating'

/** The statuses MAL writes, normalised to our own vocabulary. */
export type MalStatus = 'watching' | 'completed' | 'onHold' | 'dropped' | 'planToWatch'

export interface MalEntry {
  /** `series_animedb_id` — MAL's own id, kept so a re-import can be idempotent. */
  malId: number
  title: string
  status: MalStatus
  /** 0 when unrated. MAL scores 1–10. */
  score: number
  /** Episodes the user has watched, and the total, when known. */
  watchedEpisodes: number
  totalEpisodes: number
  /** `TV`, `Movie`, `OVA`, `ONA`, `Special`, `Music`. */
  seriesType: string
}

export interface MalExport {
  /** MAL account the file came from, shown in the preview so the user can confirm. */
  userName: string | null
  entries: MalEntry[]
  /**
   * Entries present in the file that could not be read.
   *
   * Surfaced rather than swallowed: an import that silently drops a tenth of
   * someone's library is worse than one that says it did.
   */
  skipped: number
}

/**
 * MAL's status strings.
 *
 * Matched case-insensitively with punctuation and spacing stripped, because the
 * exact spelling has varied across export versions — `Plan to Watch` and
 * `plantowatch` both appear in files in the wild, and `On-Hold` is written both
 * with and without the hyphen.
 */
const STATUS_BY_NAME: Record<string, MalStatus> = {
  watching: 'watching',
  completed: 'completed',
  onhold: 'onHold',
  dropped: 'dropped',
  plantowatch: 'planToWatch',
}

function readStatus(raw: string): MalStatus | null {
  return STATUS_BY_NAME[raw.toLowerCase().replace(/[^a-z]/g, '')] ?? null
}

/**
 * Pull one leaf element's text out of a block.
 *
 * Handles both `<t>value</t>` and `<t><![CDATA[value]]></t>`; MAL uses CDATA
 * for anything that might contain an ampersand, which for anime titles is often.
 */
function readTag(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)
  if (!match) return null
  const raw = match[1] ?? ''
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw)
  return (cdata ? cdata[1] : raw)?.trim() ?? null
}

function readNumber(block: string, tag: string): number {
  const value = Number(readTag(block, tag))
  return Number.isFinite(value) ? value : 0
}

/**
 * Read an export.
 *
 * Never throws on a malformed *entry* — it is counted in `skipped` and the rest
 * of the file is imported. It does throw when the document is not a MAL export
 * at all, because that is the user picking the wrong file and telling them so
 * is more useful than importing nothing and reporting success.
 */
export function parseMalExport(xml: string): MalExport {
  if (!xml.includes('<myanimelist')) {
    throw new Error('That is not a MyAnimeList export — the file has no <myanimelist> element.')
  }

  const userName = readTag(xml, 'user_name')
  const entries: MalEntry[] = []
  let skipped = 0

  for (const match of xml.matchAll(/<anime>([\s\S]*?)<\/anime>/g)) {
    const block = match[1] ?? ''
    const title = readTag(block, 'series_title')
    const status = readStatus(readTag(block, 'my_status') ?? '')

    // A title and a status are the minimum: without the first there is nothing
    // to search TMDB for, and without the second there is no list to put it in.
    if (!title || !status) {
      skipped += 1
      continue
    }

    entries.push({
      malId: readNumber(block, 'series_animedb_id'),
      title,
      status,
      score: readNumber(block, 'my_score'),
      watchedEpisodes: readNumber(block, 'my_watched_episodes'),
      totalEpisodes: readNumber(block, 'series_episodes'),
      seriesType: readTag(block, 'series_type') ?? 'TV',
    })
  }

  return { userName, entries, skipped }
}

/**
 * Where a MAL status lands by default.
 *
 * The mapping the user asked for, and the reasoning behind the two they did not
 * specify:
 *
 * - `watching` → the watchlist, which is exactly what that list is for.
 * - `completed` → watched.
 * - `planToWatch` → release tracking, so anything still airing announces itself.
 * - `onHold` → the watchlist. A paused show is one they still intend to finish,
 *   and the watchlist keeps the resume position that makes finishing possible.
 * - `dropped` → watched, but **off by default**. They did see part of it, so it
 *   is a real signal for the recommendation, but silently filing 57 abandoned
 *   shows as "watched" would misrepresent a library at a glance.
 */
export type ImportTarget = 'watchlist' | 'watched' | 'releases' | 'skip'

export const DEFAULT_TARGETS: Record<MalStatus, ImportTarget> = {
  watching: 'watchlist',
  completed: 'watched',
  onHold: 'watchlist',
  planToWatch: 'releases',
  dropped: 'watched',
}

/** Which groups start selected. Dropped does not — see `DEFAULT_TARGETS`. */
export const DEFAULT_SELECTED: Record<MalStatus, boolean> = {
  watching: true,
  completed: true,
  onHold: true,
  planToWatch: true,
  dropped: false,
}

/** Human labels, so the renderer does not carry its own copy of the vocabulary. */
export const STATUS_LABELS: Record<MalStatus, string> = {
  watching: 'Watching',
  completed: 'Completed',
  onHold: 'On hold',
  dropped: 'Dropped',
  planToWatch: 'Plan to watch',
}

/**
 * Turn a MAL score into a rating, or nothing.
 *
 * One to one: a MAL 7 is a 7 here. The two scales are the same 1–10 in the
 * same hands, so any remapping would be the app second-guessing the user's
 * own numbers. 0 is MAL's "not scored" and becomes no rating at all, as does
 * anything outside the scale, which a well-formed export never contains.
 *
 * This used to keep only 8 and above (a like) and 5 and below (a dislike), and
 * drop 6 and 7 on the argument that a shrug is not a signal. Two things made
 * that obsolete. The ratings themselves are now 1–10, so a 6 or a 7 is
 * representable rather than having to be rounded to a side. And the taste
 * model centres every rating on the user's own mean, so a 7 from someone
 * whose average is 8 is a mild negative and says something — dropping it
 * threw away exactly the calibration the new model reads.
 *
 * MAL's sentiment reading still holds and still matters, just elsewhere: its
 * community average sits near 7, so a 6 is mild disappointment rather than
 * approval. `ratingBand` in `@shared/rating` draws its bands on that reading.
 */
export function ratingFromScore(score: number): RatingValue | null {
  return isRatingValue(score) ? score : null
}

/**
 * MAL's series types that are not a series.
 *
 * `Movie` is the only one that maps to a film; everything else — TV, ONA, OVA,
 * Special — is episodic as far as TMDB is concerned.
 */
export function mediaTypeFor(seriesType: string): 'tv' | 'movie' {
  return seriesType.trim().toLowerCase() === 'movie' ? 'movie' : 'tv'
}

/**
 * Search terms to try for a MAL title, best first.
 *
 * MyAnimeList and TMDB disagree about what a "title" is, and the disagreement
 * is systematic rather than random. MAL files every season, cour and side story
 * as its own entry — "Vinland Saga Season 2", "Hataraku Maou-sama!! 2nd
 * Season", "Dead Mount Death Play Part 2" — while TMDB models them all as
 * seasons of one series. Searched verbatim, those find nothing at all.
 *
 * Measured on a random 15-title sample of a real 311-entry export, searching
 * the raw title matched 9. Every one of the six misses carried a season or part
 * suffix. So this strips them, progressively, and the caller tries each term
 * until something matches.
 *
 * Order matters and the full title has to be first: "Sword Art Online
 * Alternative: Gun Gale Online" is a real distinct series that matches
 * verbatim, and would resolve to plain "Sword Art Online" if the subtitle were
 * stripped first.
 */
export function searchVariants(title: string): string[] {
  const variants: string[] = [title]

  add(...stripSuffixes(title))

  /**
   * Everything before the first colon or comma, and that stripped in turn.
   *
   * The bluntest variant and the most likely to be wrong — it collapses
   * genuinely separate series onto their parent — so it comes last, only
   * reached when every more precise attempt has already failed. The comma
   * earns its place on light-novel titles, which are a sentence with the hook
   * in front of the first comma and the premise after it, and which TMDB
   * indexes under a much shorter name.
   *
   * The suffix rules are re-applied to the result because the two combine:
   * "JoJo no Kimyou na Bouken Part 3: Stardust Crusaders" needs the subtitle
   * dropped *and* the part number, and neither alone finds anything.
   */
  const cut = [title.indexOf(':'), title.indexOf(',')].filter((index) => index > 1)
  if (cut.length > 0) {
    const base = title.slice(0, Math.min(...cut))
    add(base, ...stripSuffixes(base))
  }

  return variants

  function add(...values: string[]): void {
    for (const value of values) {
      const trimmed = value.trim().replace(/[:\-–—,]+$/, '').trim()
      if (trimmed.length >= 2 && !variants.includes(trimmed)) variants.push(trimmed)
    }
  }
}

/**
 * The suffix patterns MAL adds and TMDB does not know, each anchored to the end.
 *
 * Anchoring is not incidental: unanchored, the season rule would turn "Season
 * of the Witch" into "of the Witch".
 */
const SUFFIX_RULES: readonly RegExp[] = [
  /** "2nd Season", "Season 2", "Part 2", "Cour 2". */
  /\s+(\d+(st|nd|rd|th)\s+Season|Season\s+\d+|Part\s+\d+|Cour\s+\d+)\s*$/i,

  /**
   * Trailing roman numerals, II–XX.
   *
   * Never a bare "I": far too many titles legitimately end in one, and
   * stripping it would corrupt more than it fixed.
   */
  /\s+(I{2,3}|IV|V|VI{0,3}|IX|XI{0,3}|XIV|XV|XVI{0,3}|XIX|XX)\s*$/,

  /** A trailing bare number, as in "Overlord 2". */
  /\s+\d{1,2}\s*$/,

  /**
   * A trailing bare ordinal, as in "…Slow Life suru Koto ni Shimashita 2nd".
   *
   * Separate from the season rule because MAL abbreviates: the word "Season"
   * is dropped often enough to miss otherwise.
   */
  /\s+\d+(st|nd|rd|th)\s*$/i,

  /** A trailing disambiguator, as in "JoJo no Kimyou na Bouken (TV)". */
  /\s*\([^)]*\)\s*$/,
]

/** Every suffix rule applied to `title` independently, in rule order. */
function stripSuffixes(title: string): string[] {
  return SUFFIX_RULES.map((rule) => title.replace(rule, ''))
}

/** The minimum a search result needs for `pickBestMatch` to rank it. */
export interface RankableMatch {
  type: 'tv' | 'movie'
  title: string
  /** TMDB vote count. Absent on results from sources that do not report it. */
  voteCount?: number
  /** TMDB genre ids. Absent, the result counts as not animated. */
  genreIds?: readonly number[]
}

/** TMDB's Animation genre, the same id for films and series. */
const ANIMATION = 16

function isAnimated(result: RankableMatch): boolean {
  return result.genreIds?.includes(ANIMATION) ?? false
}

/** Case, punctuation and spacing removed, so two spellings of one title agree. */
function normaliseTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Choose which search result a MAL title meant.
 *
 * Taking the first result is wrong often enough to matter: searching
 * "Boku no Hero Academia" returns the *Vigilantes* spin-off ahead of My Hero
 * Academia itself, so a 311-title import files the wrong show and every
 * recommendation built on it inherits the error.
 *
 * **Only animation is considered when there is any**, because every entry on
 * a MyAnimeList is anime. Without this, rule 1 below took whatever carried
 * the romanised title: on a real 311-entry export 6 picks were not
 * animation, and all 6 were wrong. There were three 0-vote stub entries
 * ("Tate no Yuusha no Nariagari" instead of The Rising of the Shield Hero),
 * a live-action film ("Grand Blue"), and an American crime drama ("Golden
 * Boy", beside the 1995 anime of the same name). The real anime sat in the
 * same results every time. With no animated result at all, everything is
 * considered as before.
 *
 * Then two rules, in order, and the order is the whole design:
 *
 * 1. **An exact title match wins outright.** "Sword Art Online Alternative:
 *    Gun Gale Online" is a real distinct series far less known than plain Sword
 *    Art Online — ranking by stature first would resolve it to its own parent.
 *    When the user's title *is* a title TMDB knows, there is nothing to guess.
 * 2. **Otherwise the most-voted-on result of the right media type.** With no
 *    exact match the query is a romanisation, and among the shows TMDB thinks
 *    are plausible, the famous one is overwhelmingly the one a MAL list means.
 *
 *    Vote *count*, not TMDB's `popularity` and not `vote_average`. Popularity
 *    was tried and measured wrong — it is a trending score, and it ranked the
 *    currently-airing My Hero Academia spin-off (24.8) above My Hero Academia
 *    itself (22.7). Vote average is worse still: an obscure title with nine
 *    ecstatic votes outscores a classic. How many people bothered to rate it is
 *    the only one of the three that means "this is the well-known one".
 *
 * Media type filters both rules rather than gating them, because an anime
 * film and the series it was cut from often share a name and TMDB does not
 * always agree with MAL about which is which. A wrong-typed match beats no
 * match at all. Among several exact titles the requested type wins: "Mob
 * Psycho 100" is a series and a film.
 */
export function pickBestMatch<T extends RankableMatch>(
  term: string,
  type: 'tv' | 'movie',
  results: readonly T[],
): T | null {
  if (results.length === 0) return null

  const animated = results.filter(isAnimated)
  const candidates = animated.length > 0 ? animated : results

  const exact = candidates.filter((r) => isExactMatch(term, r))
  if (exact.length > 0) return exact.find((r) => r.type === type) ?? exact[0]!

  const sameType = candidates.filter((r) => r.type === type)
  const pool = sameType.length > 0 ? sameType : candidates

  return pool.reduce((best, r) => ((r.voteCount ?? 0) > (best.voteCount ?? 0) ? r : best))
}

function isExactMatch(term: string, result: RankableMatch): boolean {
  return normaliseTitle(result.title) === normaliseTitle(term)
}

/**
 * Resolve one MAL title: try each of its `searchVariants` in turn and pick
 * the result it meant. The whole resolver apart from the network, shared by
 * the desktop and the phone so the two cannot resolve a list differently.
 *
 * Stops at the first term whose pick is animated and either the requested
 * type or an exact title. Any other pick is only the best of a bad lot, and
 * is held back while the shorter terms are tried. The full title often finds *only* a film cut
 * from the series: "Shingeki no Kyojin Season 3" returns a recap film and
 * nothing else, while "Shingeki no Kyojin" finds the series. Stopping at the
 * first term that found anything filed that film, and two more like it, as
 * the anime on one real library. A held-back pick still wins when no term
 * finds anything better (see `pickBestMatch`).
 */
export async function findBestMatch<T extends RankableMatch>(
  title: string,
  type: 'tv' | 'movie',
  search: (term: string) => Promise<readonly T[]>,
): Promise<T | null> {
  let fallback: T | null = null
  for (const term of searchVariants(title)) {
    const best = pickBestMatch(term, type, await search(term))
    if (!best) continue
    if (isAnimated(best) && (best.type === type || isExactMatch(term, best))) return best
    fallback ??= best
  }
  return fallback
}
