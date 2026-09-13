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
  const local = host.read()
  const remote = await backend.pull()

  if (remote === null) {
    // First sync for this account: nothing to merge, everything to upload.
    await backend.push(local, null)
    return { changed: false, createdRemote: true, at: now }
  }

  const merged = mergeDocuments(local, remote.document)

  /**
   * Compare against both sides to decide whether anything actually moved.
   *
   * Structural equality over the whole document is affordable — it runs once
   * per sync on a few hundred kilobytes — and it is the only check that is
   * honest about *both* directions. Counting records would miss an edit, and a
   * timestamp would miss a merge that changed nothing.
   */
  const localUnchanged = JSON.stringify(merged) === JSON.stringify(local)
  const remoteUnchanged = JSON.stringify(merged) === JSON.stringify(remote.document)

  if (!localUnchanged) await host.write(merged)
  if (!remoteUnchanged) await backend.push(merged, remote.version)

  return { changed: !localUnchanged || !remoteUnchanged, createdRemote: false, at: now }
}

/**
 * Serialises syncs and coalesces the ones that pile up behind a running sync.
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
export class SyncRunner {
  private running: Promise<SyncOutcome> | null = null
  private pending = false

  constructor(
    private readonly host: SyncHost,
    private readonly backend: SyncBackend,
    private readonly now: () => number = Date.now,
  ) {}

  /** True while a sync is in flight, for the status line. */
  get busy(): boolean {
    return this.running !== null
  }

  async request(): Promise<SyncOutcome> {
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

  private async run(): Promise<SyncOutcome> {
    let outcome = await syncOnce(this.host, this.backend, this.now())
    while (this.pending) {
      this.pending = false
      outcome = await syncOnce(this.host, this.backend, this.now())
    }
    return outcome
  }
}
