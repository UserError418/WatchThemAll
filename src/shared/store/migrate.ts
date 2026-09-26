/**
 * Bringing a document on disk up to the current schema.
 *
 * This is the code most worth testing in the whole project: it runs on every
 * load and on every sync pull — not once, at a version change — over data the
 * user cannot get back, and a mistake here is not a crash but a quietly
 * emptier library. Everything it does has to be a no-op the second time.
 *
 * Three shapes have existed:
 *
 * - **Version 0** — the ReelVault Chrome extension's flat bag of `vidsrc_*`
 *   keys, which the original app inherited. It carried IMDB ids but no TMDB
 *   ones, so migrated entries get `tmdbId: 0` and are resolved lazily the first
 *   time they are opened. Dropping them instead would delete the user's
 *   library to keep the types tidy.
 * - **Version 1** — the rewrite's typed document.
 * - **Version 2** — the same fields, plus the per-record and per-preference
 *   metadata that makes two copies mergeable. See `document.ts`.
 */

import type { ProbeVerdict, ProviderScan, StoreShape, TitleRating } from '../types'
import { isLegacyRating, isRatingValue, legacyRatingOf, valueOfLegacy } from '../rating'
import { SCHEMA_VERSION } from './document'
import type { CollectionKey, StoreDocument, Synced } from './document'
import { DEFAULT_SETTINGS, emptyDocument } from './core'
import { withOneTrackerPerSeries } from './trackers'
import { normalizeSourceOrder } from '../scanrank'
import { QUALITY_CLASSES } from '../streamquality'

/** Seasons and episodes are 1-based; anything else is a parse failure. */
function clampPosition(value: number | null | undefined): number {
  return Number.isInteger(value) && (value as number) >= 1 ? (value as number) : 1
}

/** A watched-episode key is `"season:episode"`, both 1-based. */
function isValidEpisodeKey(key: string): boolean {
  const parts = key.split(':')
  if (parts.length !== 2) return false
  const season = Number(parts[0])
  const episode = Number(parts[1])
  return Number.isInteger(season) && Number.isInteger(episode) && season >= 1 && episode >= 1
}

/**
 * Where each collection's records already carry a time, and which field it is.
 *
 * Version 1 has no `updatedAt`, so version 2 has to invent one for every
 * existing record. Stamping them all with "now" would be simpler and worse:
 * whichever device happens to migrate *second* would then win every single
 * conflict on the first sync, because its records would all be newer. Reusing
 * the time the record already records preserves the real ordering, so the first
 * merge resolves the way a user would expect.
 *
 * `resumePoints` is absent from this table because `ResumePoint.updatedAt` is
 * already exactly this field — the intersection in `Synced<ResumePoint>`
 * collapses onto it, and the existing value carries through untouched.
 */
const EXISTING_TIMESTAMP: Partial<Record<CollectionKey, string>> = {
  watchlist: 'addedAt',
  trackers: 'lastChecked',
  history: 'watchedAt',
  watched: 'addedAt',
  ratings: 'at',
  streamOutcomes: 'at',
}

/** A usable millisecond timestamp, or null. */
function timestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Add `updatedAt`/`deletedAt` to a record that has none.
 *
 * The record's own `updatedAt` wins whenever it has one. That looks too obvious
 * to state, and it is the whole point: this function runs on **every load**, not
 * only on a version change, and it used to take the legacy field
 * unconditionally. A watchlist entry edited at noon was therefore rewritten on
 * the next launch to claim it was last touched when it was first added.
 *
 * The damage was not local — the value is only read by the merge — but it was
 * severe there. `addedAt` is the same number on every device that holds the
 * entry, because it travels with the record, so after one launch each side both
 * claimed the same `updatedAt` and every comparison became a tie. Last-write-
 * wins had nothing left to compare, ties resolve to the local side, and the two
 * devices could disagree forever with neither able to win. It also made an
 * un-delete impossible: a tie prefers the tombstone, by design, so re-adding a
 * title lost to its own deletion every time.
 *
 * The legacy field stays as the fallback, which is what it was added for: a
 * version-1 record genuinely has no `updatedAt`, and dating it from the time it
 * already records beats dating every record in the document `now` and having a
 * fresh install outrank a real one on the first sync.
 */
