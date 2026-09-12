/**
 * Cross-app export and import.
 *
 * WatchThemAll shares one JSON format with the WatchThemAll Android app and the
 * ReelVault Chrome extension. That format is **frozen**: it uses the original
 * extension's `vidsrc_*` key names and its bookmark/watchlist/history shapes,
 * and the other two apps have no idea this one was rewritten.
 *
 * So the internal model is translated at this boundary rather than the format
 * being modernised. Breaking it would silently desync the user's other devices,
 * which is the worst kind of regression: everything keeps working, just not
 * together.
 */

import type {
  HistoryEntry,
  MediaType,
  Provider,
  ReleaseTracker,
  StoreShape,
  WatchlistEntry,
} from '@shared/types'
import { emptyStore } from './migrate'
import { stamp } from '@shared/store/core'

/** TMDB path fragments are stored bare; the shared format carries full URLs. */
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w342'

function toAbsoluteImage(path: string | null): string | null {
  if (!path) return null
  return path.startsWith('http') ? path : TMDB_IMAGE_BASE + path
}

/** Reverse of the above: keep TMDB paths bare, pass foreign URLs through. */
function toStoredImage(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null
  const marker = '/t/p/'
  const idx = url.indexOf(marker)
  if (idx === -1) return url
  // Strip `https://image.tmdb.org/t/p/<size>` and keep the trailing path.
  const rest = url.slice(idx + marker.length)
  const slash = rest.indexOf('/')
  return slash === -1 ? url : rest.slice(slash)
}

/* ── Frozen wire shapes ─────────────────────────────────────────────────── */

interface LegacyBookmark {
  bookmarkId: string
  name: string
  imdb: string | null
  schemaId: string
  type: MediaType
  lastSeason: number | null
  lastEpisode: number | null
  imageUrl: string | null
  stars: number | null
  category: string | null
  tmdbId: string | null
}

interface LegacyWatchlistItem {
  watchId: string
  name: string
  imdb: string | null
  showId: number | string | null
  source: string
  bookmarkId: string | null
  lastKnownSeason: number
  lastKnownEpisode: number
  lastKnownAirdate: string | null
  nextEpisodeAirdate: string | null
  nextEpisodeInfo: string | null
  showStatus: string
  hasUpdate: boolean
  updateType: string | null
  addedAt: number
  lastChecked: number
  imageUrl: string | null
}

interface LegacyHistoryEntry {
  historyId: string
  imdb: string | null
  name: string
  type: MediaType
  imageUrl: string | null
  season: number | null
  episode: number | null
  watchedAt: number
  status: string
}

export interface SyncPayload {
  version: number
  exportedAt: string
  data: {
    vidsrc_bookmarks: LegacyBookmark[]
    vidsrc_watchlist_items: LegacyWatchlistItem[]
    vidsrc_history: LegacyHistoryEntry[]
    vidsrc_active_providers: string[]
    vidsrc_schemas: Provider[]
  }
}

/* ── Export ─────────────────────────────────────────────────────────────── */

export function exportStore(store: StoreShape): SyncPayload {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      vidsrc_bookmarks: store.watchlist.map((w) => ({
        bookmarkId: w.id,
        name: w.title,
        imdb: w.imdbId,
        // The other apps filter out entries with no schemaId, so a missing
        // provider must not be exported as an empty string.
        schemaId: w.providerId ?? store.activeProviderIds[0] ?? 'moviesapi',
        type: w.type,
        lastSeason: w.lastSeason,
        lastEpisode: w.lastEpisode,
        imageUrl: toAbsoluteImage(w.posterPath),
        stars: null,
        category: null,
        tmdbId: w.tmdbId ? String(w.tmdbId) : null,
      })),
      vidsrc_watchlist_items: store.trackers.map((t) => ({
        watchId: t.id,
        // The shared format keys shows by TVmaze id. This app no longer uses
        // TVmaze, so `showId` is null and the receiving app re-resolves by
        // name — lossy, but it is that or drop the entry entirely.
        showId: null,
        name: t.title,
        imdb: null,
        source: 'bookmark',
        bookmarkId: null,
        lastKnownSeason: t.lastNotified?.season ?? 0,
        lastKnownEpisode: t.lastNotified?.episode ?? 0,
        lastKnownAirdate: t.lastNotified?.airDate ?? null,
        nextEpisodeAirdate: t.nextEpisode?.airDate ?? null,
        nextEpisodeInfo: t.nextEpisode
          ? `S${String(t.nextEpisode.season).padStart(2, '0')}E${String(
              t.nextEpisode.episode,
            ).padStart(2, '0')} · ${t.nextEpisode.name || 'TBA'}`
          : null,
        showStatus: t.status,
        hasUpdate: false,
        updateType: null,
        addedAt: t.addedAt,
        lastChecked: t.lastChecked,
        imageUrl: toAbsoluteImage(t.posterPath),
      })),
      vidsrc_history: store.history.map((h) => ({
        historyId: h.id,
        imdb: null,
        name: h.title,
        type: h.type,
        imageUrl: toAbsoluteImage(h.posterPath),
        season: h.season,
        episode: h.episode,
        watchedAt: h.watchedAt,
        status: 'watched',
      })),
      vidsrc_active_providers: store.activeProviderIds,
      vidsrc_schemas: store.customProviders,
    },
  }
}

