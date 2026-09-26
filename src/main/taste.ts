/**
 * What the user seems to like: the taste profile behind every personalised row
 * on Browse.
 *
 * Pure functions over the store document, deliberately. The scoring is the part
 * most likely to be tuned again, and a function from a document to numbers is
 * something a test can pin down exactly — including the property that matters
 * most, that a different history produces a different answer.
 *
 * ## The model in one paragraph
 *
 * Every title the user has touched gets an **affinity**: a signed number saying
 * how strongly it represents their taste. A rated title's affinity comes from
 * the rating, *centred on the user's own average* and amplified by how much of
 * it they actually watched. An unrated title's comes from behaviour alone —
 * seasons watched, hours played, whether they follow it for new episodes —
 * and is capped below what an explicit rating can reach. Genres then inherit
 * affinity from the titles that carry them. `foryou.ts` turns both into rows.
 *
 * ## Why ratings are centred on the user
 *
 * A 7 means different things from different people. Someone who rates
 * everything 8 or above is disappointed by a 7; someone whose average is 5 is
 * pleased. Comparing each rating with the user's own mean, and dividing by how
 * widely they spread their ratings, turns "7" into "a bit below what this person
 * usually gives" — which is the only reading a recommendation can use. Both
 * statistics are shrunk towards a neutral prior, so three ratings do not define
 * a scale.
 *
 * Ratings converted from the old like/dislike (`coarse`) go through the same
 * arithmetic. They say less — every like is an 8 — but they say it in the same
 * units, so the profile works identically before and after the user starts
 * rating on the 1–10 scale, and simply sharpens as they do.
 *
 * ## Why behaviour is capped below an explicit rating
 *
 * Watching is evidence, not a verdict. Finishing five seasons of something is a
 * strong hint and still weaker than "I rate this 9", so implicit affinity tops
 * out at `IMPLICIT_CAP` — roughly what an above-average rating is worth. Without
 * the cap one long-running comfort show outranks every stated favourite.
 */

import type {
  LegacyRating,
  MediaType,
  StoreShape,
  TitleRating,
} from '@shared/types'
import { isRatingValue, valueOfLegacy } from '@shared/rating'
import { isListed } from '@shared/listed'

/** Everything the profile reads. */
export type TasteStore = Pick<StoreShape, 'ratings' | 'watched' | 'watchlist' | 'history' | 'trackers'>

/**
 * A title's identity across collections.
 *
 * Type and id together: TMDB numbers films and series in separate spaces, so
 * the same number can be both, and keying on the number alone would let a
 * liked film lend its affinity to an unrelated series.
 */
export function titleId(type: MediaType, tmdbId: number): string {
  return `${type}:${tmdbId}`
}

/* ── The user's rating scale ─────────────────────────────────────────────── */

/** One verdict per title, however many records express it. */
export interface Verdict {
  /** 1–10, or a mean of season ratings, so not necessarily whole. */
  value: number
  /** True when every rating it was drawn from was converted from a thumb. */
  coarse: boolean
}

/**
 * The prior a user's scale is shrunk towards, and how many ratings it is worth.
 *
 * 6.5 and 2 describe someone who uses most of the range with a slight positive
 * lean — which is how people rate what they chose to watch. Five ratings' worth
 * of weight means the prior dominates a new user's first few verdicts and has
 * all but vanished by the fiftieth.
 */
export const SCALE_PRIOR = { mean: 6.5, spread: 2, weight: 5 } as const

/**
 * The most a centred rating can count for, either way.
 *
 * Someone who rates nearly everything 8 turns a single 3 into a huge outlier.
 * It should be the strongest signal they have ever given, not one that
 * outweighs the rest of the profile several times over.
 */
const MAX_DEVIATION = 2.5

