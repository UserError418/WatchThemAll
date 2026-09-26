/**
 * Domain types shared by the main process, the preload bridge and the renderer.
 *
 * This file is the single definition of what the app's data *is*. Main and
 * renderer both import it, so a change here breaks compilation on both sides
 * rather than at runtime on one of them — which is the whole point.
 */

/* ── Media ──────────────────────────────────────────────────────────────── */

/** TMDB distinguishes these two, and so must we: the URL templates differ. */
export type MediaType = 'tv' | 'movie'

/**
 * The shape a browse tile or search result needs. Deliberately smaller than
 * TMDB's response — carrying the full payload around the IPC boundary and into
 * every tile component is how the old app ended up shipping megabytes into the
 * renderer to render a poster and a title.
 */
export interface MediaSummary {
  /**
   * 0 means "not resolved yet". IMDB search results and entries migrated from
   * the original app both arrive without one; it is filled in on demand via
   * TMDB's `/find` endpoint the first time the title is opened.
   */
  tmdbId: number
  type: MediaType
  title: string
  /**
   * Either a TMDB path fragment (`/abc123.jpg`) or an absolute URL, because
   * IMDB search returns fully-formed image URLs on its own CDN. `posterUrl()`
   * handles both — do not concatenate this onto a base by hand.
   */
  posterPath: string | null
  backdropPath: string | null
  overview: string
  /** TMDB `vote_average`, 0–10. */
  rating: number
  /**
   * TMDB `vote_count` — how many people rated it, not how highly.
   *
   * Carried for one job: disambiguating a bulk import, where a search term
   * matches both a well-known series and its obscure spin-off. It is a measure
   * of *stature*, which is what that decision needs. TMDB's `popularity` field
   * was tried first and is measurably wrong for it — being a trending score, it
   * ranked the currently-airing My Hero Academia spin-off (24.8) above My Hero
   * Academia itself (22.7). Vote counts do not swing with the airing schedule.
   *
   * Optional because results from IMDB search and older stores have none.
   */
  voteCount?: number
  /** `YYYY-MM-DD`, or null when TMDB has no date yet. */
  releaseDate: string | null
  genreIds: number[]
  /**
   * Set when the result came from IMDB search, which returns the id directly.
   * TMDB-sourced summaries leave it undefined and resolve it in `detail()`.
   *
   * This is the id providers actually key on, so carrying it from search all
   * the way to playback is what lets a title play without a TMDB round trip.
   */
  imdbId?: string | null
  /** Which backend produced this result. Drives dedupe when the two are merged. */
  source?: 'tmdb' | 'imdb'
  /**
   * TMDB `original_language`, an ISO 639-1 code (`ja`, `en`). Browse needs it
   * to tell anime from other animation: TMDB files both under Animation, and
   * the language is the one field that separates them.
   *
   * Optional because IMDB results and titles stored before it was carried have
   * none.
   */
  originalLanguage?: string
}

/** Everything the detail view needs, fetched on demand. */
export interface MediaDetail extends MediaSummary {
  /** Needed to build provider URLs — providers key off IMDB, not TMDB. */
  imdbId: string | null
  genres: string[]
  status: string
  seasonCount: number
  episodeCount: number
  /** Minutes. TMDB reports an array for TV; we take the first entry. */
  runtime: number | null
  nextEpisode: EpisodeStub | null
  lastEpisode: EpisodeStub | null
  /**
   * YouTube video key for the billboard's autoplaying trailer, or null when
   * TMDB has no usable trailer. Only the key — the renderer builds the embed
   * URL, because the origin it is allowed to load from is a CSP concern.
   */
  trailerKey: string | null
  /**
   * The title's logo — its name as artwork, on a transparent background — or
   * null when TMDB has none in English. Drawn over wide artwork, which never
   * carries the title, the way a streaming service's cards do.
   */
  logoPath: string | null
}

/** The compact episode reference TMDB embeds in a show payload. */
export interface EpisodeStub {
  season: number
  episode: number
  name: string
  /** `YYYY-MM-DD`, or null if TMDB has the episode but not its date. */
  airDate: string | null
}

export interface Episode extends EpisodeStub {
  overview: string
  /** Episode thumbnail path fragment; null for unaired episodes. */
  stillPath: string | null
  runtime: number | null
  rating: number
}

