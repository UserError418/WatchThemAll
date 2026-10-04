/**
 * Segment staging for a platform whose network and files are in the same
 * process as the core (the desktop's main process, the tests): the segment is
 * fetched, decrypted with WebCrypto and held in memory until the core has
 * judged its first bytes, then written whole under its name.
 *
 * The phone does the same natively (`DownloadsPlugin.java`), because there
 * the core runs in the WebView and a segment's megabytes would otherwise
 * cross the bridge twice. What to keep, what to skip and when to retry is
 * decided by the core in both cases (`transfer.ts`); a platform only moves
 * and decrypts bytes.
 */

import { decryptSegment, importAesKey } from './aes'
import type { DownloadFiles, SegmentCrypt, StagedSegment } from './transfer'

/** How many clear bytes a staged segment reports: enough to find a disguised stream's start and judge it. */
export const HEAD_BYTES = 8192

type FetchBytes = DownloadFiles['fetchBytes']

/** Decrypt with a raw key; an empty result when it does not decrypt, which the core reads as "not video". */
async function inTheClear(bytes: Uint8Array, crypt: SegmentCrypt | null): Promise<Uint8Array> {
  if (crypt === null) return bytes
  const key = await importAesKey(crypt.key)
  if (key === null) return new Uint8Array()
  return (await decryptSegment(bytes, key, crypt.iv)) ?? new Uint8Array()
}

/** `stageSegment`, `commitSegment` and `discardSegment` over `fetchBytes` and a whole-file `write`. */
export function memoryStaging(
  fetchBytes: FetchBytes,
  write: (name: string, bytes: Uint8Array) => Promise<void>,
): Pick<DownloadFiles, 'stageSegment' | 'commitSegment' | 'discardSegment'> {
  const staged = new Map<string, Uint8Array>()
  return {
    async stageSegment(url, headers, name, crypt, signal): Promise<StagedSegment | null> {
      const got = await fetchBytes(url, headers, signal)
      if (got === null) return null
      const ok = got.status === 200 || got.status === 206
      const clear = ok ? await inTheClear(got.bytes, crypt) : new Uint8Array()
      staged.set(name, clear)
      return { status: got.status, bytes: clear.length, head: clear.subarray(0, HEAD_BYTES) }
    },
    async commitSegment(name, skip) {
      const bytes = staged.get(name)
      if (bytes === undefined) throw new Error(`nothing staged as ${name}`)
      staged.delete(name)
      const kept = bytes.subarray(skip)
      await write(name, kept)
      return kept.length
    },
    async discardSegment(name) {
      staged.delete(name)
    },
  }
}