/**
 * What the user thinks of each title, as one value.
 *
 * A title can carry a whole-series rating and a rating per season. The rule for
 * combining them, in order:
 *
 * 1. **Chosen beats converted.** If any rating for the title was set on the
 *    1–10 scale, converted thumbs for the same title are ignored — a deliberate
 *    6 for season 3 says more than an up-converted 8 from last year.
 * 2. **The whole-title rating beats the seasons**, among what is left. It is
 *    the user's own summary; a mean of the seasons is our reconstruction.
 * 3. Otherwise the **mean of the season ratings**.
 */
export function titleVerdicts(ratings: readonly TitleRating[]): Map<string, Verdict> {
  const byTitle = new Map<string, Array<{ value: number; coarse: boolean; whole: boolean }>>()

  for (const r of ratings) {
    const value = readValue(r)
    if (value === null || !r.tmdbId) continue
    const id = titleId(r.type, r.tmdbId)
    const list = byTitle.get(id) ?? []
    // A record with no `value` was written by an old build, so its value was
    // just converted from a thumb in `readValue` — coarse by definition.
    const coarse = !isRatingValue(r.value) || r.coarse === true
    list.push({ value, coarse, whole: (r.season ?? null) === null })
    byTitle.set(id, list)
  }

  const verdicts = new Map<string, Verdict>()
  for (const [id, list] of byTitle) {
    const chosen = list.filter((r) => !r.coarse)
    const pool = chosen.length > 0 ? chosen : list
    const whole = pool.find((r) => r.whole)
    const value = whole ? whole.value : pool.reduce((sum, r) => sum + r.value, 0) / pool.length
    verdicts.set(id, { value, coarse: chosen.length === 0 })
  }
  return verdicts
}

/**
 * The rating a record holds, tolerating one written by an old build.
 *
 * The store migration fills in `value` on load, so in the running app this is
 * always the first branch. The fallback exists because the profile is a pure
 * function over whatever document it is handed, and a test fixture or a
 * document merged from an older device should not silently lose its opinions.
 */
function readValue(r: TitleRating): number | null {
  if (isRatingValue(r.value)) return r.value
  const legacy = r.rating as LegacyRating | undefined
  return legacy === 'like' || legacy === 'dislike' ? valueOfLegacy(legacy) : null
}

export interface RatingScale {
  mean: number
  spread: number
}

/** The user's own average and spread, shrunk towards `SCALE_PRIOR`. */
export function ratingScale(verdicts: ReadonlyMap<string, Verdict>): RatingScale {
  const values = [...verdicts.values()].map((v) => v.value)
  const n = values.length
  const k = SCALE_PRIOR.weight

  const sampleMean = n > 0 ? values.reduce((a, b) => a + b, 0) / n : SCALE_PRIOR.mean
  const mean = (n * sampleMean + k * SCALE_PRIOR.mean) / (n + k)

  const sampleVar = n > 0 ? values.reduce((a, v) => a + (v - sampleMean) ** 2, 0) / n : 0
  const variance = (n * sampleVar + k * SCALE_PRIOR.spread ** 2) / (n + k)

  return { mean, spread: Math.sqrt(variance) }
}

/** How far a verdict sits from the user's usual, in their own units. */
export function centred(value: number, scale: RatingScale): number {
  const z = (value - scale.mean) / scale.spread
  return Math.max(-MAX_DEVIATION, Math.min(MAX_DEVIATION, z))
}

/* ── Engagement: what the user actually did ──────────────────────────────── */

export interface Engagement {
  /** Seasons marked watched; a whole-title watched entry counts as one. */
  seasons: number
  /** Hours the player actually ran, from `history`. */
  hours: number
  /** Episodes ticked off on the watchlist entry. */
  episodes: number
  onWatchlist: boolean
  /** Followed in Releases: the user wants to know when more of it airs. */
  tracked: boolean
  /** The last time the user demonstrably watched it, or 0. */
  lastActive: number
}

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/**
 * Roughly how long an episode runs, for turning ticked-off episodes into hours.
 *
 * Episodes marked on the watchlist and hours in `history` overlap — playing an
 * episode in the app does both — so they are never added together. The larger
 * of the two stands, and this converts one into the other's units. Forty
 * minutes splits the difference between a 24-minute anime episode and an
 * hour-long drama.
 */