export interface Season {
  season: number
  name: string
  episodes: Episode[]
}

/* ── Providers ──────────────────────────────────────────────────────────── */

/**
 * A provider is a URL template. `{imdb}`, `{tmdb}`, `{season}` and `{episode}`
 * are substituted at play time; `{rootUrl}` is substituted from `rootUrl`.
 *
 * Carried over unchanged from the original app. It is the one piece of the old
 * design that was right: providers change domains constantly, and a template is
 * the cheapest thing to edit when one does.
 */
export interface Provider {
  id: string
  name: string
  rootUrl: string
  tv: { urlTemplate: string } | null
  movie: { urlTemplate: string } | null
  /** `core` providers are enabled by default; `extras` are opt-in. */
  tier?: 'core' | 'extras'
  /**
   * Providers that resolve to the **same upstream stream backend**.
   *
   * This space is full of mirrors: `vidsrcme.ru`, `vidsrcme.su` and
   * `vidsrc-embed.ru` returned byte-identical documents and all three resolve
   * through the same player host. Presenting them as three choices is clutter,
   * but the expensive part is the fallback chain — when one fails because the
   * backend does not have the title, every mirror of it fails the same way, so
   * trying them in turn burns the user's patience to reach the same answer.
   *
   * Group members are therefore *deprioritised* against each other rather than
   * hidden: a different backend is always tried before another door onto the
   * one that just failed. Absent means the provider stands alone.
   */
  group?: string
  /**
   * The query parameter this provider reads a start position from, in seconds.
   *
   * This is the only way to resume on Android. The desktop can reach into a
   * cross-origin frame and set `currentTime`; a WebView cannot, and neither can
   * JavaScript inside an iframe's parent — so a provider that takes the
   * position in its URL is the difference between resuming and starting over.
   *
   * Absent means "does not take one", which is the default and is not a guess:
   * every value here was measured by loading the embed with the parameter and
   * reading the frame's own `<video>` back. Adding one on the strength of a
   * documentation page would be worse than leaving it out, because the failure
   * is silent — the player simply starts at zero.
   */
  resumeParam?: string
  /**
   * Why this entry looks the way it does — a stale domain kept for
   * compatibility, a template quirk, a known coverage gap. Shown in the
   * provider panel, so it has to read as a sentence to a user.
   */
  note?: string
}

/**
 * The catalogue document, bundled and fetched.
 *
 * Versioned so a future shape change can be detected rather than guessed at,
 * and stamped so the provider panel can say how fresh the list is — "updated
 * 3 days ago" is the difference between trusting the list and reinstalling.
 */
export interface ProviderCatalog {
  /** Bumped only for incompatible shape changes. */
  version: number
  /** ISO date the list was last curated. */
  updatedAt: string
  providers: Provider[]
}

/**
 * What a reachability probe found.
 *
 * Deliberately more granular than up/down, because the responses mean
 * different things to the user: `blocked` is worth retrying with a different
 * identity, `erroring` is the provider's own fault and worth waiting out, and
 * `missing` usually means the URL template needs updating.
 */
export type ProviderStatus =
  | 'ok'
  | 'blocked'
  | 'erroring'
  | 'missing'
  | 'unreachable'
  | 'unknown'

export interface ProviderHealth {
  providerId: string
  status: ProviderStatus
  /** HTTP status observed, or null if the request never completed. */
  httpStatus: number | null
  /** Round-trip time in ms, for ordering providers that are all reachable. */
  latencyMs: number | null
  /** Epoch ms. */
  checkedAt: number
}

/* ── User data ──────────────────────────────────────────────────────────── */

/** Something the user is watching, with a resume position. */
/**
 * One episode's watched state, and when it was set.
 *
 * Kept as an explicit `watched` flag rather than encoding the state in the sign
 * of the timestamp. The compact version saves a few bytes per episode and costs
 * every future reader a puzzle.
 */
export interface EpisodeMark {
  watched: boolean
  at: number
}

