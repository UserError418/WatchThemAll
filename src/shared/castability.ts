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
 * as HLS. Not as another container (ScreenScape's MKV is never sent), not as
 * DASH (the cast path cannot send it, see `StreamDelivery`), and not where a
 * television has actually refused it.
 *
 * ## Two levels of evidence
 *
 * **Per title**, from tests and casts, decisive where it exists: how the video
 * arrived (`StreamDelivery`), and, stronger, what a television said when it
 * was cast (`CastOutcome`). The television's answer is a fact of its own
 * (2.0.18): a test after it never replaces it, and an answer for one episode
 * stands for the whole title, until a newer cast answers. See `titleResults`
 * in `sourceresults.ts`. How another kind of device saw the video arrive is
 * a prediction at most (`likely`), never a `yes`: the phone calls a playlist
 * alone a stream, and the desktop reads the phone's green as amber.
 *
 * **Per source**, from every title, for the titles nothing has tested. The
 * owner expected a source's format to be fixed, so that testing each once
 * would do. It is not: VidSrc handed out a whole file on 2026-09-13 and a
 * playlist on 2026-09-26, and VidLux resolves different titles to different
 * hosts. Under the measured rule that matters less than it did — both kinds
 * cast — but a title's own evidence still overrides the source's record.
 * The record is `likely` only while the source's last cast anywhere played;
 * see `sourceCastability`.
 */

import { RESULT_TTL_MS, testedAtOf } from './scanrow'
import type { TitleResults } from './scanshare'
import type { CastOutcome, ProviderScan, StreamDelivery } from './types'

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
 * How a stream that came in pieces counts: as DASH when the only playlist
 * seen was a DASH manifest, as HLS otherwise.
 *
 * Decided from the playlists because a piece cannot say: `.m4s` fragments
 * serve both. A page with no playlist in sight (one fed from a blob) is
 * given the benefit of the doubt as HLS, as it always was; the cast itself
 * then finds out.
 */
export function piecesDelivery(playlists: { hls: boolean; dash: boolean }): 'segmented' | 'dash' {
  return playlists.dash && !playlists.hls ? 'dash' : 'segmented'
}

/**
 * Which delivery describes a page that showed more than one.
 *
 * The one a cast would send: `identifyStream` takes a whole castable file over
 * a playlist wherever it finds both, so a test that saw both must record the
 * file, or it would call a source uncastable that casts. After that, an HLS
 * playlist over DASH or another container (the cast would try the playlist),
 * and `unknown` — a video playing with nothing seen feeding it — only when
 * there is nothing else.
 */
export function strongerDelivery(held: StreamDelivery | null, seen: StreamDelivery): StreamDelivery {
  const rank: Record<StreamDelivery, number> = { progressive: 0, segmented: 1, dash: 2, other: 3, unknown: 4 }
  return held !== null && rank[held] <= rank[seen] ? held : seen
}

/**
 * What the cast list may say about one source for one title.
 *
 * - `yes` — this title: this kind of device saw it stream as a whole
 *   MP4/WebM or as HLS, or a cast of it played.
 * - `likely` — nothing decisive about this title, but the other kind of
 *   device saw it stream in a form that casts, or the source has streamed
 *   another title in such a form and its last cast anywhere played.
 * - `unknown` — nothing either way, including a stream whose form the test
 *   could not see.
 * - `blocked` — the last cast of this title failed because the source's own
 *   servers refused the stream to the cast proxy. Not a verdict on the
 *   format, and blocks come and go, so the list shows it after the unknowns
 *   rather than hiding it.
 * - `no` — this title: another container or DASH, or a television refused
 *   it. Or, with nothing about this title, a source only ever seen in such
 *   a form.
 */
export type Castability = 'yes' | 'likely' | 'unknown' | 'blocked' | 'no'

/** What a television's answer makes of a title. */
function answerCastability(answer: CastOutcome): 'yes' | 'blocked' | 'no' {
  switch (answer) {
    case 'played':
      return 'yes'
    case 'blocked':
      return 'blocked'
    case 'refused':
      return 'no'
  }
}

/**
 * What is known about casting this title from this source, or null for
 * nothing.
 *
 * `sharedFrom` names the sources whose row was filled in from the other kind
 * of device (`TitleResults.sharedFrom`); their delivery predicts at most.
 */
export function titleCastability(
  scan: ProviderScan | null | undefined,
  providerId: string,
  sharedFrom: Readonly<Record<string, unknown>> = {},
): 'yes' | 'likely' | 'blocked' | 'no' | null {
  // The television's own answer outranks any prediction of it.
  const answer = scan?.casts?.[providerId]
  if (answer) return answerCastability(answer)
  const predicted = deliveryCastability(scan?.delivery?.[providerId])
  return predicted === 'yes' && providerId in sharedFrom ? 'likely' : predicted
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
    case 'dash':
      return 'no'
    default:
      // `unknown`, or tested before deliveries were recorded.
      return null
  }
}