const HOURS_PER_EPISODE = 0.66

function emptyEngagement(): Engagement {
  return { seasons: 0, hours: 0, episodes: 0, onWatchlist: false, tracked: false, lastActive: 0 }
}

/** Everything the user did with each title, gathered from four collections. */
export function engagementByTitle(store: TasteStore): Map<string, Engagement> {
  const out = new Map<string, Engagement>()
  const at = (type: MediaType, tmdbId: number): Engagement | null => {
    if (!tmdbId) return null
    const id = titleId(type, tmdbId)
    let e = out.get(id)
    if (!e) {
      e = emptyEngagement()
      out.set(id, e)
    }
    return e
  }

  for (const w of store.watched) {
    const e = at(w.type, w.tmdbId)
    if (!e) continue
    e.seasons += 1
    // Only a user's own "I watched this" dates a watch. An import's `addedAt`
    // is the day of the import, and would make three hundred titles look as
    // if they were all watched last Tuesday.
    if (w.source === 'user') e.lastActive = Math.max(e.lastActive, w.addedAt)
  }

  for (const play of store.history) {
    const e = at(play.type, play.tmdbId)
    if (!e) continue
    e.hours += (play.playedMs ?? 0) / HOUR_MS
    e.lastActive = Math.max(e.lastActive, play.watchedAt)
  }

  for (const entry of store.watchlist) {
    const e = at(entry.type, entry.tmdbId)
    if (!e) continue
    // An unlisted entry holds ticks, which are real viewing and count below;
    // it is not the user saving the title. See `WatchlistEntry.listed`.
    e.onWatchlist = isListed(entry)
    for (const mark of Object.values(entry.episodeMarks ?? {})) {
      if (!mark.watched) continue
      e.episodes += 1
      e.lastActive = Math.max(e.lastActive, mark.at)
    }
  }

  // Release trackers are series-only; the type is not stored because it
  // cannot be anything else.
  for (const tracker of store.trackers) {
    const e = at('tv', tracker.tmdbId)
    if (e) e.tracked = true
  }

  return out
}

/**
 * How much time and attention went into a title, on a 0–3 scale.
 *
 * Square roots throughout, for the same reason the old profile damped hours:
 * the first season of a show says far more than the ninth, and a linear count
 * turns one 20-season sitcom into the whole profile.
 */
export function investment(e: Engagement): number {
  const seasons = Math.sqrt(Math.min(e.seasons, 10))
  const hours = Math.sqrt(Math.max(e.hours, e.episodes * HOURS_PER_EPISODE))
  return Math.min(3, 0.5 * seasons + 0.35 * hours)
}

/**
 * A title the user started and walked away from.
 *
 * Only when every one of these holds: they played it for at least a few minutes
 * (less is a source that failed to load, not a decision), for well under an
 * episode in total, not for two weeks, and did nothing else with it — no
 * watched mark, not saved, not followed. Rated titles never get here: a
 * verdict outranks any inference from behaviour. Anything else is either
 * still in progress or already explained by a stronger signal.
 */
export const ABANDONED = {
  minMinutes: 3,
  maxMinutes: 25,
  quietDays: 14,
} as const

function isAbandoned(e: Engagement, now: number): boolean {
  const minutes = e.hours * 60
  return (
    e.seasons === 0 &&
    !e.onWatchlist &&
    !e.tracked &&
    minutes >= ABANDONED.minMinutes &&
    minutes < ABANDONED.maxMinutes &&
    now - e.lastActive > ABANDONED.quietDays * DAY_MS
  )
}

/* ── Affinity: which titles represent this person ─────────────────────────── */

/**
 * The weights of the implicit signals, and the ceiling on their sum.
 *
 * Ordinal judgements rather than fitted values — there is nothing to fit them
 * against on a single user's install. What they encode is the ordering: being
 * followed for new episodes is stronger than being saved, and neither on its
 * own should be able to seed a "Because you watched" row ahead of a title the
 * user sat through.
 */