export interface WatchlistEntry {
  id: string
  tmdbId: number
  type: MediaType
  title: string
  posterPath: string | null
  imdbId: string | null
  /** Null for movies. */
  lastSeason: number | null
  lastEpisode: number | null
  /** Episodes marked watched, as `"S:E"` keys. A Set once revived. */
  watchedEpisodes: string[]
  /**
   * When each episode's watched state was last set, and to what.
   *
   * `watchedEpisodes` alone cannot be merged across devices. A set union can
   * only ever grow, so un-marking an episode on one device is undone the moment
   * a device that still has it marked syncs — and because the merge result is
   * written back locally, the user watches their own change revert. Taking the
   * newer record's set wholesale does not work either: it cannot tell "removed
   * this" from "never saw this", and loses an episode marked on the other
   * device while both were offline.
   *
   * A stamp per episode settles both. Each side's claim about one episode
   * carries its own time, so the merge decides them one at a time and needs no
   * agreement about which *record* is newer.
   *
   * `watchedEpisodes` stays as the rendered field and is derived from this on
   * every merge, so the two cannot drift apart.
   */
  episodeMarks: Record<string, EpisodeMark>
  /**
   * TMDB genre ids, copied in when the entry is created. Stored rather than
   * re-fetched: the taste profile reads every entry, and the original's
   * equivalent made one HTTP request per saved title to rebuild this.
   */
  genreIds: number[]
  /**
   * Total episodes in the series, or null until TMDB has told us.
   *
   * Stored rather than fetched when the watchlist renders: the alternative is
   * one detail request per saved title every time the view opens, purely to
   * draw a progress bar. Filled in whenever the detail overlay loads the title,
   * so it arrives on first open and stays current from then on.
   */
  episodeCount: number | null
  /**
   * TMDB `vote_average` at the time the entry was made, 0 when unknown.
   *
   * Copied in for the same reason as `genreIds` and `episodeCount`: every view
   * that lists saved titles wants to draw a score, and the alternative is one
   * detail request per saved title every time the view opens. Refreshed
   * whenever the detail overlay loads the title, so it arrives on first open
   * and stays roughly current from then on.
   */
  rating: number
  addedAt: number
  providerId: string | null
  /**
   * False for an entry the user never put on their watchlist, kept only for
   * what it records: episode ticks, a chosen source. Absent means listed,
   * which is what every entry written before this existed is. Read it through
   * `isListed`.
   *
   * It exists because those records have nowhere else to live — episode state
   * is stored on the entry — and creating a listed one for them put every
   * ticked or rated title on the watchlist. Decided 2026-09-26: only pressing
   * play should do that. Pressing play, "+ Watchlist" or a MyAnimeList import
   * lists the entry; removing it from the watchlist deletes it, ticks and all,
   * as before.
   *
   * What reads unlisted entries on purpose: anything after the title's own
   * records (ticks, positions, the chosen source, the TMDB score backfill) and
   * the taste profile's viewing signals, for which a title the user ticked
   * through is a title they watched — and the titles it must not recommend.
   * What must not: the Watchlist tab and its count, Continue, the hero, the
   * command palette, background source tests, the ReelVault export, the taste
   * profile's "on the watchlist" bonus and the "More like your watchlist" row.
   */
  listed?: boolean
}

/** A series the user wants release notifications for. */
export interface ReleaseTracker {
  id: string
  tmdbId: number
  title: string
  posterPath: string | null
  status: string
  nextEpisode: EpisodeStub | null
  /** The most recent episode we have already told the user about. */
  lastNotified: EpisodeStub | null
  /**
   * Episodes of the current season around now, for the Releases timeline.
   *
   * `nextEpisode` is one episode forward and `lastNotified` is a notification
   * bookmark, so neither can answer "what aired over the last fortnight" — and
   * that is half of what the tab is for. The release sweep fills this from the
   * season it is already looking at.
   *
   * Optional rather than migrated in, for the same reason as
   * `HistoryEntry.playedMs`: this format is shared with the Android app and
   * the ReelVault extension, and rewriting every record to add a field would
   * restamp the whole collection and hand the next sync every conflict. Absent
   * on anything written before 1.6.0, and on any tracker whose season fetch
   * failed — the timeline falls back to `nextEpisode` alone.
   */
  schedule?: EpisodeStub[]
  addedAt: number
  lastChecked: number
}

