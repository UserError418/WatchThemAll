/**
 * Where the provider list comes from.
 *
 * Embed providers die, move domain and get replaced constantly — the shipped
 * catalogue measured six entries that no longer produce a stream at all, and
 * three more pointing at domains their operators had already moved off. A list
 * baked into a release is stale the week after it ships, and the user's only
 * remedy is to wait for a new build of a desktop app.
 *
 * So the list is fetched. Three layers, in increasing order of authority:
 *
 *   1. **Bundled** — compiled in. The floor. Guarantees the app works offline,
 *      on first run, and when the remote is down or serving nonsense.
 *   2. **Remote** — a curated JSON document, refreshed in the background.
 *      Replaces the bundled list wholesale when it validates.
 *   3. **Custom** — whatever the user added themselves. Never touched by a
 *      refresh; a managed list that could delete the user's own entries would
 *      be a liability rather than a feature.
 *
 * The safety property that matters: **a bad remote document changes nothing.**
 * Validation is all-or-nothing, so a truncated download, a wrong content-type
 * from a captive portal, or a typo in the published file leaves the previous
 * good list in place rather than half-applying.
 */

import type { Provider, ProviderCatalog } from '@shared/types'
import { REQUEST_HEADERS } from './identity'

/**
 * The published list.
 *
 * Served from the project's own repository rather than a bespoke service: it is
 * versioned, has an edit history, needs no hosting, and can be corrected from a
 * browser on a phone when a provider dies at an inconvenient moment. `raw`
 * rather than the API because it needs no token and no rate limit applies that
 * a once-a-day fetch could reach.
 */
/*
 * The branch segment is load-bearing and easy to get wrong: a managed list that
 * 404s is not a managed list, it is a silent fallback to whatever the binary
 * shipped with. Verify any change to this constant with a plain GET before
 * believing it.
 *
 * Note that this URL is compiled into every build, so an installed copy can
 * never be redirected. Moving the catalogue means the old address has to keep
 * answering for as long as those installs matter — see `catalog/README.md`.
 */
export const CATALOG_URL =
  'https://raw.githubusercontent.com/UserError418/WatchThemAll/main/catalog/providers.json'

/** How often to look for a new list. */
export const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000

const FETCH_TIMEOUT_MS = 10_000

/** The current document shape. A remote claiming anything else is ignored. */
export const CATALOG_VERSION = 1

export interface CachedCatalog {
  catalog: ProviderCatalog
  /** Server ETag, replayed on the next fetch so an unchanged list costs nothing. */
  etag: string | null
  /** Epoch ms of the last successful fetch. */
  fetchedAt: number
}

export type RefreshResult =
  /** A newer list was fetched and stored. */
  | { status: 'updated'; providers: number; updatedAt: string }
  /** The server confirmed nothing changed. */
  | { status: 'unchanged' }
  /** Fetch or validation failed; the previous list is still in force. */
  | { status: 'failed'; reason: string }

/* ── Validation ─────────────────────────────────────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Is this a usable provider entry?
 *
 * Strict on the fields that decide whether a URL can be built, permissive about
 * fields added later — an older client must not reject a document because it
 * carries a key that client has never heard of, or publishing anything new
 * breaks every install that has not updated.
 */
function isValidProvider(value: unknown): value is Provider {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || !value.id.trim()) return false
  if (typeof value.name !== 'string' || !value.name.trim()) return false
  if (typeof value.rootUrl !== 'string') return false

  try {
    const url = new URL(value.rootUrl)
    // A provider served over plain HTTP would downgrade the whole player window.
    if (url.protocol !== 'https:') return false
  } catch {
    return false
  }

  const section = (v: unknown): boolean =>
    v === null ||
    v === undefined ||
    (isRecord(v) && typeof v.urlTemplate === 'string' && v.urlTemplate.length > 0)

  if (!section(value.tv) || !section(value.movie)) return false
  // An entry that can serve neither media type is dead weight in every list it
  // appears in, and would silently never be chosen.
  if (!value.tv && !value.movie) return false

  return true
}

/**
 * Validate a fetched document, returning it or the reason it was rejected.
 *
 * All-or-nothing on purpose. Dropping the invalid entries and keeping the rest
 * sounds forgiving, but it means a truncated download silently installs a
 * partial catalogue — and a partial catalogue looks exactly like a correct one
 * that happens to be missing the provider you needed.
 */