export const IMPLICIT = {
  perInvestment: 0.45,
  watchlist: 0.25,
  tracked: 0.4,
  abandoned: -0.5,
} as const
export const IMPLICIT_CAP = 1.2

/**
 * How much watching amplifies a stated opinion.
 *
 * A 9 on a show the user put forty hours into is a stronger statement than a
 * 9 on a film, so positive affinity grows with investment. A negative one
 * *shrinks* with it: someone who sat through five seasons and rates it 4 was
 * disappointed by something close to their taste, which is a much milder
 * "not this" than a 4 on something they abandoned after an episode.
 */
const INVESTMENT_GAIN = 0.3

export interface TitleAffinity {
  tmdbId: number
  type: MediaType
  /** Signed. Positive: more like this. Negative: less. */
  score: number
  /** The user's verdict, when they gave one. */
  verdict: Verdict | null
  genreIds: number[]
  engagement: Engagement
}

/**
 * Every title the user has touched, scored, strongest first.
 *
 * Negative scores are kept — `foryou.ts` uses the most negative titles to push
 * down candidates they point at, and genres inherit the sign — but zero-score
 * titles are dropped, since they say nothing.
 */
export function titleAffinity(store: TasteStore, now = Date.now()): TitleAffinity[] {
  const verdicts = titleVerdicts(store.ratings)
  const scale = ratingScale(verdicts)
  const engagement = engagementByTitle(store)
  const genres = genresByTitle(store)

  const ids = new Set([...verdicts.keys(), ...engagement.keys()])
  const out: TitleAffinity[] = []

  for (const id of ids) {
    const [type, raw] = id.split(':') as [MediaType, string]
    const e = engagement.get(id) ?? emptyEngagement()
    const verdict = verdicts.get(id) ?? null
    const invested = investment(e)

    let score: number
    if (verdict) {
      const deviation = centred(verdict.value, scale)
      score = deviation >= 0
        ? deviation * (1 + INVESTMENT_GAIN * invested)
        : deviation / (1 + INVESTMENT_GAIN * invested)
    } else if (isAbandoned(e, now)) {
      score = IMPLICIT.abandoned
    } else {
      score = Math.min(
        IMPLICIT_CAP,
        IMPLICIT.perInvestment * invested +
          (e.onWatchlist ? IMPLICIT.watchlist : 0) +
          (e.tracked ? IMPLICIT.tracked : 0),
      )
    }

    if (score === 0) continue
    out.push({
      tmdbId: Number(raw),
      type,
      score,
      verdict,
      genreIds: genres.get(id) ?? [],
      engagement: e,
    })
  }

  return out.sort((a, b) => b.score - a.score || a.tmdbId - b.tmdbId)
}

/**
 * TMDB genre ids per title, from whichever record carries them.
 *
 * Ratings, watched entries and watchlist entries all copy the genres in when
 * they are written — so the profile needs no lookups — but not every title has
 * every kind of record, and history entries carry none.
 */
function genresByTitle(store: TasteStore): Map<string, number[]> {
  const out = new Map<string, number[]>()
  const take = (type: MediaType, tmdbId: number, genreIds: number[] | undefined): void => {
    if (!tmdbId || !genreIds?.length) return
    const id = titleId(type, tmdbId)
    if (!out.has(id)) out.set(id, genreIds)
  }
  for (const r of store.ratings) take(r.type, r.tmdbId, r.genreIds)
  for (const w of store.watched) take(w.type, w.tmdbId, w.genreIds)
  for (const w of store.watchlist) take(w.type, w.tmdbId, w.genreIds)
  return out
}

/* ── Genres ──────────────────────────────────────────────────────────────── */