/**
 * One play event — the History tab's raw material.
 *
 * Written when a title is opened, then *amended* when the player is left, which
 * is the only moment anything knows how long it actually ran. That two-step is
 * why the tail of this interface is optional: an entry that was opened but
 * never settled — the app was killed, the device slept — keeps its `watchedAt`
 * and simply has nothing to say about duration. So do all entries written
 * before 1.5.3.
 *
 * Optional rather than defaulted on migration on purpose. The export format is
 * shared with the Android app and the ReelVault extension and is frozen; adding
 * fields an older reader can ignore costs nothing, while rewriting every
 * existing record would restamp the whole collection and hand the migrating
 * device every conflict on the next sync.
 */
export interface HistoryEntry {
  id: string
  tmdbId: number
  type: MediaType
  title: string
  posterPath: string | null
  season: number | null
  episode: number | null
  watchedAt: number
  /** How long the player actually ran, in milliseconds. */
  playedMs?: number
  /** Where the video was left, in seconds, when a provider reported it. */
  seconds?: number | null
  /** How long the whole thing is, in seconds, when a provider reported it. */
  duration?: number | null
  /** Whether this settled as watched — the same judgement the library uses. */
  completed?: boolean
}

/**
 * Something the user has already seen.
 *
 * Deliberately separate from `history`, which is an append-only log of *play
 * events* — one row per episode opened, written by the player. This is a
 * title-level library: "I have watched this", stated once, whether or not it
 * was ever played through this app. Most entries arrive from an import or from
 * the user saying so, so there is nothing in `history` to derive them from.
 */
export interface WatchedEntry {
  id: string
  /** 0 when the title came from an import that has not been resolved yet. */
  tmdbId: number
  type: MediaType
  /**
   * Which season this entry is about, or null for the whole title.
   *
   * Null is right for a film, and it is also what every entry made before
   * seasons were scoped carries — those mean "the whole series", which is what
   * they meant when they were written. A series watched season by season
   * produces one entry per season instead, so finishing season 1 of a
   * nine-season show says exactly that rather than claiming all nine.
   *
   * Scoping this was a direct consequence of how it behaved before: the Watched
   * tab held whole titles, the episode browser held episodes, and the bridge
   * between them keyed on the title — so marking anything watched ticked off
   * every episode of every season the user then opened.
   */
  season: number | null
  title: string
  posterPath: string | null
  imdbId: string | null
  /** TMDB genre ids, for the taste profile. Empty until resolved. */
  genreIds: number[]
  /** TMDB `vote_average`, 0 when unknown. See `WatchlistEntry.rating`. */
  rating: number
  addedAt: number
  /** Where this came from, so an import can be undone or re-run sensibly. */
  source: 'user' | 'mal'
  /** MyAnimeList id, when imported from there. Null otherwise. */
  malId: number | null
}

/**
 * What the user thought of a title, on their own scale of 1 to 10.
 *
 * Until 1.7.3 this was a like or a dislike, on the argument that the
 * recommendation only needed the sign. It no longer does: the taste model
 * centres each rating on the user's own mean, so how far a verdict sits from
 * their usual is the signal, and two values cannot say that. Still stored per
 * title or season rather than per episode — nobody has an opinion about
 * episode 14 in isolation.
 *
 * A literal union rather than `number`, on purpose. TMDB's score is *also*
 * called `rating` in this codebase (`MediaSummary.rating`, a float 0–10), and
 * the two are exactly the same shape on the page. With a plain number, handing
 * TMDB's 7.4 to something that expects the user's verdict would type-check and
 * quietly turn the crowd's opinion into the user's. A union makes that an
 * error until someone converts on purpose, through `isRatingValue`.
 */
export type RatingValue = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10

/**
 * The two-valued opinion that builds up to 1.7.3 store and read.
 *
 * Kept as its own name rather than deleted so every place that still speaks it
 * is visible: the migration, which reads it, and `TitleRating.rating`, which is
 * written for older builds and read by nothing new.
 */
export type LegacyRating = 'like' | 'dislike'

