/**
 * The test history (`sourceresults.ts`), on its own synced file.
 *
 * ## Why a third file
 *
 * The library file used to carry the results, one row per title that each
 * device replaced whole. A history does not fit that: results are only ever
 * added, by every device, and a merge is simply every result either side has
 * (`mergeResults`, a union by device, time and source). So it travels as its
 * own document, merged by its own rule, which is also what keeps it out of the
 * library upload.
 *
 * ## When it moves
 *
 * With every library sync, and a while after this device measures something
 * (`RESULTS_PUSH_MS` on each platform). Nothing waits on it: another device's
 * results only colour a list, and a minute late costs nothing. It is the
 * largest of the three files, so it is not pushed on the positions' pace.
 *
 * A device on an older build neither reads nor writes this file, and keeps
 * sharing through the library's rows (`scanshare.ts`), which this build still
 * reads (`legacyResults`).
 */

import { isSourceResult, mergeResults, type SourceResult } from '../sourceresults'
import type { FetchLike } from './devicecode'
import { createDriveBackend } from './drive'
import { CoalescingRunner } from './engine'
import type { SyncBackend } from './types'

/** The filename in the user's Drive, next to the library. */
export const RESULTS_NAME = 'WatchThemAll tests.json'

export interface ResultsDocument {
  /** Marks the file for what it is; bumped only if the shape ever changes. */
  results: 1
  items: SourceResult[]
}

export interface ResultsHost {
  /** Every result this device holds. */
  read(): readonly SourceResult[]
  /** Take the merged history as it is. */
  adopt(results: SourceResult[]): void | Promise<void>
}

export interface ResultsOutcome {
  /** This device took something another one had measured. */
  adopted: boolean
  /** The file was written. */
  pushed: boolean
}

/**
 * One results sync: pull, merge, keep what is new, push what the file lacks.
 *
 * The file holds the merged history, so what one device has from a second
 * reaches a third without the two ever syncing directly.
 */
export async function syncResults(
  host: ResultsHost,
  backend: SyncBackend<ResultsDocument>,
  now = Date.now(),
): Promise<ResultsOutcome> {
  const local = host.read()
  const remote = await backend.pull()
  // Anything malformed is dropped rather than merged: the file is in the
  // user's own Drive, where anything can be edited (`isSourceResult`).
  const incoming = Array.isArray(remote?.document?.items) ? remote.document.items.filter(isSourceResult) : []

  const merged = mergeResults(local, incoming, now)
  const adopted = JSON.stringify(merged) !== JSON.stringify(local)
  if (adopted) await host.adopt(merged)

  const outgoing: ResultsDocument = { results: 1, items: merged }
  const pushed = remote === null || JSON.stringify(outgoing) !== JSON.stringify(remote.document)
  if (pushed) await backend.push(outgoing, remote?.version ?? null)

  return { adopted, pushed }
}

export interface ResultsChannelOptions {
  host: ResultsHost
  /** A token that is valid now; the sync service's own. */
  accessToken: () => Promise<string>
  fetchImpl?: FetchLike
}

export interface ResultsChannel {
  /** One results sync, coalesced with any in flight. Null when it failed. */
  sync(): Promise<ResultsOutcome | null>
}

/**
 * The results file as a sync service holds it: one backend (so its checksum
 * cache survives between runs) behind one coalescing runner.
 *
 * Quiet, like the positions: a failure is logged, and the next library sync
 * tries again.
 */
export function createResultsChannel(options: ResultsChannelOptions): ResultsChannel {
  const backend = createDriveBackend<ResultsDocument>({
    accessToken: options.accessToken,
    fetchImpl: options.fetchImpl,
    name: RESULTS_NAME,
  })
  const runner = new CoalescingRunner(() => syncResults(options.host, backend))
  return {
    async sync() {
      try {
        return await runner.request()
      } catch (error) {
        console.warn('[sync] results:', error instanceof Error ? error.message : error)
        return null
      }
    },
  }
}