/**
 * TMDB's genre lists for films and series overlap but are not the same list.
 *
 * Series have "Action & Adventure" where films have "Action" and "Adventure",
 * and "Sci-Fi & Fantasy" where films have two. A profile that kept them apart
 * would split one taste in two and let the user's films and series vote
 * against each other. So each genre maps to a **concept** — the series id
 * where one exists, since the series genres are the coarser of the two — and
 * the profile, the shelves and the scoring all work in concepts.
 */
const MOVIE_TO_CONCEPT: Readonly<Record<number, number>> = {
  28: 10759, // Action → Action & Adventure
  12: 10759, // Adventure → Action & Adventure
  878: 10765, // Science Fiction → Sci-Fi & Fantasy
  14: 10765, // Fantasy → Sci-Fi & Fantasy
  10752: 10768, // War → War & Politics
}

/** Film genres that answer a concept, for asking TMDB's film catalogue. */
const CONCEPT_TO_MOVIE: Readonly<Record<number, number[]>> = {
  10759: [28, 12],
  10765: [878, 14],
  10768: [10752],
}

/** Concepts only one catalogue has, so the other cannot be asked about them. */
const SERIES_ONLY = new Set([10762, 10763, 10764, 10766, 10767]) // Kids, News, Reality, Soap, Talk
const FILM_ONLY = new Set([27, 53, 10749, 36, 10402, 10770]) // Horror, Thriller, Romance, History, Music, TV Movie

export function conceptOf(genreId: number): number {
  return MOVIE_TO_CONCEPT[genreId] ?? genreId
}

export function conceptsOf(genreIds: readonly number[]): number[] {
  return [...new Set(genreIds.map(conceptOf))]
}

/**
 * The genre ids to ask one catalogue for, for a concept, or null when that
 * catalogue has no such genre.
 */
export function genresFor(concept: number, type: MediaType): number[] | null {
  if (type === 'tv') return FILM_ONLY.has(concept) ? null : [concept]
  if (SERIES_ONLY.has(concept)) return null
  return CONCEPT_TO_MOVIE[concept] ?? [concept]
}

export interface ConceptAffinity {
  /** One concept, or two for a "both of these" shelf. */
  concepts: number[]
  score: number
  /** How many titles with a non-zero affinity carry all of `concepts`. */
  titles: number
}

/**
 * How much the user likes each genre, and each pair of genres.
 *
 * A sum crowns whatever genre is most common in the catalogue — nearly
 * everything is a Drama — and a mean crowns a genre on the strength of two
 * titles. Dividing the sum by the square root of the count sits between them:
 * a genre needs both consistency and some volume to lead.
 *
 * Pairs are what make the shelves granular. "Animation" is a genre; "Animation
 * with Action & Adventure" is a taste, and for someone whose library is mostly
 * anime it is a far better shelf than either half. Pairs are only considered
 * when enough positively-scored titles share them, or every coincidence in a
 * small library becomes a shelf.
 */
export const MIN_PAIR_TITLES = 4

export function conceptAffinity(titles: readonly TitleAffinity[]): {
  singles: ConceptAffinity[]
  pairs: ConceptAffinity[]
} {
  const singles = new Map<number, { sum: number; n: number }>()
  const pairs = new Map<string, { concepts: number[]; sum: number; n: number; liked: number }>()

  for (const t of titles) {
    const concepts = conceptsOf(t.genreIds).sort((a, b) => a - b)
    for (const c of concepts) {
      const acc = singles.get(c) ?? { sum: 0, n: 0 }
      acc.sum += t.score
      acc.n += 1
      singles.set(c, acc)
    }
    for (let i = 0; i < concepts.length; i += 1) {
      for (let j = i + 1; j < concepts.length; j += 1) {
        const pair = [concepts[i]!, concepts[j]!]
        const key = pair.join('+')
        const acc = pairs.get(key) ?? { concepts: pair, sum: 0, n: 0, liked: 0 }
        acc.sum += t.score
        acc.n += 1
        if (t.score > 0) acc.liked += 1
        pairs.set(key, acc)
      }
    }
  }

  const score = (sum: number, n: number): number => sum / Math.sqrt(n + 1)
  const byScore = (a: ConceptAffinity, b: ConceptAffinity): number =>
    b.score - a.score || a.concepts.join().localeCompare(b.concepts.join())

  return {
    singles: [...singles]
      .map(([c, { sum, n }]) => ({ concepts: [c], score: score(sum, n), titles: n }))
      .sort(byScore),
    pairs: [...pairs.values()]
      .filter((p) => p.liked >= MIN_PAIR_TITLES)
      .map((p) => ({ concepts: p.concepts, score: score(p.sum, p.n), titles: p.n }))
      .sort(byScore),
  }
}

