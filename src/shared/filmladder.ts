/**
 * The film's ladder in a capture: which of the playlists a source's page
 * fetched is the film's master, and what it offers.
 *
 * Written for downloads (`planDownload`), which need the master to choose a
 * quality from, and moved here when the source tests needed the same answer
 * for a different question: a test that read only a floor ("720p+") can
 * still name the source's offer when the film's master is among what its
 * page fetched. One implementation, so a download and a test of the same
 * capture agree on which master is the film's.
 *
 * ## From a capture to a ladder
 *
 * What a page fetched, newest first. Each request is sniffed (its first
 * 16 KB) for `#EXTM3U`: a master lists variants (`masterVariants`), a media
 * playlist is one rendition. A master is the film's only if its variants are
 * the film's length: adverts and decoys are HLS too, with masters of their
 * own. So one variant of each master is fetched, in capture order, its
 * segments added up and held to TMDB's runtime (`lengthVerdict`), and the
 * first master whose variant fits is the film's ladder.
 *
 * The length is read leniently (`readMediaPlaylist`): a ladder the browser
 * plays names the source's offer even where a download could not use it
 * (byte ranges, a key it cannot handle). A download checks its own rules on
 * the variant afterwards (`planDownload`).
 *
 * Fetching goes through the platform's `StreamFetch`, with the headers the
 * page sent: the desktop's Node fetch, the phone's native one.
 */

import { masterAudio } from './audiotracks'
import { lengthVerdict } from './runtimecheck'
import { parseMediaPlaylist, type MediaPlaylist, type UnfitReason } from './segmentwindow'
import type { CapturedRequest, StreamFetch } from './streamfetch'
import { bestQuality, masterVariants, readLadder, readMediaPlaylist, type Variant } from './streamquality'
import type { QualityKind } from './types'

/** Enough of a response to see `#EXTM3U` and whether it is a master. */
const SNIFF_BYTES = 16 * 1024

/**
 * How many captured requests are sniffed. A capture keeps playlists and the
 * source's API calls, not its segments, so the chain that led to the stream
 * is well inside this.
 */
const CANDIDATES_TRIED = 30

/** Why a candidate was not the film's ladder. */
export type LadderRefusal =
  /** A playlist no player could join as it is: DRM, byte ranges, live, empty (`segmentwindow.ts`). */
  | { kind: 'unfit'; reason: UnfitReason }
  /** Its length is not the film's: an advert, a clip, another programme. */
  | { kind: 'wrong-length'; seconds: number }
  /** The caller's own rule refused the master (`LadderOptions.refuseMaster`), in its words. */
  | { kind: 'caller'; reason: string }

export interface LadderOptions {
  /**
   * Which variant's playlist to fetch for the length check: a download's
   * quality cap chooses the one it will fetch. By default the first listed,
   * since every variant of one master is the same film.
   */
  choose?: (variants: readonly Variant[]) => Variant | null
  /** A master the caller cannot use, and why; a download cannot use one whose sound is kept apart. */
  refuseMaster?: (body: string) => LadderRefusal | null
}

/** The film's master, and the variant that showed it is the film's. */
export interface FilmLadder {
  /** The master's address, and the headers the page fetched it with. */
  url: string
  headers: Record<string, string>
  /** The master's text: its renditions, and its audio (`masterAudio`). */
  body: string
  variants: Variant[]
  /** The variant whose playlist was fetched, and that playlist's text. */
  chosen: Variant
  playlist: string
  /** What the chosen playlist's segments add up to, in seconds: the film's length. */
  seconds: number
}

export interface LadderSearch {
  /** The film's ladder, or null when the capture held none that fits. */
  ladder: FilmLadder | null
  /**
   * The media playlists the page fetched directly, newest first: what a
   * download falls back on without a master. Parsed by a download's rules
   * (`parseMediaPlaylist`), so DRM, live and byte-range playlists are not here.
   */
  renditions: Array<{ playlist: MediaPlaylist; url: string; headers: Record<string, string> }>
  /** Why the most telling candidate was refused, for when nothing qualifies; null when nothing was. */
  refused: LadderRefusal | null
}

/**
 * Keep the most telling refusal: a wrong length says more than anything
 * else (the source plays, just not the film), so it replaces an earlier
 * reason; any other reason only fills a gap.
 */
function moreTelling(held: LadderRefusal | null, next: LadderRefusal): LadderRefusal {
  return next.kind === 'wrong-length' || held === null ? next : held
}

