/**
 * Merging two copies of the document, without a server to arbitrate.
 *
 * This is the piece every sync backend needs and none of them can substitute
 * for. Whether the two copies met over Google Drive, a WebDAV share or a USB
 * stick, the question at the end is the same: two documents, no authority, one
 * result — and the result has to be one the user would have agreed with.
 *
 * ## The properties that matter, and why
 *
 * A merge is called from both sides of a sync, repeatedly, in an order nobody
 * controls. So it must be:
 *
 * - **Idempotent** — `merge(a, a)` is `a`. Otherwise syncing twice with nothing
 *   in between changes the library, and every launch would drift it further.
 * - **Commutative in content** — `merge(a, b)` and `merge(b, a)` hold the same
 *   records. Otherwise the device that happens to sync second wins, which is a
 *   coin toss dressed up as a rule.
 * - **Non-destructive under uncertainty** — where the rule is genuinely
 *   ambiguous, keep more rather than less. A merge that wrongly keeps an
 *   episode marked watched costs the user one click; a merge that wrongly drops
 *   it costs them a re-watch and their trust.
 *
 * `merge` is not commutative in *identity*: the result keeps the local
 * `deviceId`, because that field names the install rather than describing the
 * library. `tests/store-merge.test.ts` asserts the rest as properties.
 *
 * ## Last-write-wins, and where it is not enough
 *
 * Most collections merge by taking whichever record has the newer `updatedAt`,
 * which is correct because their records are only ever written whole. Two
 * exceptions are written *partially* from two devices at once, and taking one
 * side entire would throw away real work:
 *
 * - `watchlist.episodeMarks` — one stamp per episode, because both sides are
 *   usually right about *different* episodes.
 * - `trackers` — `lastNotified` and `nextEpisode` answer different questions
 *   and go stale on different schedules.
 *
 * The playback position is deliberately **not** one of them. It used to take
 * the furthest-along of the two, which sounds protective and means the user
 * cannot start a series again: the old position simply comes back. It is a
 * cursor, it is stamped like every other field, and the last device to move it
 * wins.
 *
 * Those two get field-level rules. Everything else does not need one, and
 * inventing rules for fields that cannot conflict is how a merge becomes
 * unreviewable.
 */

import type { EpisodeMark, EpisodeStub, PreferenceKey, StoreShape, Synced } from '../types'
import {
  COLLECTION_KEYS,
  PREFERENCE_KEYS,
  identify,
  type CollectionKey,
  type InputOf,
  type RecordOf,
  type StoreDocument,
} from './document'

/* ── Record-level rules ─────────────────────────────────────────────────── */

/**
 * Which of two versions of the same record survives.
 *
 * Deletion is not a special case above the timestamp, it is a case *of* it: a
 * tombstone carries the moment the user deleted the record, and an edit made
 * after that moment is the user changing their mind back. So both are compared
 * on `updatedAt` alone, and `deletedAt` rides along with whichever wins.
 *
 * The tie is broken deterministically rather than by argument order — equal
 * timestamps are common when a document is copied between devices, and a merge
 * whose output depends on which side you passed first is not commutative.
 */
function pickNewer<T extends Synced<unknown>>(a: T, b: T): T {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b
  // Same instant, different content: prefer the deletion. It is the choice that
  // does not silently undo something the user did on their other device, and it
  // is reversible — re-adding a title is one click, noticing that a deletion
  // came back is not.
  if ((a.deletedAt === null) !== (b.deletedAt === null)) return a.deletedAt !== null ? a : b
  return a
}

/** The later of two episode positions, treating null as "no position". */
function laterEpisode(a: EpisodeStub | null, b: EpisodeStub | null): EpisodeStub | null {
  if (a === null) return b
  if (b === null) return a
  if (a.season !== b.season) return a.season > b.season ? a : b
  return a.episode >= b.episode ? a : b
}

/**
 * Which of two claims about one episode survives.
 *
 * A plain last-write-wins on the stamp. The tie goes to `watched`, following
 * the same doctrine as the record-level tie: wrongly keeping an episode marked
 * costs the user one click, wrongly clearing it costs them a re-watch.
 */
function pickMark(a: EpisodeMark, b: EpisodeMark): EpisodeMark {
  if (a.at !== b.at) return a.at > b.at ? a : b
  return a.watched ? a : b
}

