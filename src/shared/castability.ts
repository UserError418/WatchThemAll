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

import { fitsProfile, type ReceiverProfile } from './receivers'
import { RESULT_TTL_MS, testedAtOf } from './scanrow'
import type { TitleResults } from './scanshare'
import type { SourceResult } from './sourceresults'
import { describeVideo, isStreamSignature, signatureClass, type StreamSignature } from './streamsignature'
import type { CastCheck, CastOutcome, ProviderScan, StreamDelivery } from './types'

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

/* ── The cast list's tiers, for the television chosen (2.0.19) ───────────── */

/*
 * Until 2.0.19 the list predicted from the delivery's form alone, and nearly
 * every source streams HLS, so it promised "Casts to this TV" for streams
 * that then failed. Agreed with the owner (2026-10-09), the list now says,
 * for the television being cast to:
 *
 * - `plays`: proven. A television of this model played this source, with a
 *   stream of the class it serves now (or, before signatures were filed,
 *   played it on this title).
 * - `checked`: the cast check during a test reached the stream through the
 *   proxy, it is the title, and its signature fits this model's profile.
 * - `hidden`, with the reason: a television of this model refused it on
 *   this title, or refused a stream of the same class from any source, or
 *   its signature is outside the profile. Also, as before, a stream only
 *   ever seen as DASH or another container.
 * - `blocked`, with the reason: blocked, unreachable, slow or not the title
 *   today. Listed, not hidden: that changes from day to day.
 * - `unchecked`: nothing checked, or nothing the profile can settle; the
 *   reason says which, where there is one.
 */

/** One of the cast list's groups; see above. */
export type CastTier = 'plays' | 'checked' | 'unchecked' | 'blocked' | 'hidden'

export interface TierDecision {
  tier: CastTier
  /** Why, in words, for the row; null where the group's heading says it all. */
  reason: string | null
}

/** A television's answer about one source, as the tiers weigh it. */
export interface CastAnswerFact {
  providerId: string
  titleKey: string
  outcome: CastOutcome
  at: number
  /** The television's model; null for an answer from before 2.0.19, which is read as any television's. */
  receiver: string | null
  /** What it was handed; null when that could not be read, or before 2.0.19. */
  signature: StreamSignature | null
}

/** The newest cast check of one source on the title, with when it was made. */
export type DatedCastCheck = CastCheck & { at: number }

/**
 * What the tiers are decided from, for one title: each source's newest cast
 * check on it, and every television answer on record (any title, any
 * source: a refusal's class applies across them). Travels with the source
 * list's state (`TitleProviderState.castEvidence`), so the renderer decides
 * for whichever television is chosen, without asking again.
 */
export interface CastEvidence {
  checks: Record<string, DatedCastCheck>
  answers: CastAnswerFact[]
}

/** Whether a stored cast check is one this build can read: words it does not know are kept. */
export function isCastCheck(value: unknown): value is CastCheck {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Record<string, unknown>
  const optionalNumber = (v: unknown): boolean => v === undefined || (typeof v === 'number' && Number.isFinite(v))
  return (
    typeof c.reach === 'string' &&
    typeof c.identity === 'string' &&
    optionalNumber(c.status) &&
    optionalNumber(c.pace) &&
    optionalNumber(c.seconds) &&
    (c.signature === undefined || isStreamSignature(c.signature))
  )
}

/**
 * The evidence for one title, from every result there is (this device's
 * and the others', as `titleResults` is given them). Results past their
 * lifetime do not count, as everywhere else.
 */
export function castEvidence(results: readonly SourceResult[], titleKey: string, now: number): CastEvidence {
  const checks: Record<string, DatedCastCheck> = {}
  const answers: CastAnswerFact[] = []
  for (const result of results) {
    if (now - result.at > RESULT_TTL_MS) continue
    if (result.cast !== undefined) {
      answers.push({
        providerId: result.providerId,
        titleKey: result.titleKey,
        outcome: result.cast,
        at: result.at,
        receiver: result.castReceiver ?? null,
        signature: result.castSignature ?? null,
      })
    }
    if (result.titleKey !== titleKey || result.castCheck === undefined) continue
    const held = checks[result.providerId]
    if (held === undefined || result.at > held.at) checks[result.providerId] = { ...result.castCheck, at: result.at }
  }
  answers.sort((a, b) => b.at - a.at)
  return { checks, answers }
}

/** Whether an answer was given by a television of this model; an answer from before models were filed counts for any. */
function byThisModel(answer: CastAnswerFact, model: string | null): boolean {
  if (answer.receiver === null) return true
  return model !== null && answer.receiver.trim().toLowerCase() === model.trim().toLowerCase()
}

/** The class of a check's signature, when it reached the stream and read it. */
function checkClass(check: DatedCastCheck | undefined): string | null {
  return check?.signature ? signatureClass(check.signature) : null
}