function stampRecords(key: CollectionKey, records: unknown, fallback: number): Synced<unknown>[] {
  if (!Array.isArray(records)) return []
  const field = EXISTING_TIMESTAMP[key]

  return records
    .filter((record): record is Record<string, unknown> => !!record && typeof record === 'object')
    .map((record) => {
      const updatedAt =
        timestamp(record.updatedAt) ??
        (field ? timestamp(record[field]) : null) ??
        fallback
      return {
        ...record,
        updatedAt,
        // A version-1 document cannot contain a deletion — it had no way to
        // express one — so every record it holds is live by definition.
        deletedAt: typeof record.deletedAt === 'number' ? record.deletedAt : null,
      } as Synced<unknown>
    })
}

export function migrate(input: unknown, now = Date.now()): StoreDocument {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<StoreShape> &
    Record<string, unknown>

  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0
  const migrated = version >= 1 ? fromTyped(raw, now) : fromLegacy(raw, now)

  // A repair rather than a shape change, and here because this runs on every
  // load and every pull: see `trackers.ts`.
  const doc = withOneTrackerPerSeries(migrated, now)
  doc.schemaVersion = SCHEMA_VERSION
  return doc
}

/** Version 1 or 2 — same field names, so the work is filling in what is absent. */
function fromTyped(
  raw: Partial<StoreShape> & Record<string, unknown>,
  now: number,
): StoreDocument {
  const doc = emptyDocument(typeof raw.deviceId === 'string' ? raw.deviceId : undefined)

  for (const key of Object.keys(EXISTING_TIMESTAMP) as CollectionKey[]) {
    ;(doc as unknown as Record<string, unknown>)[key] = stampRecords(key, raw[key], now)
  }
  doc.resumePoints = stampRecords('resumePoints', raw.resumePoints, now) as typeof doc.resumePoints
  doc.customProviders = stampRecords(
    'customProviders',
    raw.customProviders,
    now,
  ) as typeof doc.customProviders

  /**
   * Settings needs a *nested* merge.
   *
   * A plain assignment hands every field added after this document was last
   * written to the app as `undefined`, and `undefined` is not the default — it
   * is a third state that reads as false everywhere and renders as blank.
   * Adding `previewAudio` (default on) is exactly that case: without this,
   * every existing install would silently get muted previews and no way to tell
   * why.
   */
  doc.settings = { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) }
  // Validated rather than trusted: it decides what Automatic plays.
  doc.settings.sourceOrder = normalizeSourceOrder(doc.settings.sourceOrder)

  doc.activeProviderIds = stringList(raw.activeProviderIds)
  doc.knownProviderIds = stringList(raw.knownProviderIds)
  doc.favouriteProviderIds = stringList(raw.favouriteProviderIds)
  // Empty rather than a default order: the app seeds it from the catalogue at
  // startup, so one place decides what "no order yet" means.
  doc.providerOrder = stringList(raw.providerOrder)

  doc.providerScans = providerScans(raw.providerScans)

  if (raw.preferenceUpdatedAt && typeof raw.preferenceUpdatedAt === 'object') {
    doc.preferenceUpdatedAt = { ...(raw.preferenceUpdatedAt as Record<string, number>) }
  }

  /**
   * Version 5: scope watched entries and ratings to a season.
   *
   * Everything written before seasons existed meant "the whole series", which
   * is exactly what `null` means here — so this is a normalisation rather than
   * a reinterpretation, and nothing a user did changes meaning. Spreading a
   * document does not fill in fields added to an element type afterwards, so
   * without this the field is simply absent and every reader has to defend
   * against it.
   */
  doc.watched = doc.watched.map((entry) => ({ ...entry, season: entry.season ?? null }))
  doc.ratings = doc.ratings.flatMap((record) => {
    const scaled = onRatingScale({ ...record, season: record.season ?? null })
    return scaled ? [scaled] : []
  })

  /**
   * Repair watchlist entries written before later fields existed.
   *
   * Spreading fills in absent top-level keys but not fields added to an element
   * type afterwards, so a document written before `genreIds` hands the renderer
   * `undefined` where it iterates an array. The positions are repaired too: the
   * original app's player preload guessed them from the URL and wrote 0 when it
   * could not parse one, which renders as "S00E00".
   */
  doc.watchlist = doc.watchlist.map((entry) => {
    const watchedEpisodes = (entry.watchedEpisodes ?? []).filter(isValidEpisodeKey)
    return {
    ...entry,
    watchedEpisodes,
    /**
     * Version 3: give every already-watched episode a stamp.
     *
     * `updatedAt` is the honest choice — it is the last moment this entry is
     * known to have changed, so it is the latest time any of these marks could
     * have been made. Dating them `now` instead would make a device that
     * happens to migrate second outrank one that migrated first, purely
     * because it was launched later.
     *
     * Episodes are only ever *added* here. There is no un-watched mark to
     * recover, because before version 3 un-marking did not survive a sync at
     * all — that is the bug this field exists to fix.
     */
    episodeMarks:
      entry.episodeMarks ??
      Object.fromEntries(
        watchedEpisodes.map((key) => [key, { watched: true, at: entry.updatedAt ?? 0 }]),
      ),
    genreIds: entry.genreIds ?? [],
    // Null means "not known yet", which renders as a position without a
    // percentage rather than as 0%.
    episodeCount: entry.episodeCount ?? null,
    // 0 means "no score", which the score component draws as nothing at all
    // rather than as a damning 0.0. Filled in when the title is next opened.
    rating: typeof entry.rating === 'number' ? entry.rating : 0,
    lastSeason: entry.type === 'movie' ? null : clampPosition(entry.lastSeason),
    lastEpisode: entry.type === 'movie' ? null : clampPosition(entry.lastEpisode),
    }
  })

  return doc
}