export interface TitleRating {
  /**
   * `tv:tt0903747` or `movie:tt0137523`, matching `outcomes.titleKey` — and
   * `tv:tt0903747:s3` for an opinion about one season.
   *
   * The suffix rather than a change to the existing format is deliberate: a
   * whole-title rating keeps exactly the key it has always had, so nothing
   * already stored has to be rewritten or re-identified, and season ratings
   * simply occupy a key space that was previously empty. `ratings` is merged by
   * this key, so it has to carry the season — a `season` field alone would make
   * every season of a series collide on one record.
   */
  key: string
  tmdbId: number
  type: MediaType
  /** The season this applies to, or null for the whole title. */
  season: number | null
  /** The user's verdict. Never TMDB's score — see `RatingValue`. */
  value: RatingValue
  /**
   * True when `value` was up-converted from a like or a dislike rather than
   * chosen on the 1–10 scale.
   *
   * Such a value says which side of the line the user came down on, not how
   * far: every legacy like is an 8 and every dislike a 4, so a model reading
   * magnitude has to know that these eights are not eights anyone chose.
   * Rating the title again in the new UI writes `false`.
   */
  coarse: boolean
  /**
   * The same verdict in the two-valued form, derived from `value` by
   * `legacyRatingOf` every time the record is written or migrated.
   *
   * Written for one reader only: a build from before the 1–10 scale — a phone
   * still on 1.7.3, syncing through Drive — which knows nothing of `value`.
   * Without it that build reads `rating` as `undefined`, which its taste model
   * counts as a dislike, so every opinion the user holds would turn against
   * them the first time the phone synced. Nothing new reads it except the
   * migration, which uses it to recover a `value` for a record an old build
   * wrote.
   */
  rating: LegacyRating
  /** TMDB genre ids at the time of rating, so the profile needs no lookups. */
  genreIds: number[]
  at: number
}

/* ── Persisted store ────────────────────────────────────────────────────── */

/**
 * A record a merge can reason about.
 *
 * `updatedAt` is set by the store on every write, never by a caller.
 * `deletedAt` is a tombstone: a deleted record stays in the document, hidden
 * from `read()`, because a record that is merely *absent* is indistinguishable
 * from one the other device has not seen yet — so without it, a merge
 * resurrects every deletion. See `store/document.ts` for the full reasoning.
 */
export type Synced<T> = T & {
  updatedAt: number
  deletedAt: number | null
}

/**
 * The whole persisted document.
 *
 * The collections hold `Synced` records; the scalar fields are stamped by key
 * in `preferenceUpdatedAt` instead, since they have no per-record identity.
 * `store/document.ts` holds the registry that says how a record of each
 * collection is identified, and `store/core.ts` the API that maintains all of
 * it — this is only the shape.
 */
export interface StoreShape {
  schemaVersion: number
  /**
   * Stable per-install identifier, generated on first load.
   *
   * A sync needs somewhere to record what it last saw from each peer, and a
   * merge needs to tell "the copy I wrote" from "the copy that arrived".
   */
  deviceId: string
  /** Epoch ms per preference key; absent means "never set on this device". */
  preferenceUpdatedAt: Partial<Record<PreferenceKey, number>>

  watchlist: Synced<WatchlistEntry>[]
  trackers: Synced<ReleaseTracker>[]
  history: Synced<HistoryEntry>[]
  watched: Synced<WatchedEntry>[]
  ratings: Synced<TitleRating>[]
  resumePoints: Synced<ResumePoint>[]
  streamOutcomes: Synced<StreamOutcomeRecord>[]
  customProviders: Synced<Provider>[]

