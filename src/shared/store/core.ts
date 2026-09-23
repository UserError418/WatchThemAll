/**
 * The store, once, for both apps.
 *
 * There used to be two of these — a Node one in `src/main` and a Capacitor one
 * in `mobile/src` — with the same debounce, the same load-and-migrate dance and
 * the same corrupt-document handling written twice. They had already drifted:
 * one kept an unreadable document, the other did not, and the delay before a
 * write differed by 150ms for no reason anyone could name.
 *
 * Everything platform-specific about persisting a JSON document turns out to be
 * four methods, so that is what a port supplies. The rest — coalescing, the
 * migration, the change notification, and every rule that keeps the document
 * mergeable — lives here and is identical on both.
 *
 * ## Mutations go through the collection API, not through patches
 *
 * The old `write(patch)` let a caller hand over a whole replacement array. That
 * is how `updatedAt` and tombstones get lost: not through malice, but because
 * the one call site added six months from now will build its array the way
 * every other call site does and nobody will notice the missing field until a
 * sync silently drops a record. So the patch door is closed and the mutators
 * stamp the metadata themselves.
 *
 * ## `read()` hides tombstones
 *
 * Deleted records stay in the document so a merge can see them, and are
 * filtered out of everything downstream. The filtered view is cached and
 * rebuilt on mutation rather than on access, because the provider ranking calls
 * `read()` several times per keystroke.
 */

import type { ProviderScan, Settings } from '../types'
import {
  COLLECTION_KEYS,
  PREFERENCE_KEYS,
  SCHEMA_VERSION,
  identify,
  pruneTombstones,
} from './document'
import type {
  CollectionKey,
  InputOf,
  PreferenceKey,
  Preferences,
  RecordOf,
  StoreDocument,
  StoreView,
  Synced,
} from './document'

/**
 * Everything a platform has to supply.
 *
 * Deliberately about bytes rather than about JSON: parsing, migrating and
 * validating are the parts that must not differ between the two apps, so they
 * are not delegated.
 */
export interface StorePersistence {
  /** The document as written, or null when there is none yet. */
  read(): Promise<string | null>
  write(text: string): Promise<void>
  /**
   * Keep an unreadable document somewhere recoverable.
   *
   * Called before the store starts empty. Without it the next write destroys
   * the only copy of the user's library, and they never learn it happened — a
   * document that fails to parse is usually truncated, which a text editor can
   * still rescue most of.
   */
  quarantine(): Promise<void>
  /** A human-readable location, shown in the app. */
  describe(): Promise<string>
}

/** How long to wait for further mutations before writing. */
const FLUSH_DELAY_MS = 300

export type Unsubscribe = () => void

/**
 * Defaults for a document that has never been written.
 *
 * Exported because the migration and the tests both need to say "and everything
 * else is default" without repeating this list.
 */
export const DEFAULT_SETTINGS: Settings = {
  releaseCheckMinutes: 60,
  notificationsEnabled: true,
  defaultProviderId: null,
  previewAudio: true,
  historyCollapsed: false,
  skipIntro: true,
}

export function emptyDocument(deviceId = newDeviceId()): StoreDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId,
    preferenceUpdatedAt: {},
    watchlist: [],
    trackers: [],
    history: [],
    watched: [],
    ratings: [],
    resumePoints: [],
    streamOutcomes: [],
    customProviders: [],
    activeProviderIds: [],
    knownProviderIds: [],
    favouriteProviderIds: [],
    providerOrder: [],
    providerScans: [],
    settings: { ...DEFAULT_SETTINGS },
  }
}

/**
 * `crypto.randomUUID` is available in Electron's main process, in a WebView and
 * in Node 19+, so no polyfill is needed — but it is absent over plain HTTP in
 * some WebViews, and a store that throws on first launch is not a trade worth
 * making for a prettier id.
 */
function newDeviceId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