/**
 * The marks a record asserts, including the ones it only implies.
 *
 * A record written before version 3 — or by a device still running it — has a
 * populated `watchedEpisodes` and no stamps at all. Ignoring those episodes
 * because they carry no mark would be the merge discarding data it merely
 * failed to understand, and it would do so silently.
 *
 * So an unmarked watched episode is read as having been marked when the record
 * was last written, which is the latest moment it could have been. That is the
 * same rule the version 3 migration applies, deliberately: the two must agree,
 * or a document would mean one thing on the device that migrated it and another
 * on the device that received it over sync.
 */
function effectiveMarks(record: RecordOf<'watchlist'>): Record<string, EpisodeMark> {
  const marks: Record<string, EpisodeMark> = { ...(record.episodeMarks ?? {}) }
  for (const key of record.watchedEpisodes) {
    marks[key] ??= { watched: true, at: record.updatedAt }
  }
  return marks
}

/**
 * Two watchlist entries for the same title.
 *
 * The newer record supplies every field except the episode marks, which are
 * decided one episode at a time.
 *
 * ## Why the episodes are not a union any more
 *
 * They were, and it was wrong in a way that made the app unusable rather than
 * merely lossy. A union can only grow, so un-marking an episode was undone by
 * the next sync with any device that still had it marked — and since the merge
 * result is written back locally, the user watched their own change revert a
 * few seconds after making it, over and over.
 *
 * Taking the newer record's set wholesale is not the fix. It cannot distinguish
 * "this device removed the episode" from "this device never saw it", so it
 * silently drops an episode marked on the other device while both were offline
 * — which is the case the union existed to protect.
 *
 * Neither rule can work, because both try to settle a per-episode question with
 * a per-record fact. `episodeMarks` gives each episode its own stamp, so the
 * question is answered where it is actually asked.
 */
function mergeWatchlist(
  a: RecordOf<'watchlist'>,
  b: RecordOf<'watchlist'>,
): RecordOf<'watchlist'> {
  const winner = pickNewer(a, b)

  // A deletion has no fields worth merging into — the entry is gone, and
  // reviving its episode list would make the tombstone grow instead of shrink.
  if (winner.deletedAt !== null) return winner

  const marks = effectiveMarks(a)
  for (const [key, mark] of Object.entries(effectiveMarks(b))) {
    const mine = marks[key]
    marks[key] = mine === undefined ? mark : pickMark(mine, mark)
  }

  /**
   * The rendered list, derived from the marks so the two cannot disagree.
   *
   * Order is local-first and then whatever the remote adds, and it is not
   * sorted. That is what makes `merge(x, x)` return `x` unchanged; sorting
   * would rewrite the file on every sync to say the same thing, and would sort
   * these as strings, putting "1:10" before "1:2".
   */
  const order = [...new Set([...a.watchedEpisodes, ...b.watchedEpisodes, ...Object.keys(marks)])]

  return {
    ...winner,
    episodeMarks: marks,
    watchedEpisodes: order.filter((key) => marks[key]?.watched === true),
  }
}

/**
 * Two trackers for the same series.
 *
 * `lastNotified` takes the later episode: it exists to stop the user being told
 * twice, so moving it backwards would re-notify, while moving it forwards at
 * worst skips a notification for something they have already been shown on
 * their other device.
 *
 * `nextEpisode` comes from whichever side checked TMDB more recently, together
 * with that side's `lastChecked`. The two are one fact and must not be taken
 * from different sides — a fresh `lastChecked` next to a stale `nextEpisode`
 * suppresses the sweep that would have corrected it.
 */
function mergeTracker(a: RecordOf<'trackers'>, b: RecordOf<'trackers'>): RecordOf<'trackers'> {
  const winner = pickNewer(a, b)
  if (winner.deletedAt !== null) return winner

  const fresher = a.lastChecked >= b.lastChecked ? a : b

  return {
    ...winner,
    nextEpisode: fresher.nextEpisode,
    lastChecked: fresher.lastChecked,
    lastNotified: laterEpisode(a.lastNotified, b.lastNotified),
  }
}

/**
 * The per-collection rule, defaulting to last-write-wins.
 *
 * Keyed off the same registry as everything else, so a collection added later
 * gets the safe default automatically rather than being silently forgotten.
 */
const RECORD_MERGERS: Partial<{
  [K in CollectionKey]: (a: RecordOf<K>, b: RecordOf<K>) => RecordOf<K>
}> = {
  watchlist: mergeWatchlist,
  trackers: mergeTracker,
}