/**
 * A lookup from concept to affinity, scaled so the strongest is ±1.
 *
 * Scaled because it is combined with other terms when scoring a candidate, and
 * the raw numbers grow with library size — without this a big library would
 * let genre fit drown out everything else.
 */
export function normalisedGenreFit(singles: readonly ConceptAffinity[]): Map<number, number> {
  const max = Math.max(0, ...singles.map((s) => Math.abs(s.score)))
  const out = new Map<number, number>()
  if (max === 0) return out
  for (const s of singles) out.set(s.concepts[0]!, s.score / max)
  return out
}

/**
 * How well a candidate's genres match the profile, from −1 to 1.
 *
 * Averaged over the candidate's concepts (with a square root, so a title with
 * five genres is not diluted to nothing by the three the user is indifferent
 * to).
 */
export function genreFit(genreIds: readonly number[], fit: ReadonlyMap<number, number>): number {
  const concepts = conceptsOf(genreIds)
  if (concepts.length === 0) return 0
  const sum = concepts.reduce((acc, c) => acc + (fit.get(c) ?? 0), 0)
  return Math.max(-1, Math.min(1, sum / Math.sqrt(concepts.length)))
}

/**
 * Concepts the user has clearly turned against, for `without_genres`.
 *
 * Conservative on purpose — excluding a genre removes titles outright rather
 * than ranking them lower, so it needs a clearly negative score from more than
 * a couple of titles.
 */
export function avoidedConcepts(singles: readonly ConceptAffinity[]): number[] {
  const max = Math.max(0, ...singles.map((s) => Math.abs(s.score)))
  if (max === 0) return []
  return singles
    .filter((s) => s.titles >= 3 && s.score / max <= -0.35)
    .map((s) => s.concepts[0]!)
}

/* ── What not to recommend ────────────────────────────────────────────────── */

/**
 * Titles no personalised row may suggest: anything the user has saved, seen,
 * rated, followed or played.
 *
 * A "for you" row whose first card is a show sitting in the watchlist reads as
 * broken, and is the single most common way such a row discredits itself.
 */
export function ownedTitles(store: TasteStore): Set<string> {
  const ids = new Set<string>()
  const add = (type: MediaType, tmdbId: number): void => {
    if (tmdbId) ids.add(titleId(type, tmdbId))
  }
  for (const e of store.watchlist) add(e.type, e.tmdbId)
  for (const e of store.watched) add(e.type, e.tmdbId)
  for (const r of store.ratings) add(r.type, r.tmdbId)
  for (const p of store.history) add(p.type, p.tmdbId)
  for (const t of store.trackers) add('tv', t.tmdbId)
  return ids
}

/* ── Titles, for headings ─────────────────────────────────────────────────── */

/** A display title per title id, from whichever record has one. */
export function titleNames(store: TasteStore): Map<string, string> {
  const out = new Map<string, string>()
  const take = (type: MediaType, tmdbId: number, title: string | undefined): void => {
    if (!tmdbId || !title) return
    const id = titleId(type, tmdbId)
    if (!out.has(id)) out.set(id, title)
  }
  for (const e of store.watchlist) take(e.type, e.tmdbId, e.title)
  for (const e of store.watched) take(e.type, e.tmdbId, e.title)
  for (const p of store.history) take(p.type, p.tmdbId, p.title)
  for (const t of store.trackers) take('tv', t.tmdbId, t.title)
  return out
}