/** The film's ladder among what a source's page fetched (`requests`, newest first). */
export async function findLadder(
  requests: readonly CapturedRequest[],
  io: StreamFetch,
  runtimeMinutes: number | null,
  options: LadderOptions = {},
): Promise<LadderSearch> {
  const masters: Array<{ body: string; url: string; headers: Record<string, string> }> = []
  const renditions: LadderSearch['renditions'] = []
  let refused: LadderRefusal | null = null
  const tried = new Set<string>()

  for (const request of requests) {
    if (tried.size >= CANDIDATES_TRIED) break
    if (tried.has(request.url)) continue
    tried.add(request.url)
    const head = await io.fetchText(request.url, request.headers, SNIFF_BYTES)
    if (head === null || (head.status !== 200 && head.status !== 206)) continue
    if (!head.body.trimStart().startsWith('#EXTM3U')) continue
    const text = head.body.length < SNIFF_BYTES ? head : await io.fetchText(request.url, request.headers)
    if (text === null || text.status !== 200) continue
    const parsed = parseMediaPlaylist(text.body, request.url)
    if (parsed.ok) renditions.push({ playlist: parsed.playlist, url: request.url, headers: request.headers })
    else if (parsed.reason === 'master') masters.push({ body: text.body, url: request.url, headers: request.headers })
    else if (parsed.reason !== 'not-a-playlist') refused = moreTelling(refused, { kind: 'unfit', reason: parsed.reason })
  }

  const choose = options.choose ?? ((variants: readonly Variant[]) => variants[0] ?? null)
  for (const master of masters) {
    const refusal = options.refuseMaster?.(master.body) ?? null
    if (refusal !== null) {
      refused = moreTelling(refused, refusal)
      continue
    }
    const variants = masterVariants(master.body, master.url)
    const chosen = choose(variants)
    if (chosen === null) continue
    const text = await io.fetchText(chosen.url, master.headers)
    if (text === null || text.status !== 200) continue
    if (!text.body.trimStart().startsWith('#EXTM3U')) {
      refused = moreTelling(refused, { kind: 'unfit', reason: 'not-a-playlist' })
      continue
    }
    const seconds = readMediaPlaylist(text.body).seconds
    if (seconds <= 0) {
      refused = moreTelling(refused, { kind: 'unfit', reason: 'empty' })
      continue
    }
    if (lengthVerdict(seconds, runtimeMinutes) === 'implausible') {
      refused = moreTelling(refused, { kind: 'wrong-length', seconds })
      continue
    }
    return {
      ladder: { url: master.url, headers: master.headers, body: master.body, variants, chosen, playlist: text.body, seconds },
      renditions,
      refused,
    }
  }
  return { ladder: null, renditions, refused }
}

/**
 * What a film's ladder says about the source: the best class it offers
 * (null when its master names no sizes) and the languages of its audio
 * renditions. What a test files as an offer once its verdict is in.
 */
export function ladderOffer(ladder: FilmLadder): { quality: number | null; audio: string[] } {
  return { quality: bestQuality(readLadder(ladder.body)), audio: masterAudio(ladder.body) }
}

/** What a test measured of a stream, as far as its ladder can add to it. */
export interface LadderMeasured {
  verdict: string
  quality: number | null
  qualityKind: QualityKind | null
  audio: string[] | null
}

/**
 * A test's measurement with what the film's ladder adds, or null when it
 * adds nothing. The offer is taken over a floor at or below it, never over
 * an offer, as a play takes its source's own list (`withQualityReading`);
 * the audio only where none was known.
 */
export function withLadderOffer<T extends LadderMeasured>(measured: T, offer: { quality: number | null; audio: string[] }): T | null {
  const quality = offer.quality
  const takesQuality = quality !== null && measured.qualityKind !== 'offered' && quality >= (measured.quality ?? 0)
  const takesAudio = offer.audio.length > 0 && (measured.audio ?? []).length === 0
  if (!takesQuality && !takesAudio) return null
  return {
    ...measured,
    ...(takesQuality ? { quality, qualityKind: 'offered' as const } : {}),
    ...(takesAudio ? { audio: offer.audio } : {}),
  }
}

/**
 * After a test's verdict: the film's ladder in what the source's page
 * fetched, for a stream whose test read no offer. The measurement with what
 * it adds, or null. Both platforms' scans run it once a verdict is in, off
 * the pool, and a failure here changes nothing.
 */
export async function ladderAfterVerdict<T extends LadderMeasured>(
  measured: T,
  requests: readonly CapturedRequest[],
  io: StreamFetch,
  runtimeMinutes: number | null,
): Promise<T | null> {
  if (measured.verdict !== 'stream' || measured.qualityKind === 'offered' || requests.length === 0) return null
  const found = await findLadder(requests, io, runtimeMinutes).catch(() => null)
  return found?.ladder ? withLadderOffer(measured, ladderOffer(found.ladder)) : null
}