/**
 * The 1–10 rating scale: every rating carries a `value`, and a `rating` string
 * derived from it.
 *
 * Builds up to 1.7.3 stored only `rating: 'like' | 'dislike'`. Such a record
 * gets the fixed conversion — a like is an 8, a dislike a 4 — marked `coarse`,
 * because the conversion knows which side the user came down on and nothing
 * about how far.
 *
 * **`value` wins whenever it is present.** That is safe because of how the old
 * builds write: every path in 1.7.3 that sets an opinion builds the record from
 * scratch, so an old build can never leave a stale `value` sitting next to a
 * like or dislike it has just changed. The only records carrying both are ones
 * this build (or a later one) wrote, and there the string was derived from the
 * number. So the string is re-derived here rather than trusted: the two can
 * never disagree after a load.
 *
 * Like the season normalisation above, this is detected per record rather than
 * gated on `schemaVersion` — see `SCHEMA_VERSION` for why it has to be. It runs
 * on every load and on every sync pull, so it must be a no-op the second time:
 * nothing here touches `updatedAt`, `key`, `season`, `at` or `genreIds`, and a
 * record that is already on the scale comes back field for field unchanged.
 *
 * A record with neither a usable `value` nor a like or dislike says nothing
 * anyone can read, and is dropped rather than guessed at. Guessing is how a
 * corrupted record becomes an opinion the user never held, silently steering
 * the recommendations. In practice this is only a hand-edited file: a
 * tombstone is a copy of a record that was readable when it was deleted.
 */