/** What was refused or played, in words: "H.264 2160×1080", or "it" when unknown. */
function whatWas(signature: StreamSignature | null): string {
  return signature?.video ? describeVideo(signature.video) : 'it'
}

/**
 * Which group a source goes in for the television chosen, and why; see the
 * section's header for the groups.
 *
 * `base` is what the source's delivery predicts (`castabilities`, or
 * `liveCastability` while a test runs): it decides only where nothing about
 * casting was measured. `model` is the television's (`CastDevice.model`),
 * and `profile` its profile (`receiverProfile`).
 */
export function castTier(input: {
  providerId: string
  titleKey: string
  evidence: CastEvidence
  base: Castability
  model: string | null
  profile: ReceiverProfile
}): TierDecision {
  const { providerId, titleKey, evidence, base, model, profile } = input
  const check = evidence.checks[providerId]
  const current = checkClass(check)
  const answer = evidence.answers.find((a) => a.providerId === providerId && a.titleKey === titleKey && byThisModel(a, model))

  // 1. What a television of this model said about this title, unless a newer
  //    check shows the stream has changed since: another class, or not
  //    reachable today.
  if (answer !== undefined) {
    const answeredClass = answer.signature ? signatureClass(answer.signature) : null
    const newerCheck = check !== undefined && check.at > answer.at
    const changed = newerCheck && current !== null && answeredClass !== null && current !== answeredClass
    const unwellToday = newerCheck && (check.reach !== 'ok' || check.identity === 'wrong-length')
    if (answer.outcome === 'played' && !changed && !unwellToday) {
      return { tier: 'plays', reason: answer.receiver === null ? 'played when cast' : 'played on a TV like this one' }
    }
    if (answer.outcome === 'refused' && !changed) {
      return { tier: 'hidden', reason: `a TV like this one refused ${whatWas(answer.signature)}` }
    }
    if (answer.outcome === 'blocked' && !(newerCheck && check.reach === 'ok')) {
      return { tier: 'blocked', reason: 'the source blocked the TV when last cast' }
    }
  }

  // 2. The cast check: today's reach, the title's identity, then the signature.
  if (check !== undefined) {
    const today = reachToday(check)
    if (today !== null) return { tier: 'blocked', reason: today }
    if (check.reach === 'ok') {
      if (!check.signature) return { tier: 'unchecked', reason: 'reached, but what it holds could not be read' }
      const refusedClass = current === null ? undefined : classAnswer(evidence.answers, current, model)
      if (refusedClass?.outcome === 'refused') {
        return { tier: 'hidden', reason: `a TV like this one refused ${whatWas(check.signature)}` }
      }
      const fit = fitsProfile(check.signature, profile)
      if (fit.fit === 'no') return { tier: 'hidden', reason: fit.reason }
      const played = current === null ? undefined : classAnswer(evidence.answers, current, model, providerId)
      if (played?.outcome === 'played') return { tier: 'plays', reason: `played ${whatWas(check.signature)} on a TV like this one` }
      if (fit.fit === 'yes') return { tier: 'checked', reason: null }
      return { tier: 'unchecked', reason: fit.reason }
    }
  }

  // 3. Nothing measured: what the delivery predicts, as before 2.0.19.
  if (base === 'no') return { tier: 'hidden', reason: 'it streams only in a form that cannot be cast' }
  if (base === 'blocked') return { tier: 'blocked', reason: 'the source blocked the TV when last cast' }
  return { tier: 'unchecked', reason: null }
}

/**
 * The newest answer a television of this model gave for a stream of this
 * class, from any source and title, or from one source only. Answers with a
 * model only: one from before models were filed has no signature either.
 */
function classAnswer(
  answers: readonly CastAnswerFact[],
  wanted: string,
  model: string | null,
  providerId?: string,
): CastAnswerFact | undefined {
  return answers.find(
    (a) =>
      a.receiver !== null &&
      a.outcome !== 'blocked' &&
      byThisModel(a, model) &&
      (providerId === undefined || a.providerId === providerId) &&
      a.signature !== null &&
      signatureClass(a.signature) === wanted,
  )
}

/**
 * Why a check found the stream not castable today, in words; null when it
 * found nothing against it. The length first: a stream that is not the
 * title is the reason, whatever else was found about it.
 */
function reachToday(check: DatedCastCheck): string | null {
  if (check.identity === 'wrong-length') {
    const minutes = check.seconds !== undefined ? `a ${Math.max(1, Math.round(check.seconds / 60))} min video` : 'a video'
    return `it served ${minutes}, not the title`
  }
  switch (check.reach) {
    case 'blocked':
      return check.status ? `the source refused the cast's request (${check.status})` : 'the source did not answer the cast'
    case 'not-media':
      return 'the source handed out nothing a TV can play'
    case 'slow':
      return check.pace !== undefined
        ? `too slow: a piece of the stream took ${check.pace.toFixed(1)}× its length to arrive`
        : 'too slow to keep up on a TV'
  }
  return null
}