/**
 * Complete a record that was built without metadata.
 *
 * The mutators below stamp automatically, and that covers every ordinary write.
 * What it does not cover is the handful of *pure* functions that build a whole
 * document and hand it back — the MAL importer, the cross-app import — which
 * would otherwise have to take a store handle purely to record two numbers.
 *
 * Note that the type still demands the metadata, so the compiler is what
 * catches an omission. This helper is how a caller answers it, not a way to
 * skip the question.
 */
export function stamp<T>(record: T, now = Date.now()): Synced<T> {
  return { ...record, updatedAt: now, deletedAt: null } as Synced<T>
}

/** `stamp` for a list, with one timestamp shared by all of them. */
export function stampAll<T>(records: T[], now = Date.now()): Synced<T>[] {
  return records.map((record) => stamp(record, now))
}

/** A typed handle on one collection. Obtained from `StoreCore.collection`. */
export interface Collection<K extends CollectionKey> {
  /** Live records, tombstones excluded. */
  all(): RecordOf<K>[]
  /** One live record, or undefined. */
  get(id: string): RecordOf<K> | undefined
  /** Insert or replace by identity, stamping `updatedAt`. */
  put(record: InputOf<K>): void
  /** Insert or replace several at once — one flush, one notification. */
  putMany(records: InputOf<K>[]): void
  /**
   * Change part of an existing record. No-op if it is absent or deleted.
   *
   * Preferred over read-modify-`put` because it cannot accidentally resurrect
   * a tombstone or drop a field the caller did not know about.
   */
  patch(id: string, changes: Partial<InputOf<K>>): boolean
  /** Tombstone a record. No-op if it is already gone. */
  remove(id: string): boolean
  /** Tombstone every record matching a predicate. Returns how many. */
  removeWhere(predicate: (record: RecordOf<K>) => boolean): number
  /**
   * Replace the whole collection with exactly these records.
   *
   * Anything previously present and now absent is tombstoned rather than
   * dropped, which is what makes this safe to use for a list the user reorders
   * or prunes wholesale.
   */
  replaceAll(records: InputOf<K>[]): void
}

export class StoreCore {
  private doc: StoreDocument = emptyDocument()
  private view: StoreView | null = null
  private listeners = new Set<() => void>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()
  private loaded = false

  constructor(
    private readonly persistence: StorePersistence,
    private readonly migrate: (raw: unknown) => StoreDocument,
  ) {}

  /**
   * Read the document from the platform. Must be awaited once before anything
   * else; calling it again is a no-op so a port can be relaxed about ordering.
   */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true

    let text: string | null
    try {
      text = await this.persistence.read()
    } catch {
      text = null
    }

    if (text === null) {
      this.doc = emptyDocument()
      this.invalidate()
      await this.flush()
      return
    }