  activeProviderIds: string[]
  /**
   * Every provider id this install has ever been offered.
   *
   * The difference between "the user turned this off" and "the user has never
   * seen it", which `activeProviderIds` alone cannot express — both read as
   * absent. Without it a provider added to the catalogue is invisible to every
   * existing install, because the stored active list is non-empty and is taken
   * as the user's considered choice.
   */
  knownProviderIds: string[]
  /**
   * Providers the user wants tried first in Automatic.
   *
   * Kept apart from the order of `activeProviderIds` because the two answer
   * different questions: that list is which providers are switched on, this one
   * is which of them to reach for first.
   */
  favouriteProviderIds: string[]
  /**
   * The user's global provider order, best first, set by dragging in the
   * Providers panel. The baseline Automatic starts from. Holds every provider
   * the user has seen, enabled or not, so switching one on does not lose where
   * they had put it.
   */
  providerOrder: string[]
  /**
   * This device's own test results, one row per title, newest last.
   *
   * **Not** a synced collection. A red measures what this device's network and
   * engine could reach at one moment; taken as a fact about the title, a phone
   * on a hotel wifi would mark six providers dead on the desktop at home. So a
   * merge keeps the local rows as they are (`mergeDocuments` spreads
   * `...local`), and the other devices' rows travel separately, in
   * `sharedScans`, to be read by a stricter rule.
   *
   * Pruned per provider as results are stored: see `RESULT_TTL_MS`.
   */
  providerScans: ProviderScan[]
  /**
   * The user's other devices' test results, as each last published them.
   *
   * Agreed with the owner 2026-09-26: only good news crosses devices. A green
   * from elsewhere fills a gap here, and castability travels; a red never
   * does, and this device's own newer result always wins. That rule is applied
   * when the results are read (`shared/scanshare.ts`), not when they are
   * stored — see `SharedScan` for why.
   *
   * Filled by the sync merge from what a peer uploaded: its own
   * `providerScans`, and what it had in turn from others.
   */
  sharedScans: SharedScan[]
  /**
   * What kind of device this document lives on, set on every load and never
   * merged — like `deviceId`, it describes the install, not the library.
   *
   * It travels in the synced file so a peer knows how to read the results that
   * come with it. Optional because documents written before it existed have
   * none, and a peer that cannot tell imports nothing from them rather than
   * guessing.
   */
  deviceKind?: DeviceKind
  settings: Settings
}

/** The scalar fields of `StoreShape`, which are stamped by key. */
export type PreferenceKey =
  | 'activeProviderIds'
  | 'knownProviderIds'
  | 'favouriteProviderIds'
  | 'providerOrder'
  | 'settings'

/**
 * Where one episode or film was left off.
 *
 * Read from the provider's own `<video>` element, so it is a real position
 * rather than an estimate of one — see `main/resume.ts` for how, and for why
 * only the main process can do it.
 */
export interface ResumePoint {
  /** `tmdbId:season:episode`; a film uses `m` for both numbers. */
  key: string
  tmdbId: number
  /** Position in seconds. */
  seconds: number
  /** Total length in seconds, or 0 when the provider did not say. */
  duration: number
  updatedAt: number
}

/**
 * Identity of one resumable thing.
 *
 * An episode, or a film — films use `m` for both numbers rather than being a
 * separate shape, so one list covers both and the key stays greppable.
 *
 * Lives in `shared` rather than in main because both processes read it: main
 * writes the point, the renderer draws a film's progress bar from it. TMDB's
 * film and series id spaces overlap, so matching on `tmdbId` alone would
 * eventually show a series' position on a film that happens to share a number.
 */
export function resumeKey(req: {
  tmdbId: number
  season: number | null
  episode: number | null
}): string {
  return `${req.tmdbId}:${req.season ?? 'm'}:${req.episode ?? 'm'}`
}

/**
 * One playback attempt and how it went.
 *
 * Carries nothing that identifies a user. That is deliberate rather than
 * incidental: the intended end state is these being pooled across installs, so
 * that a title one person found a working source for is instantly playable for
 * everyone else. A record that could not be shared without stripping something
 * first would never get shared.
 */
export interface StreamOutcomeRecord {
  providerId: string
  /** `tv:tt0903747:1:1` or `movie:tt0137523`. */
  mediaKey: string
  outcome: 'stream' | 'failed'
  /** Epoch ms. */
  at: number
}

/**
 * What a background scan measured for one provider on one title.
 *
 * Distinct from `TitleOutcome` because the two are different kinds of claim and
 * collapsing them would lose the distinction that makes the feature safe.
 * An outcome is *history* — this source played this show for you — and it never
 * expires. A verdict is a *measurement*, taken at a known moment on this
 * device's network, and it goes stale in hours.
 *
 * Three values rather than two, because the errors are not symmetric. A source
 * marked dead is one the user will never pick, so a false negative silently
 * removes a working provider, while a false positive costs one click. Probes do
 * produce false negatives — a bot challenge, a slow CDN, a backend mid-restart
 * — so "alive but nothing streamed" gets its own amber verdict meaning *try
 * this by hand* rather than being rounded down to red.
 *
 * Absent is the meaningful fourth state, as it is for outcomes: never scanned
 * is not the same as scanned and found wanting.
 */