export function validateCatalog(raw: unknown): { ok: true; catalog: ProviderCatalog } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'not a JSON object' }

  if (raw.version !== CATALOG_VERSION) {
    return { ok: false, reason: `version ${String(raw.version)} is not ${CATALOG_VERSION}` }
  }
  if (typeof raw.updatedAt !== 'string') return { ok: false, reason: 'missing updatedAt' }
  if (!Array.isArray(raw.providers)) return { ok: false, reason: 'providers is not an array' }
  if (raw.providers.length === 0) {
    // An empty list would leave the user with nothing to play from, which no
    // legitimate publish would ever intend.
    return { ok: false, reason: 'providers is empty' }
  }

  const bad = raw.providers.findIndex((p) => !isValidProvider(p))
  if (bad >= 0) return { ok: false, reason: `provider at index ${bad} is malformed` }

  const ids = raw.providers.map((p) => (p as Provider).id)
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i)
  if (duplicate) return { ok: false, reason: `duplicate provider id "${duplicate}"` }

  return {
    ok: true,
    catalog: {
      version: CATALOG_VERSION,
      updatedAt: raw.updatedAt,
      providers: raw.providers as Provider[],
    },
  }
}

/* ── Persistence ────────────────────────────────────────────────────────── */

/**
 * Somewhere to keep the last good fetch, so a cold start is not a blank list.
 *
 * A port rather than a filesystem call, because the two apps that need this do
 * not share a filesystem. The desktop writes a JSON file next to the store; the
 * phone has no `node:fs` at all and keeps it in Capacitor Preferences. The
 * fetch, the validation, the ETag handling and the three-layer resolution are
 * identical either way, and were until this split the only part of the managed
 * catalogue the phone could not have — so it shipped whatever list was compiled
 * into its APK, which is exactly the staleness this module exists to fix.
 *
 * Both sides store and return a *string*. Deciding what a stored blob means is
 * `decodeCache`'s job below, and having one decoder means a cache written by a
 * newer version cannot be interpreted two different ways by the two apps.
 */
export interface CatalogStore {
  /** The stored blob, or null when there is none. Must not throw. */
  read(): Promise<string | null>
  write(blob: string): Promise<void>
}

/**
 * Read a stored blob back, or null if it cannot be trusted.
 *
 * Null covers no cache, unreadable cache, and a cache from an incompatible
 * version. All three mean the same thing to the caller: fall back to bundled
 * and try to refresh.
 */
export function decodeCache(blob: string | null): CachedCatalog | null {
  if (blob === null) return null
  try {
    const raw = JSON.parse(blob) as unknown
    if (!isRecord(raw)) return null

    const validated = validateCatalog(raw.catalog)
    if (!validated.ok) return null

    return {
      catalog: validated.catalog,
      etag: typeof raw.etag === 'string' ? raw.etag : null,
      fetchedAt: typeof raw.fetchedAt === 'number' ? raw.fetchedAt : 0,
    }
  } catch {
    return null
  }
}

/** Read the cache through a store, swallowing whatever the store throws. */
export async function readCache(store: CatalogStore): Promise<CachedCatalog | null> {
  try {
    return decodeCache(await store.read())
  } catch {
    return null
  }
}

export function encodeCache(value: CachedCatalog): string {
  return JSON.stringify(value, null, 2)
}

/* ── Fetch ──────────────────────────────────────────────────────────────── */

/**
 * Fetch the published list if it has changed.
 *
 * Never throws. A failure here must be indistinguishable, from the app's point
 * of view, from not having tried — the previous list keeps working and the user
 * is not shown an error about a background refresh they did not ask for.
 */
export async function refreshCatalog(
  store: CatalogStore,
  options: { url?: string; etag?: string | null } = {},
): Promise<RefreshResult> {
  const url = options.url ?? CATALOG_URL
  const etag = options.etag ?? (await readCache(store))?.etag ?? null

  try {
    const headers: Record<string, string> = { ...REQUEST_HEADERS, Accept: 'application/json' }
    if (etag) headers['If-None-Match'] = etag

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    if (response.status === 304) return { status: 'unchanged' }
    if (!response.ok) return { status: 'failed', reason: `HTTP ${response.status}` }

    const validated = validateCatalog(await response.json())
    if (!validated.ok) return { status: 'failed', reason: validated.reason }

    await store.write(
      encodeCache({
        catalog: validated.catalog,
        etag: response.headers.get('etag'),
        fetchedAt: Date.now(),
      }),
    )

    return {
      status: 'updated',
      providers: validated.catalog.providers.length,
      updatedAt: validated.catalog.updatedAt,
    }
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
}

/* ── Resolution ─────────────────────────────────────────────────────────── */

/**
 * The list the app should actually use.
 *
 * Remote wins over bundled when it is present and valid — that is what makes
 * the list managed rather than decorative, and it is the only way a provider
 * that has died can stop being offered. Custom providers are appended and never
 * overridden, including when a custom entry reuses a catalogue id: the user
 * editing an entry is a deliberate act, and a refresh silently reverting it
 * would be a bug they could not diagnose.
 */
export function resolveProviders(
  bundled: Provider[],
  cached: CachedCatalog | null,
  custom: Provider[],
): Provider[] {
  const base = cached?.catalog.providers ?? bundled
  const overridden = new Set(custom.map((p) => p.id))
  return [...base.filter((p) => !overridden.has(p.id)), ...custom]
}