    try {
      this.doc = pruneTombstones(this.migrate(JSON.parse(text)))
    } catch {
      await this.persistence.quarantine().catch(() => {})
      this.doc = emptyDocument()
    }
    this.invalidate()
  }

  /** The document as callers should see it: no tombstones. */
  read(): StoreView {
    if (!this.view) this.view = buildView(this.doc)
    return this.view
  }

  /**
   * The document as persisted, tombstones included.
   *
   * For the persistence layer and for sync only. Everything else wants
   * `read()`; a caller that merges or writes a *view* silently discards every
   * pending deletion, which is why the two are different methods.
   */
  raw(): StoreDocument {
    return this.doc
  }

  /** Fired after every mutation, coalesced with nothing — one call per change. */
  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  collection<K extends CollectionKey>(key: K): Collection<K> {
    const records = (): Synced<unknown>[] => this.doc[key] as Synced<unknown>[]
    const live = (): RecordOf<K>[] => (this.read()[key] as RecordOf<K>[]) ?? []

    const indexOf = (id: string): number =>
      (this.doc[key] as RecordOf<K>[]).findIndex(
        (r) => identify(key, r as unknown as InputOf<K>) === id,
      )

    const write = (next: RecordOf<K>[]): void => {
      ;(this.doc as unknown as Record<string, unknown>)[key] = next
      this.changed()
    }

    const stamped = (record: InputOf<K>, now: number): RecordOf<K> =>
      ({ ...record, updatedAt: now, deletedAt: null }) as RecordOf<K>

    return {
      all: live,

      get: (id) => live().find((r) => identify(key, r as unknown as InputOf<K>) === id),

      put: (record) => {
        const now = Date.now()
        const next = [...(this.doc[key] as RecordOf<K>[])]
        const at = indexOf(identify(key, record))
        if (at >= 0) next[at] = stamped(record, now)
        else next.push(stamped(record, now))
        write(next)
      },

      putMany: (incoming) => {
        if (incoming.length === 0) return
        const now = Date.now()
        const next = [...(this.doc[key] as RecordOf<K>[])]
        const positions = new Map(
          next.map((r, i) => [identify(key, r as unknown as InputOf<K>), i]),
        )
        for (const record of incoming) {
          const id = identify(key, record)
          const at = positions.get(id)
          if (at === undefined) {
            positions.set(id, next.length)
            next.push(stamped(record, now))
          } else {
            next[at] = stamped(record, now)
          }
        }
        write(next)
      },

      patch: (id, changes) => {
        const at = indexOf(id)
        if (at < 0) return false
        const current = (this.doc[key] as RecordOf<K>[])[at]!
        if (current.deletedAt !== null) return false
        const next = [...(this.doc[key] as RecordOf<K>[])]
        next[at] = { ...current, ...changes, updatedAt: Date.now(), deletedAt: null } as RecordOf<K>
        write(next)
        return true
      },

      remove: (id) => {
        const at = indexOf(id)
        if (at < 0) return false
        const current = (this.doc[key] as RecordOf<K>[])[at]!
        if (current.deletedAt !== null) return false
        const now = Date.now()
        const next = [...(this.doc[key] as RecordOf<K>[])]
        next[at] = { ...current, updatedAt: now, deletedAt: now }
        write(next)
        return true
      },

      removeWhere: (predicate) => {
        const now = Date.now()
        let removed = 0
        const next = (this.doc[key] as RecordOf<K>[]).map((record) => {
          if (record.deletedAt !== null || !predicate(record)) return record
          removed += 1
          return { ...record, updatedAt: now, deletedAt: now }
        })
        if (removed > 0) write(next)
        return removed
      },

      replaceAll: (incoming) => {
        const now = Date.now()
        const wanted = new Map(incoming.map((r) => [identify(key, r), r]))
        const next: RecordOf<K>[] = []

        for (const existing of records() as RecordOf<K>[]) {
          const id = identify(key, existing as unknown as InputOf<K>)
          const replacement = wanted.get(id)
          if (replacement) {
            next.push(stamped(replacement, now))
            wanted.delete(id)
          } else if (existing.deletedAt !== null) {
            next.push(existing)
          } else {
            // Present before, absent now: a deletion, not an omission.
            next.push({ ...existing, updatedAt: now, deletedAt: now })
          }
        }
        for (const added of wanted.values()) next.push(stamped(added, now))
        write(next)
      },
    }
  }

  /**
   * Apply a `{ field: value }` patch, the way the renderer still sends them.
   *
   * The renderer keeps its own mirror of the document and pushes whole arrays
   * back — `persist({ watchlist })` after every change. Rewriting all
   * twenty-nine of those call sites into targeted operations would be a large
   * diff for no behavioural gain, so the *transport* stays a patch and this is
   * where it stops being one: a collection field is routed through
   * `replaceAll`, which stamps what changed and tombstones what disappeared,
   * and a preference field through `setPreference`, which stamps the key.
   *
   * The one hazard worth naming: a caller sending a stale array tombstones any
   * record written since it read. That was already true when the same patch
   * replaced the array outright — the difference is that a tombstone is
   * visible and recoverable where a silent drop was neither.
   */
  applyPatch(patch: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(patch)) {
      if ((COLLECTION_KEYS as string[]).includes(key)) {
        if (!Array.isArray(value)) continue
        this.collection(key as CollectionKey).replaceAll(value as InputOf<CollectionKey>[])
      } else if ((PREFERENCE_KEYS as string[]).includes(key)) {
        this.setPreference(key as PreferenceKey, value as Preferences[PreferenceKey])
      }
      // Anything else — `schemaVersion`, `deviceId`, `preferenceUpdatedAt` — is
      // the store's own bookkeeping and is not a caller's to set.
    }
  }

  /** Read one preference. */
  preference<K extends PreferenceKey>(key: K): Preferences[K] {
    return this.doc[key]
  }

  /** Set one preference and stamp when. */
  setPreference<K extends PreferenceKey>(key: K, value: Preferences[K]): void {
    ;(this.doc as unknown as Record<string, unknown>)[key] = value
    this.doc.preferenceUpdatedAt = { ...this.doc.preferenceUpdatedAt, [key]: Date.now() }
    this.changed()
  }

  /** Change some settings fields, leaving the rest alone. */
  patchSettings(changes: Partial<Settings>): void {
    this.setPreference('settings', { ...this.doc.settings, ...changes })
  }

  /**
   * Replace the stored provider scans.
   *
   * Its own method because `providerScans` is a third kind of field, and the
   * two existing writers would both be wrong for it. `collection()` is for
   * records that merge across devices; `setPreference` stamps
   * `preferenceUpdatedAt`, which exists so a sync can decide whose copy of a
   * *setting* is newer. A scan is neither — it is a device-local measurement of
   * what this machine's network could reach, and `applyPatch` ignores the field
   * for exactly that reason. Stamping it would tell the sync engine to carry a
   * hotel wifi's verdicts home.
   *
   * See the field's note in `StoreShape` for why that is the wrong direction.
   */
  setProviderScans(scans: ProviderScan[]): void {
    this.doc.providerScans = scans
    this.changed()
  }

  /**
   * Replace the entire document — after an import, or after a sync merge.
   *
   * Flushes immediately rather than on the debounce: the caller has just
   * replaced the user's whole library and a crash in the next 300ms would be
   * expensive in a way an ordinary toggle is not.
   */
  async replaceDocument(next: StoreDocument): Promise<void> {
    this.doc = next
    this.invalidate()
    this.notify()
    await this.flush()
  }

  /** Where the document lives, for the app to show. */
  describe(): Promise<string> {
    return this.persistence.describe()
  }

  /** Write now. Call when the app is about to lose the chance to. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    const snapshot = JSON.stringify(this.doc)
    // Chained, not concurrent: two overlapping writes to one path can interleave
    // and leave a half-written document, and the newer one is not guaranteed to
    // finish last.
    this.writing = this.writing
      .then(() => this.persistence.write(snapshot))
      .catch((err: unknown) => {
        console.error('[store] write failed:', err)
      })
    return this.writing
  }

  private changed(): void {
    this.invalidate()
    this.scheduleFlush()
    this.notify()
  }

  private invalidate(): void {
    this.view = null
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (err) {
        // One bad subscriber must not stop the others from hearing about a
        // change they may be rendering from.
        console.error('[store] subscriber threw:', err)
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => void this.flush(), FLUSH_DELAY_MS)
  }
}

/** The document with every tombstone filtered out of every collection. */
function buildView(doc: StoreDocument): StoreView {
  const view = { ...doc }
  for (const key of COLLECTION_KEYS) {
    const records = doc[key] as Synced<unknown>[]
    ;(view as Record<string, unknown>)[key] = records.filter((r) => r.deletedAt === null)
  }
  return view
}

/** Every preference key, for callers that enumerate rather than name them. */
export { PREFERENCE_KEYS, COLLECTION_KEYS }
