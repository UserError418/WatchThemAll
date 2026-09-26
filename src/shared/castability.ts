/**
 * Which sources can put a title on the television.
 *
 * ## The receiver's rule, as measured 2026-09-26
 *
 * The owner's Chromecast (a plain dongle, Default Media Receiver) plays both a
 * whole MP4 and an HLS stream — HLS provided it is served with
 * `Access-Control-Allow-Origin`, because the receiver fetches a playlist and
 * its segments from script, while a whole file goes to a video element that
 * needs no such header. The cast proxy has always sent it.
 *
 * This file was first written on the opposite belief. On 2026-09-13 a
 * textbook HLS stream from ffmpeg, served by `python -m http.server`, was
 * refused with LOAD_FAILED, and the project concluded the dongle cannot play
 * HLS at all. On 2026-09-26 VidSrc's HLS played through the proxy (Silo S1E1,
 * 59:23, position advancing), and the same textbook stream was refused again
 * without the header and played with it. The 2026-09-13 test measured CORS.
 *
 * So: a source can cast a title when it streams it as a whole MP4/WebM file or
 * as HLS/DASH. Not as another container (ScreenScape's MKV is never sent), and
 * not where a television has actually refused it.
 *
 * ## Two levels of evidence
 *
 * **Per title**, from tests and casts, decisive where it exists: how the video
 * arrived (`StreamDelivery`), and, stronger, what a television said when it
 * was cast (`CastOutcome`).
 *
 * **Per source**, from every title, for the titles nothing has tested. The
 * owner expected a source's format to be fixed, so that testing each once
 * would do. It is not: VidSrc handed out a whole file on 2026-09-13 and a
 * playlist on 2026-09-26, and VidLux resolves different titles to different
 * hosts. Under the measured rule that matters less than it did — both kinds
 * cast — but a title's own evidence still overrides the source's record.
 */

import { RESULT_TTL_MS, testedAtOf } from './scanrow'
import type { ProviderScan, StreamDelivery } from './types'

/**
 * The content types a whole file is handed to the receiver as.
 *
 * The cast path uses this same test to decide what to send (`castservice.ts`,
 * `bridge/cast.ts`), and a test uses it to record `progressive` — so "this
 * source casts" and "the cast sends it" cannot disagree. A whole file of any
 * other type, ScreenScape's MKV among them, is `other`: whether the dongle
 * would play MKV is not measured (no fresh MKV could be captured on
 * 2026-09-26), so it is not sent.
 */
const CASTABLE_FILE_TYPES = ['video/mp4', 'video/webm']

/** Whether a whole file with this `Content-Type` is one the receiver is given. */
export function isCastableFileType(contentType: string): boolean {
  const type = contentType.trim().toLowerCase()
  return CASTABLE_FILE_TYPES.some((known) => type.startsWith(known))
}

/** How a whole file counts, by its `Content-Type`. */
export function wholeFileDelivery(contentType: string): 'progressive' | 'other' {
  return isCastableFileType(contentType) ? 'progressive' : 'other'
}

/**
 * Which delivery describes a page that showed more than one.
 *
 * The one a cast would send: `identifyStream` takes a whole castable file over
 * a playlist wherever it finds both, so a test that saw both must record the
 * file, or it would call a source uncastable that casts. After that, a
 * playlist over another container (the cast would try the playlist), and
 * `unknown` — a video playing with nothing seen feeding it — only when there
 * is nothing else.
 */
export function strongerDelivery(held: StreamDelivery | null, seen: StreamDelivery): StreamDelivery {
  const rank: Record<StreamDelivery, number> = { progressive: 0, segmented: 1, other: 2, unknown: 3 }
  return held !== null && rank[held] <= rank[seen] ? held : seen
}

/**
 * What the cast list may say about one source for one title.
 *
 * - `yes` — this title: it streamed as a whole MP4/WebM or as HLS, or a cast
 *   of it played.
 * - `likely` — nothing about this title, but the source has streamed another
 *   title in a form that casts.
 * - `unknown` — nothing either way, including a stream whose form the test
 *   could not see.
 * - `no` — this title: another container, or a television refused it. Or,
 *   with nothing about this title, a source only ever seen in such a form.
 */
export type Castability = 'yes' | 'likely' | 'unknown' | 'no'

/** What is known about casting this title from this source, or null for nothing. */
export function titleCastability(scan: ProviderScan | null | undefined, providerId: string): 'yes' | 'no' | null {
  // The television's own answer outranks any prediction of it.
  const cast = scan?.casts?.[providerId]
  if (cast) return cast === 'played' ? 'yes' : 'no'
  return deliveryCastability(scan?.delivery?.[providerId])
}

/**
 * The receiver's rule on its own: whether a stream that arrived this way can
 * be cast. Exported so the cast list can read a test still in progress by the
 * same rule — a second copy of it is how the list once hid every HLS source
 * for an evening after the rule had been corrected here.
 */
export function deliveryCastability(delivery: StreamDelivery | undefined): 'yes' | 'no' | null {
  switch (delivery) {
    case 'progressive':
    case 'segmented':
      return 'yes'
    case 'other':
      return 'no'
    default:
      // `unknown`, or tested before deliveries were recorded.
      return null
  }
}

/**
 * What a source has done across every title, for a title nothing has tested.
 *
 * One castable stream anywhere makes it `likely`: the cost of a wrong
 * "likely" is one failed try, after which that title knows better. Only a
 * source seen and never castable is `no`. Results past their lifetime do not
 * count, which is what lets a source that changed format stop being judged by
 * its old one.
 */
export function sourceCastability(
  rows: readonly ProviderScan[],
  providerId: string,
  now: number,
): 'likely' | 'no' | null {
  let refused = false
  for (const row of rows) {
    // A cast is stored with a verdict and a time like any test, so this
    // covers both kinds of evidence.
    const testedAt = testedAtOf(row, providerId)
    if (testedAt === null || now - testedAt > RESULT_TTL_MS) continue
    const answer = titleCastability(row, providerId)
    if (answer === 'yes') return 'likely'
    if (answer === 'no') refused = true
  }
  return refused ? 'no' : null
}

/**
 * Castability for each source, for one title: the title's own evidence where
 * there is any, the source's record everywhere else.
 *
 * `titleScan` is the title's row as this device reads it — its own results
 * with the other devices' good news filled in (`scanshare.ts`). `rows` is every
 * row there is, own and shared, for the per-source record.
 */
export function castabilities(
  providerIds: readonly string[],
  titleScan: ProviderScan | null,
  rows: readonly ProviderScan[],
  now: number,
): Record<string, Castability> {
  const out: Record<string, Castability> = {}
  for (const id of providerIds) {
    const forTitle = titleCastability(titleScan, id)
    out[id] = forTitle ?? sourceCastability(rows, id, now) ?? 'unknown'
  }
  return out
}