export type ProbeVerdict =
  /** Media was actually fetched. The only signal a loading-but-dead page cannot fake. */
  | 'stream'
  /** Reachable, but no media followed within the budget. Worth a manual try. */
  | 'unsure'
  /** No template, no route to the host, or a page that made no real requests. */
  | 'dead'

/**
 * How a provider's video reached the player — the fact casting depends on.
 *
 * A plain Chromecast running the Default Media Receiver plays one whole MP4 or
 * WebM file and refuses HLS before it fetches a byte (measured 2026-09-13; see
 * `docs/internal/casting.md`). Which of the two a provider hands out is not a
 * fixed property of the provider: VidSrc gave a whole file on 2026-09-13 and a
 * playlist on 2026-09-26, and VidLux gives an MP4 for one title and a playlist
 * for another. So it is measured per title, by every test, and stored as what
 * was *seen* rather than as "castable" — the receiver's rule is applied when
 * it is read (`shared/castability.ts`), so a receiver that plays more would
 * need no re-testing.
 */
export type StreamDelivery =
  /** One whole MP4 or WebM file. What a plain Chromecast plays. */
  | 'progressive'
  /** An HLS or DASH playlist and its pieces. What a plain Chromecast refuses. */
  | 'segmented'
  /** One whole file in another container, such as ScreenScape's MKV. The app does not hand these to a TV. */
  | 'other'
  /**
   * It streamed, but the test could not see how: the page reported a video
   * playing, and nothing in the traffic says what fed it. Stored rather than
   * left absent, because absent means "tested before this was recorded", which
   * is due for a new test — and this one would be due forever.
   */
  | 'unknown'

/**
 * What happened when a provider's stream was put on a television.
 *
 * Stronger evidence than `StreamDelivery`, which predicts; this is the
 * receiver's own answer. `refused` covers the case the prediction cannot see,
 * such as a whole MP4 whose codec the receiver does not decode.
 */
export type CastOutcome = 'played' | 'refused'

/**
 * Which kind of device measured something.
 *
 * Their tests do not mean the same thing. The desktop calls a source working
 * when video arrives; the phone accepts a playlist alone, and runs in an
 * Android WebView that some providers refuse outright. That difference decides
 * how a result from one reads on the other — see `shared/scanshare.ts`.
 */
export type DeviceKind = 'desktop' | 'phone'

/**
 * Why a provider did not stream, in terms the user can act on.
 *
 * The verdict alone said "may work" or "no stream" whatever had happened, and
 * that vagueness cost trust: a source whose backend answered 500 on every
 * title and one that was still loading when the test gave up looked the same.
 * Each reason maps to one verdict, decided in `scanreason.ts`, so the label
 * and the dot colour cannot disagree.
 */
export type ScanReason =
  /** The provider's page or its own backend answered with this status, and nothing streamed. */
  | { kind: 'error'; status: number }
  /** A playlist loaded, but the video segments it lists were refused with this status. */
  | { kind: 'refused'; status: number }
  /** Still loading when the test's budget ran out — slow, not necessarily broken. */
  | { kind: 'timeout'; seconds: number }
  /** A bot check or challenge page. The real player carries cookies the test does not. */
  | { kind: 'blocked' }
  /** The page settled without ever asking for a stream. */
  | { kind: 'no-stream' }
  /** The host could not be reached at all. */
  | { kind: 'unreachable' }
  /** The provider's link format cannot express this title or episode. */
  | { kind: 'unsupported' }

/**
 * What the tests know about every provider for one title.
 *
 * It started as one scan measured at one moment and replaced whole. The
 * background tester fills it one provider at a time instead, and re-tests each
 * on its own schedule — so every provider now carries its own test time in
 * `testedAt`, and a row mixing a result from this morning with one from last
 * week says so rather than pretending to be a single measurement.
 */