/**
 * What a source has done across every title, for a title nothing has tested.
 *
 * One castable stream anywhere makes it `likely`, as long as the last time
 * a television answered for this source, on any title, it played. That is
 * the whole rule for refusals elsewhere: a source whose last cast was
 * refused or blocked is not predicted to cast, and a newer cast that played
 * puts it back. A test does not: it says how the video arrived, which is
 * what the refusal has already shown not to be enough. (Until 2.0.18 one
 * castable stream anywhere made a source `likely` whatever any television
 * had said since.)
 *
 * Only a source seen and never castable is `no`; a refusal elsewhere alone
 * leaves it `unknown` rather than hidden, because a television that refused
 * one title's stream (a picture too wide, say) may play another's. Results
 * past their lifetime do not count, which is what lets a source that changed
 * format stop being judged by its old one.
 */
export function sourceCastability(
  rows: readonly ProviderScan[],
  providerId: string,
  now: number,
): 'likely' | 'no' | null {
  let castable = false
  let uncastable = false
  let lastAnswer: { answer: CastOutcome; at: number } | null = null
  const fresh = (at: number | null): at is number => at !== null && now - at <= RESULT_TTL_MS

  for (const row of rows) {
    const testedAt = testedAtOf(row, providerId)
    const answer = row.casts?.[providerId]
    // Rows from before answers had their own time were answered at their test's.
    const answeredAt = answer ? (row.castAt?.[providerId] ?? testedAt) : null
    if (answer && fresh(answeredAt) && (lastAnswer === null || answeredAt > lastAnswer.at)) {
      lastAnswer = { answer, at: answeredAt }
    }
    // A title counts while what decides it is fresh: its answer where it has one.
    if (!fresh(answer ? answeredAt : testedAt)) continue
    const forTitle = titleCastability(row, providerId)
    if (forTitle === 'yes') castable = true
    if (forTitle === 'no') uncastable = true
  }

  if (castable) return lastAnswer === null || lastAnswer.answer === 'played' ? 'likely' : null
  return uncastable ? 'no' : null
}

/**
 * Castability for each source, for one title: the title's own evidence where
 * there is any, the source's record everywhere else.
 *
 * `title` is the title's row as this device reads it — its own results with
 * the other devices' good news filled in (`titleResults`). `rows` is every
 * row there is, own and shared, for the per-source record.
 */
export function castabilities(
  providerIds: readonly string[],
  title: TitleResults,
  rows: readonly ProviderScan[],
  now: number,
): Record<string, Castability> {
  const out: Record<string, Castability> = {}
  for (const id of providerIds) {
    const forTitle = titleCastability(title.scan, id, title.sharedFrom)
    out[id] = forTitle ?? sourceCastability(rows, id, now) ?? 'unknown'
  }
  return out
}

/**
 * A source's castability while a test runs from the cast list.
 *
 * The live run's delivery fills a row in as each source settles, and wins
 * over what was stored about how the video arrived, since it is newer. It
 * never wins over what a television said (`answer`): a test does not
 * replace a cast's answer when it is stored, and it must not on screen
 * either. Until 2.0.18 it did, and a source the television had refused came
 * back as "Casts to this TV" the moment a test saw its playlist.
 */
export function liveCastability(
  stored: Castability | undefined,
  answer: CastOutcome | undefined,
  live: StreamDelivery | undefined,
): Castability {
  if (answer === undefined) {
    const fromTest = deliveryCastability(live)
    if (fromTest !== null) return fromTest
  }
  return stored ?? 'unknown'
}
