/**
 * The persisted document, and the rules that make it mergeable.
 *
 * ## Why records carry metadata
 *
 * Everything here exists so that two copies of this document — one on a
 * desktop, one on a phone — can be merged without a server deciding who wins.
 * Three facts make that possible, and all three have to be recorded at the
 * moment of the change, because none can be reconstructed afterwards:
 *
 * 1. **When a record last changed** (`updatedAt`). Without it, merging two
 *    edited copies of the same watchlist entry is a coin toss.
 * 2. **That a record was deleted** (`deletedAt`). This is the one people leave
 *    out and regret. A record simply *absent* from one side is indistinguishable
 *    from one that side has not seen yet, so a plain merge resurrects every
 *    deletion. A tombstone says "this is gone, and I knew that at time T".
 * 3. **When a preference last changed** (`preferenceUpdatedAt`). The scalar
 *    fields — which providers are on, their order, the settings — have no
 *    per-record identity, so they are stamped by key instead. Without that, one
 *    settings toggle on one device would have to win or lose the *whole*
 *    preference block.
 *
 * This metadata is not bookkeeping that can be added later. Retrofitting it
 * means inventing timestamps for records that already exist, and inventing them
 * wrong means the first sync quietly discards real data. That is why it is here
 * before any sync code is.
 *
 * ## Why the collections are described in a registry
 *
 * `COLLECTIONS` is the single place that knows what a collection is called and
 * how one of its records is identified. Persistence, the typed mutators and the
 * merge all read it, so adding a collection is one entry rather than three
 * parallel edits that can disagree — and disagreement here looks like data
 * loss, not like a crash.
 */

import type { PreferenceKey, StoreShape, Synced } from '../types'

/**
 * The document type lives in `../types` with the rest of the domain, so that
 * file can be imported without pulling in this one — the two used to import
 * each other, and TypeScript answered the cycle by resolving the document to
 * `any`, which surfaced as a dozen implicit-any parameters instead of an error.
 */
export type StoreDocument = StoreShape
export type { PreferenceKey, Synced }

/**
 * Bumped when the shape changes in a way `migrate` has to react to.
 *
 * Version 0 — the ReelVault extension's flat `vidsrc_*` bag.
 * Version 1 — the rewrite's typed document.
 * Version 2 — record metadata and preference stamps.
 * Version 3 — per-episode watched stamps, so un-marking survives a merge.
 */
export const SCHEMA_VERSION = 3

/**
 * How long a deletion is remembered.
 *
 * A tombstone can only safely be dropped once every device has seen it, which
 * nothing here can know. Ninety days is the practical answer: a device that has
 * not synced in three months has bigger problems than one resurrected watchlist
 * entry, and keeping tombstones forever means the document grows without bound
 * for a user who curates their list.
 */
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000

/* ── Collections ────────────────────────────────────────────────────────── */

/** The document fields that are lists of independently mergeable records. */
export type Collections = Pick<
  StoreShape,
  | 'watchlist'
  | 'trackers'
  | 'history'
  | 'watched'
  | 'ratings'
  | 'resumePoints'
  | 'streamOutcomes'
  | 'customProviders'
>

export type CollectionKey = keyof Collections

/** One record of the collection named `K`, with its metadata. */
export type RecordOf<K extends CollectionKey> = Collections[K][number]

/** The same record without the metadata — what a caller passes in. */
export type InputOf<K extends CollectionKey> = Omit<RecordOf<K>, 'updatedAt' | 'deletedAt'>

/**
 * Identity within a collection.
 *
 * Not always a field: a stream outcome is identified by the pair it records,
 * and a resume point by the composite key it already carries. Getting one of
 * these wrong duplicates records on merge instead of updating them, which is
 * why they live in one table rather than being re-derived at each call site.
 */
export const COLLECTIONS: { [K in CollectionKey]: (record: InputOf<K>) => string } = {
  watchlist: (r) => r.id,
  trackers: (r) => r.id,
  history: (r) => r.id,
  watched: (r) => r.id,
  ratings: (r) => r.key,
  resumePoints: (r) => r.key,
  streamOutcomes: (r) => `${r.providerId} ${r.mediaKey}`,
  customProviders: (r) => r.id,
}

export const COLLECTION_KEYS = Object.keys(COLLECTIONS) as CollectionKey[]

/** The identity of one record, chosen by its collection's rule. */
export function identify<K extends CollectionKey>(key: K, record: InputOf<K>): string {
  return COLLECTIONS[key](record)
}

/* ── Preferences ────────────────────────────────────────────────────────── */

/**
 * The scalar fields, stamped by key rather than by record.
 *
 * `settings` is deliberately one unit even though it is an object: its fields
 * are read together and changed from one screen, and per-field stamps would
 * triple the bookkeeping to settle an argument nobody is having.
 */
export type Preferences = Pick<StoreShape, PreferenceKey>

export const PREFERENCE_KEYS: PreferenceKey[] = [
  'activeProviderIds',
  'knownProviderIds',
  'favouriteProviderIds',
  'providerOrder',
  'settings',
]

/* ── The document ───────────────────────────────────────────────────────── */

/**
 * What readers see: the same document with tombstones filtered out.
 *
 * The same type, deliberately — a distinct one would have to be threaded
 * through every consumer to buy a guarantee that two method names already give.
 */
export type StoreView = StoreDocument

/**
 * Drop tombstones nobody needs any more.
 *
 * Returns a new document; the caller decides whether that is worth a write.
 * Run on load rather than on every mutation, because the cost is proportional
 * to the whole document and the benefit accrues over months.
 */
export function pruneTombstones(doc: StoreDocument, now = Date.now()): StoreDocument {
  const cutoff = now - TOMBSTONE_TTL_MS
  const pruned = { ...doc }
  for (const key of COLLECTION_KEYS) {
    const records = doc[key] as Synced<unknown>[]
    const kept = records.filter((r) => r.deletedAt === null || r.deletedAt > cutoff)
    if (kept.length !== records.length) {
      ;(pruned as Record<string, unknown>)[key] = kept
    }
  }
  return pruned
}

/**
 * A patch as a *caller* sends it.
 *
 * The collections are the plain record types, without `updatedAt`/`deletedAt`:
 * the store stamps those on the way in, so requiring a caller to supply them
 * would mean either lying about a timestamp or threading a store handle into
 * the renderer. `StoreCore.applyPatch` is what turns one of these into
 * mutations — see the note there about stale arrays.
 */
export type StorePatch = Partial<{ [K in CollectionKey]: InputOf<K>[] } & Preferences>