function onRatingScale(record: Synced<TitleRating>): Synced<TitleRating> | null {
  const stored = record as unknown as Record<string, unknown>

  if (isRatingValue(stored.value)) {
    return {
      ...record,
      value: stored.value,
      // Absent only on a record written by hand; a value nobody marked as
      // converted is taken as chosen.
      coarse: typeof stored.coarse === 'boolean' ? stored.coarse : false,
      rating: legacyRatingOf(stored.value),
    }
  }

  if (isLegacyRating(stored.rating)) {
    const value = valueOfLegacy(stored.rating)
    return { ...record, value, coarse: true, rating: legacyRatingOf(value) }
  }

  return null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** The three verdicts a scan can record. Anything else is not from this app. */
const PROBE_VERDICTS = new Set<ProbeVerdict>(['stream', 'unsure', 'dead'])

/**
 * Read back stored provider scans, discarding anything malformed.
 *
 * Validated field by field rather than cast, for the reason this whole file
 * exists: the document is user-writable JSON on disk, and a scan with a
 * `verdicts` value of `"green"` would reach `providerRank`, match none of its
 * cases and quietly sort that provider into the "nothing known" tier — a wrong
 * answer that nothing would report.
 *
 * Nothing here is *migrated*, because the field has only ever had one shape. A
 * document written before it existed simply has none, and an empty list is the
 * honest reading of that: this install has scanned nothing yet.
 */
function providerScans(value: unknown): ProviderScan[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((entry): ProviderScan[] => {
    if (!entry || typeof entry !== 'object') return []
    const scan = entry as Record<string, unknown>
    const at = timestamp(scan.at)
    if (typeof scan.titleKey !== 'string' || at === null) return []

    const verdicts: Record<string, ProbeVerdict> = {}
    if (scan.verdicts && typeof scan.verdicts === 'object') {
      for (const [id, verdict] of Object.entries(scan.verdicts as Record<string, unknown>)) {
        if (PROBE_VERDICTS.has(verdict as ProbeVerdict)) verdicts[id] = verdict as ProbeVerdict
      }
    }

    // Kept only where they can mean something: a finite, non-negative duration
    // for a provider this scan says streamed. A timing beside any other verdict
    // describes a moment that did not happen.
    const timings: Record<string, number> = {}
    if (scan.timings && typeof scan.timings === 'object') {
      for (const [id, ms] of Object.entries(scan.timings as Record<string, unknown>)) {
        if (verdicts[id] === 'stream' && typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
          timings[id] = ms
        }
      }
    }

    // The same rule for quality, and only the classes a label can show: a
    // stored 800 would print as "800p", which no player's menu says.
    const qualities: Record<string, number> = {}
    if (scan.qualities && typeof scan.qualities === 'object') {
      for (const [id, quality] of Object.entries(scan.qualities as Record<string, unknown>)) {
        if (verdicts[id] === 'stream' && QUALITY_CLASSES.includes(quality as number)) {
          qualities[id] = quality as number
        }
      }
    }
    return [{ titleKey: scan.titleKey, at, verdicts, timings, qualities }]
  })
}

/** Version 0 — the extension's `vidsrc_*` keys. */
function fromLegacy(raw: Record<string, unknown>, now: number): StoreDocument {
  const doc = emptyDocument()

  const bookmarks = raw['vidsrc_bookmarks']
  if (Array.isArray(bookmarks)) {
    doc.watchlist = bookmarks
      .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
      .map((b) => {
        const isMovie = b.type === 'movie'
        return {
          id: String(b.bookmarkId ?? crypto.randomUUID()),
          tmdbId: Number(b.tmdbId ?? 0),
          type: isMovie ? ('movie' as const) : ('tv' as const),
          title: String(b.name ?? 'Unknown'),
          posterPath: null,
          imdbId: typeof b.imdb === 'string' ? b.imdb : null,
          lastSeason: isMovie ? null : Number(b.lastSeason ?? 1),
          lastEpisode: isMovie ? null : Number(b.lastEpisode ?? 1),
          watchedEpisodes: [],
          episodeMarks: {},
          genreIds: [],
          episodeCount: null,
          rating: 0,
          addedAt: now,
          providerId: typeof b.schemaId === 'string' && b.schemaId ? b.schemaId : null,
          updatedAt: now,
          deletedAt: null,
        }
      })
  }

  const history = raw['vidsrc_history']
  if (Array.isArray(history)) {
    doc.history = history
      .filter((h): h is Record<string, unknown> => !!h && typeof h === 'object')
      .map((h) => {
        const watchedAt = Number(h.watchedAt ?? now)
        return {
          id: String(h.historyId ?? crypto.randomUUID()),
          tmdbId: 0,
          type: h.type === 'movie' ? ('movie' as const) : ('tv' as const),
          title: String(h.name ?? 'Unknown'),
          posterPath: typeof h.imageUrl === 'string' ? h.imageUrl : null,
          season: h.season == null ? null : Number(h.season),
          episode: h.episode == null ? null : Number(h.episode),
          watchedAt,
          updatedAt: watchedAt,
          deletedAt: null,
        }
      })
  }

  const providers = raw['vidsrc_active_providers']
  if (Array.isArray(providers)) {
    doc.activeProviderIds = stringList(providers)
    doc.preferenceUpdatedAt.activeProviderIds = now
  }

  return doc
}

/** Kept for tests and callers that want a blank document. */
export { emptyDocument, DEFAULT_SETTINGS, SCHEMA_VERSION }
