/**
 * One sync: pull, merge, push, keep the result.
 *
 * Short on purpose. Every hard decision was made somewhere else — the merge
 * rules in `store/merge.ts`, the transport in `drive.ts`, the sign-in in
 * `devicecode.ts` — and what is left is the order to do them in and what to do
 * when a step fails.
 *
 * ## Why there is no locking
 *
 * Drive offers no conditional update, so two devices pushing at once cannot be
 * serialised at the transport. That is survivable because of a property the
 * merge is tested for rather than assumed to have: it is a union, idempotent
 * and commutative. The remote file is a *rendezvous, not the record*.
 *
 * If B overwrites A's push from a stale base, B's file is missing A's newest
 * records — and A's next sync pulls that file, merges its own complete copy
 * back in, and pushes the union. The data is late, never gone. There is one
 * exception: a device with no local copy to heal from.
 *
 * ## Why the local document is written before the push
 *
 * The merge result is the truth as this device now understands it, and that is
 * worth keeping whether or not the network cooperates. Writing after a
 * successful push instead would mean a failed upload discards a perfectly good
 * merge, and the next launch would redo it against the same remote.
 */

import { mergeDocuments } from '../store/merge'
import { migrate } from '../store/migrate'
import { withOneTrackerPerSeries } from '../store/trackers'
import type { StoreDocument } from '../store/document'
import type { SyncBackend } from './types'

export interface SyncHost {
  /** The full local document, tombstones included. */
  read(): StoreDocument
  /** Replace it with the merged result and persist. */
  write(document: StoreDocument): Promise<void>
}

export interface SyncOutcome {
  /** True when the remote had something we did not, or vice versa. */
  changed: boolean
  /** True when this was the first sync for this account. */
  createdRemote: boolean
  at: number
}

/**
 * Run one sync to completion.
 *
 * Not re-entrant, and deliberately not made so here — serialising belongs to
 * whoever owns the trigger points, which know why a second sync was asked for.
 * `SyncRunner` below is that owner.
 */
export async function syncOnce(
  host: SyncHost,
  backend: SyncBackend,
  now = Date.now(),
): Promise<SyncOutcome> {
  const remote = await backend.pull()
  /**
   * This device's copy is read after the pull, not before it.
   *
   * From here to `host.write` everything is synchronous, so nothing written
   * while the request was out can be lost. Read before the pull, as it was
   * until 2.0.12, the merge was built from the copy as it stood then, and
   * keeping it replaced whatever had happened during the round trip: an
   * import that finished meanwhile vanished, and the push carried the library
   * without it to every device.
   */
  const local = host.read()

  if (remote === null) {
    // First sync for this account: nothing to merge, everything to upload.
    await backend.push(local, null)
    return { changed: false, createdRemote: true, at: now }
  }

  /**
   * The pulled document is migrated before it is merged, exactly as a document
   * read off disk is.
   *
   * `mergeDocuments` requires both sides at the current schema, and the remote
   * is not guaranteed to be: it is whatever the last device to push had, and
   * that may be a phone a release behind. Merged raw, its records reach this
   * device's live document in the old shape — a rating with no `value` reads
   * as unrated until the next restart migrates it — and are then written to
   * disk that way. Migrating here also means the push below carries the
   * current shape back up, so the remote heals rather than staying behind.
   */
  // Repaired after the merge as well as in `migrate`: two documents that each
  // track a series once can still merge into one that tracks it twice.
  const merged = withOneTrackerPerSeries(mergeDocuments(local, migrate(remote.document, now)), now)

  /**
   * Compare against both sides to decide whether anything actually moved.
   *
   * Structural equality over the whole document is affordable — it runs once
   * per sync on a few hundred kilobytes — and it is the only check that is
   * honest about *both* directions. Counting records would miss an edit, and a
   * timestamp would miss a merge that changed nothing.
   */
  const mergedText = JSON.stringify(merged)
  const localUnchanged = mergedText === JSON.stringify(local)
  const remoteUnchanged = mergedText === JSON.stringify(remote.document)

  if (!localUnchanged) await host.write(merged)
  if (!remoteUnchanged) await backend.push(merged, remote.version)

  return { changed: !localUnchanged || !remoteUnchanged, createdRemote: false, at: now }
}

/**
 * Serialises a task and coalesces the requests that pile up behind a run.
 *
 * The triggers are launch, foreground, and a settled write, and they overlap
 * constantly — foregrounding the app while a launch sync is still going is the
 * normal case, not the edge case. Two concurrent syncs would both pull the same
 * remote, both merge, and both push, with the later push built from the earlier
 * pull. Correct, thanks to the merge, and completely wasteful.
 *
 * A single pending flag rather than a queue: when three requests arrive during
 * one sync, the honest answer is *one* more sync afterwards, not three.
 */
export class CoalescingRunner<T> {
  private running: Promise<T> | null = null
  private pending = false

  constructor(private readonly task: () => Promise<T>) {}

  /** True while a run is in flight, for the status line. */
  get busy(): boolean {
    return this.running !== null
  }

  async request(): Promise<T> {
    if (this.running !== null) {
      // Join the run in flight rather than starting one. `run` loops while
      // `pending` is set, so the promise being returned resolves to an outcome
      // that already includes this request — no second call and no recursion,
      // which an earlier draft of this had and which started a third sync.
      this.pending = true
      return this.running
    }

    this.running = this.run().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async run(): Promise<T> {
    let outcome = await this.task()
    while (this.pending) {
      this.pending = false
      outcome = await this.task()
    }
    return outcome
  }
}

/** The library's runner: `syncOnce`, serialised and coalesced. */
export class SyncRunner extends CoalescingRunner<SyncOutcome> {
  constructor(host: SyncHost, backend: SyncBackend, now: () => number = Date.now) {
    super(() => syncOnce(host, backend, now()))
  }
}