/* ── Import ─────────────────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function nullableNum(value: unknown): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Merge an exported payload into the current store.
 *
 * Merge, never replace — the user is importing another device's library into
 * this one, not restoring a backup over it. Identity is the id field each type
 * carries, which is what makes repeated imports idempotent.
 */
export function importIntoStore(
  store: StoreShape,
  payload: unknown,
): { ok: boolean; error?: string; added: { watchlist: number; trackers: number; history: number } } {
  const added = { watchlist: 0, trackers: 0, history: 0 }

  if (!isRecord(payload) || !isRecord(payload.data)) {
    return { ok: false, error: 'Not a WatchThemAll export file', added }
  }
  const data = payload.data

  const bookmarks = data.vidsrc_bookmarks
  if (Array.isArray(bookmarks)) {
    const seen = new Set(store.watchlist.map((w) => w.id))
    for (const raw of bookmarks) {
      if (!isRecord(raw)) continue
      const id = str(raw.bookmarkId)
      if (!id || seen.has(id)) continue
      seen.add(id)

      const type: MediaType = raw.type === 'movie' ? 'movie' : 'tv'
      const entry: WatchlistEntry = {
        id,
        tmdbId: num(raw.tmdbId, 0),
        type,
        title: str(raw.name, 'Unknown'),
        posterPath: toStoredImage(raw.imageUrl as string | null),
        imdbId: typeof raw.imdb === 'string' ? raw.imdb : null,
        lastSeason: type === 'movie' ? null : num(raw.lastSeason, 1),
        lastEpisode: type === 'movie' ? null : num(raw.lastEpisode, 1),
        watchedEpisodes: [],
        episodeMarks: {},
        // Foreign exports carry no genre data; the taste profile simply does
        // not count imported entries until they are opened once.
        genreIds: [],
        // Not part of the frozen export format, and deliberately not added to
        // it: it is a local cache of a TMDB fact, not something the user owns.
        // Filled in the first time the imported title is opened.
        episodeCount: null,
        addedAt: Date.now(),
        providerId: str(raw.schemaId) || null,
      }
      store.watchlist.push(stamp(entry))
      added.watchlist++
    }
  }

  const trackers = data.vidsrc_watchlist_items
  if (Array.isArray(trackers)) {
    const seen = new Set(store.trackers.map((t) => t.id))
    for (const raw of trackers) {
      if (!isRecord(raw)) continue
      const id = str(raw.watchId)
      if (!id || seen.has(id)) continue
      seen.add(id)

      const entry: ReleaseTracker = {
        id,
        // Foreign exports carry a TVmaze id here, which is meaningless to this
        // app. It is resolved to a TMDB id by title on the next release check.
        tmdbId: 0,
        title: str(raw.name, 'Unknown'),
        posterPath: toStoredImage(raw.imageUrl as string | null),
        status: str(raw.showStatus, 'Unknown'),
        nextEpisode: null,
        lastNotified: null,
        addedAt: num(raw.addedAt, Date.now()),
        lastChecked: 0,
      }
      store.trackers.push(stamp(entry))
      added.trackers++
    }
  }

  const history = data.vidsrc_history
  if (Array.isArray(history)) {
    const seen = new Set(store.history.map((h) => h.id))
    for (const raw of history) {
      if (!isRecord(raw)) continue
      const id = str(raw.historyId)
      if (!id || seen.has(id)) continue
      seen.add(id)

      const entry: HistoryEntry = {
        id,
        tmdbId: 0,
        type: raw.type === 'movie' ? 'movie' : 'tv',
        title: str(raw.name, 'Unknown'),
        posterPath: toStoredImage(raw.imageUrl as string | null),
        season: nullableNum(raw.season),
        episode: nullableNum(raw.episode),
        watchedAt: num(raw.watchedAt, Date.now()),
      }
      store.history.push(stamp(entry))
      added.history++
    }
    store.history.sort((a, b) => b.watchedAt - a.watchedAt)
  }

  const providers = data.vidsrc_active_providers
  if (Array.isArray(providers)) {
    const merged = new Set(store.activeProviderIds)
    for (const id of providers) if (typeof id === 'string') merged.add(id)
    store.activeProviderIds = [...merged]
  }

  const schemas = data.vidsrc_schemas
  if (Array.isArray(schemas)) {
    const seen = new Set(store.customProviders.map((p) => p.id))
    for (const raw of schemas) {
      if (!isRecord(raw) || typeof raw.id !== 'string' || seen.has(raw.id)) continue
      seen.add(raw.id)
      store.customProviders.push(stamp(raw as unknown as Provider))
    }
  }

  return { ok: true, added }
}

/** Round-trip helper used by the tests to prove the format survives a cycle. */
export function roundTrip(store: StoreShape): StoreShape {
  const fresh = emptyStore()
  importIntoStore(fresh, exportStore(store))
  return fresh
}
