/**
 * Bringing a document on disk up to the current schema.
 *
 * This is the code most worth testing in the whole project: it runs once, on
 * data the user cannot get back, and a mistake here is not a crash but a
 * quietly emptier library.
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

import type { StoreShape } from '../types'
import { SCHEMA_VERSION } from './document'
import type { CollectionKey, StoreDocument, Synced } from './document'
import { DEFAULT_SETTINGS, emptyDocument } from './core'

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
  const doc = version >= 1 ? fromTyped(raw, now) : fromLegacy(raw, now)

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

  doc.activeProviderIds = stringList(raw.activeProviderIds)
  doc.knownProviderIds = stringList(raw.knownProviderIds)
  doc.favouriteProviderIds = stringList(raw.favouriteProviderIds)
  // Empty rather than a default order: the app seeds it from the catalogue at
  // startup, so one place decides what "no order yet" means.
  doc.providerOrder = stringList(raw.providerOrder)

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
  doc.ratings = doc.ratings.map((rating) => ({ ...rating, season: rating.season ?? null }))

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

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
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