export interface ProviderScan {
  /** `tv:tt0903747` or `movie:tt0137523` — `outcomes.titleKey`. */
  titleKey: string
  /** Epoch ms of the newest result in the row. */
  at: number
  /** Keyed by provider id. Absent means no test has reached it. */
  verdicts: Record<string, ProbeVerdict>
  /**
   * When each provider was tested, epoch ms. Staleness and re-testing are
   * judged per provider from this. Absent for scans stored before it existed,
   * whose providers were all tested at `at`.
   */
  testedAt?: Record<string, number>
  /**
   * Why each provider that did not stream failed, where the test could tell.
   * Absent for streaming providers and for scans stored before it existed.
   */
  reasons?: Record<string, ScanReason>
  /**
   * How long each streaming provider took to fetch its first media request,
   * in milliseconds from the start of its load. Only providers whose verdict
   * is `stream` have one: for anything else there was no moment to time.
   *
   * Optional because scans stored before it existed have none, and a scan
   * without timings is still a scan.
   */
  timings?: Record<string, number>
  /**
   * The best quality each streaming provider offers, as a class — 1080 for
   * 1080p, whatever the exact pixel size. Only where the stream says so; see
   * `streamquality.ts`. Absent for a provider means unknown, not low.
   */
  qualities?: Record<string, number>
  /**
   * How each streaming provider's video arrived. Only providers whose verdict
   * is `stream` have one.
   *
   * Absent for results stored before it existed, and that absence is
   * meaningful: the background tester treats a green without it as due for a
   * new test (`isRetestDue`), which is how the stored results learn it.
   */
  delivery?: Record<string, StreamDelivery>
  /**
   * What the television said when each provider was cast. Written by a real
   * cast, not by a test, and replaced like every other detail when the
   * provider is next measured.
   */
  casts?: Record<string, CastOutcome>
}

/**
 * Test results from another of the user's devices, as it last published them.
 *
 * The same shape as the device's own row for the title, whole — reds and
 * ambers included — with where it came from. Stored faithfully and filtered
 * when read, not on the way in: a row replaced wholesale by that device's
 * newer one is how a source it has since found dead stops being reported as
 * working here, and a filtered copy would keep the old green forever.
 */
export interface SharedScan extends ProviderScan {
  /** The install that measured it — `StoreShape.deviceId` over there. */
  deviceId: string
  deviceKind: DeviceKind
}

/**
 * What can decide between two sources that are equally likely to work.
 *
 * - `speed` — how fast the stream started in the last test
 * - `quality` — the best quality the stream offers
 * - `list` — the user's own: favourites first, then the provider order
 */
export type SourceSortKey = 'speed' | 'quality' | 'list'

export interface Settings {
  /** Poll interval for release checks, in minutes. */
  releaseCheckMinutes: number
  notificationsEnabled: boolean
  /** Preferred provider, tried first when playing. */
  defaultProviderId: string | null
  /**
   * Whether hover and billboard previews play with sound.
   *
   * On by default, which is the opposite of Netflix's muted-until-asked
   * default and deliberate: this app is opened to decide what to watch, not
   * left running in a background tab, so a silent preview is just a small
   * moving picture. One global switch rather than per-surface, because a
   * preference about *sound* is about the room you are in, not the row you
   * are hovering.
   */
  previewAudio: boolean
  /**
   * Dead since 1.5.3, when History became its own tab and stopped being a
   * collapsible section at the bottom of the Watchlist.
   *
   * Kept because removing a field from `Settings` is a schema change: the
   * export format is shared with the Android app and the ReelVault extension,
   * and a document written by this version still has to load in an older one.
   * Nothing reads it.
   */
  historyCollapsed: boolean
  /**
   * Look up where each episode's intro is, so the player can offer to skip it.
   *
   * A privacy switch as much as a feature switch, and the only setting in this
   * app that is: turning it on means two crowdsourced databases are asked,
   * by IMDB id and episode number, what is playing. Everything else the app
   * does is either local or already visible to TMDB.
   */
  skipIntro: boolean
  /**
   * How sources are ordered within each group — works, may work, does not
   * work — for the source lists and for Automatic alike. Every key, once, in
   * priority order. `list` orders completely, so anything after it never gets
   * a say; it is always there so the order is never left to chance.
   */
  sourceOrder: SourceSortKey[]
}

/** Re-exported so callers can type a patch without reaching into `store/`. */
export type { StorePatch } from './store/document'