function mergeRecords<K extends CollectionKey>(key: K, a: RecordOf<K>, b: RecordOf<K>): RecordOf<K> {
  const merger = RECORD_MERGERS[key] as ((x: RecordOf<K>, y: RecordOf<K>) => RecordOf<K>) | undefined
  return merger ? merger(a, b) : pickNewer(a, b)
}

/* ── Collections ────────────────────────────────────────────────────────── */

/**
 * Union two collections by record identity.
 *
 * The output order is local-first, then whatever is new on the remote side.
 * That is deliberate rather than incidental: the collections are rendered in
 * stored order in a few places, and reshuffling a user's list on every sync
 * would look like corruption even though no record was lost.
 */
function mergeCollection<K extends CollectionKey>(
  key: K,
  local: RecordOf<K>[],
  remote: RecordOf<K>[],
): RecordOf<K>[] {
  const byId = new Map<string, RecordOf<K>>()
  const order: string[] = []

  for (const record of local) {
    const id = identify(key, record as InputOf<K>)
    if (!byId.has(id)) order.push(id)
    // A collection can legitimately contain two records with the same identity
    // — an older document written before a de-duplication fix, for instance —
    // and the same rule settles that as settles a cross-device conflict.
    const existing = byId.get(id)
    byId.set(id, existing ? mergeRecords(key, existing, record) : record)
  }

  for (const record of remote) {
    const id = identify(key, record as InputOf<K>)
    const existing = byId.get(id)
    if (existing === undefined) {
      order.push(id)
      byId.set(id, record)
    } else {
      byId.set(id, mergeRecords(key, existing, record))
    }
  }

  return order.map((id) => byId.get(id) as RecordOf<K>)
}

/* ── Preferences ────────────────────────────────────────────────────────── */

/**
 * Scalar fields, decided one key at a time on `preferenceUpdatedAt`.
 *
 * An absent stamp means the key has never been deliberately set on that side,
 * so it loses to any side that has one. Without that rule a fresh install would
 * overwrite a configured device's provider order with its own defaults, purely
 * because "no timestamp" compares as zero and zero is a number.
 */
function mergePreferences(
  local: StoreDocument,
  remote: StoreDocument,
): Pick<StoreShape, PreferenceKey> & { preferenceUpdatedAt: StoreShape['preferenceUpdatedAt'] } {
  const values = {} as Pick<StoreShape, PreferenceKey>
  const stamps: StoreShape['preferenceUpdatedAt'] = {}

  for (const key of PREFERENCE_KEYS) {
    const localStamp = local.preferenceUpdatedAt[key]
    const remoteStamp = remote.preferenceUpdatedAt[key]

    // Ties go to the local side: the value the user is looking at right now
    // should not change under them without a reason to.
    const takeRemote =
      remoteStamp !== undefined && (localStamp === undefined || remoteStamp > localStamp)

    const source = takeRemote ? remote : local
    ;(values as Record<string, unknown>)[key] = source[key]

    const stamp = takeRemote ? remoteStamp : localStamp
    if (stamp !== undefined) stamps[key] = stamp
  }

  return { ...values, preferenceUpdatedAt: stamps }
}

/* ── The merge ──────────────────────────────────────────────────────────── */

/**
 * Merge a remote copy of the document into the local one.
 *
 * Both sides must already be migrated to the current schema — this deals with
 * two documents of the same shape, and handing it a version 1 document is a
 * programming error rather than a case to handle. `migrate` runs on load, and
 * a sync backend runs it on whatever it pulls before calling this.
 *
 * Neither argument is mutated. The result keeps the local `deviceId`, since it
 * identifies this install and not the library.
 */
export function mergeDocuments(local: StoreDocument, remote: StoreDocument): StoreDocument {
  const merged = {
    ...local,
    ...mergePreferences(local, remote),
    schemaVersion: Math.max(local.schemaVersion, remote.schemaVersion),
    deviceId: local.deviceId,
  } as StoreDocument

  // Written through an untyped view because the key is only known at runtime;
  // `mergeCollection` is generic over it, so the value is right by construction
  // even though the assignment cannot be expressed in the type system.
  const writable = merged as unknown as Record<CollectionKey, unknown>
  for (const key of COLLECTION_KEYS) {
    writable[key] = mergeCollection(
      key,
      local[key] as RecordOf<typeof key>[],
      remote[key] as RecordOf<typeof key>[],
    )
  }

  return merged
}
