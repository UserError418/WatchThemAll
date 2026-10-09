/**
 * How good a stream can get, read from what the stream says about itself.
 *
 * A stream's quality is not in its URL. An HLS master playlist lists every
 * rendition it offers with a `RESOLUTION`, and a DASH manifest gives each
 * `Representation` a width and height. A media playlist without its master
 * names no quality — but if it carries fMP4, its init segment states the one
 * rendition's size (`initsegment.ts`), and this module finds that segment for
 * the caller to fetch. Everything else is "unknown" rather than a guess.
 *
 * Pure and in `shared/`, so every side can take the same answer: the desktop
 * scan, the phone — which reaches the same manifests through a different
 * keyhole, `capture.peek` — and the store, which validates stored qualities
 * against `QUALITY_CLASSES`. Two parsers would disagree about one playlist.
 *
 * ## Quality is a class, not a height
 *
 * Films are rarely 16:9. Fight Club streams at 1920×800, which is a 1080p
 * release letterboxed to 2.40:1 — reading the height alone would call it
 * "800p", a number no provider's quality menu uses and one that ranks it below
 * a 16:9 720p stream it is sharper than. So a rendition is named for the
 * standard frame it was encoded to fill; see `qualityClass`.
 */

import type { QualityKind } from './types'

/** One rendition a manifest offers. Width is null when the manifest gave only a height. */
export interface Rendition {
  width: number | null
  height: number
}

export type LadderKind =
  /** An HLS master: a list of renditions. The only HLS shape that names a quality. */
  | 'hls-master'
  /** An HLS media playlist: one rendition's segments, with no word about its size. */
  | 'hls-media'
  | 'dash'
  /** Not a manifest at all — an API answer, a page, a segment fetched by mistake. */
  | 'unknown'

export interface Ladder {
  kind: LadderKind
  /** Every video rendition offered, best first. Empty when the manifest names none. */
  renditions: Rendition[]
}

/** The classes players label their menus with, best first. */
export const QUALITY_CLASSES: readonly number[] = [2160, 1440, 1080, 720, 480, 360, 240]
const CLASSES = QUALITY_CLASSES as readonly (2160 | 1440 | 1080 | 720 | 480 | 360 | 240)[]

/** The 16:9 frame each class is encoded to fit. */
const FRAME: Record<(typeof CLASSES)[number], { width: number; height: number }> = {
  2160: { width: 3840, height: 2160 },
  1440: { width: 2560, height: 1440 },
  1080: { width: 1920, height: 1080 },
  720: { width: 1280, height: 720 },
  480: { width: 854, height: 480 },
  360: { width: 640, height: 360 },
  240: { width: 426, height: 240 },
}

/**
 * How much of a frame's width or height an encode may have cropped away and
 * still count as filling it: edges trimmed of black, or a size rounded for
 * the codec. Silo on Videasy is 1913 wide; 5% of 1920 is 96 pixels.
 */
const CROP_ALLOWANCE = 0.05

/**
 * The quality class of a rendition: the best frame it fills, across or down.
 *
 * An encoder fits the picture into its class's frame, so one of the two
 * dimensions reaches the frame's edge and the other is whatever the film's
 * shape leaves. A wide film fills the width: Fight Club at 1920×800 is 1080p,
 * Silo on Videasy at 1913×800 too, and 1280×528 is 720p. A narrow film, or
 * one scaled by its height, fills the height: Videasy's own menu calls its
 * 1148×480 stream "480p", and so does this.
 *
 * The rule before 2026-10 read the width as if the picture were 16:9 and took
 * whichever dimension claimed more, with generous class edges. It called that
 * 1148×480 720p (1148 wide is 646 lines at 16:9), against the source's own
 * menu, and 1600×900 1080p. A picture that fills no frame of a class does not
 * get that class: 960×540 fills the 480 frame and neither edge of the 720
 * one, so it is 480p. Rounding down is the direction a label may err in;
 * claiming a class the picture does not reach is what sends the viewer to
 * the wrong source.
 */
export function qualityClass(rendition: Rendition): number {
  const reach = 1 - CROP_ALLOWANCE
  const fills = (frame: { width: number; height: number }): boolean =>
    rendition.height >= frame.height * reach || (rendition.width !== null && rendition.width >= frame.width * reach)
  return CLASSES.find((c) => fills(FRAME[c])) ?? 240
}

/** The best class a ladder offers, or null when it names none. */
export function bestQuality(ladder: Ladder): number | null {
  if (ladder.renditions.length === 0) return null
  return Math.max(...ladder.renditions.map(qualityClass))
}

/** Read a manifest body, whatever kind it turns out to be. */
export function readLadder(body: string): Ladder {
  const text = body.trimStart()
  if (text.startsWith('#EXTM3U')) {
    return /^#EXT-X-STREAM-INF:/m.test(text)
      ? { kind: 'hls-master', renditions: sorted(hlsRenditions(text)) }
      : { kind: 'hls-media', renditions: [] }
  }
  if (/<MPD[\s>]/.test(text)) return { kind: 'dash', renditions: sorted(dashRenditions(text)) }
  return { kind: 'unknown', renditions: [] }
}

/** What a media playlist says about its one rendition, short of its size. */
export interface MediaPlaylist {
  /**
   * The `#EXT-X-MAP` init segment, as written — relative to the playlist — or
   * null when the segments carry no separate init (MPEG-TS does not).
   */
  init: string | null
  /** The init segment's byte range within its file, when the playlist gives one. */
  initRange: { offset: number; length: number } | null
  /**
   * The first media segment, as written. Without an init segment, its opening
   * bytes are where MPEG-TS states the picture size; see `transportstream.ts`.
   */
  firstSegment: string | null
  /** The length the segments add up to, in seconds. */
  seconds: number
  /**
   * The first `#EXT-X-KEY` method other than `NONE` (`AES-128`,
   * `SAMPLE-AES`, …), as written; null when the segments are in the clear.
   * What a stream's signature says about its encryption
   * (`streamsignature.ts`): a receiver plays AES-128, and the others are DRM.
   */
  keyMethod: string | null
}

/**
 * Read a media playlist for what the stream's own bytes can then answer.
 *
 * Its length is how an ad's playlist is told from the title's: the same check
 * `runtimecheck.ts` puts the picture through. Its init segment is where fMP4
 * states its picture size (`initsegment.ts`), and its first segment is where
 * MPEG-TS does (`transportstream.ts`).
 */
export function readMediaPlaylist(body: string): MediaPlaylist {
  let init: string | null = null
  let initRange: MediaPlaylist['initRange'] = null
  let firstSegment: string | null = null
  let seconds = 0
  let keyMethod: string | null = null
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (line !== '' && !line.startsWith('#')) {
      firstSegment ??= line
    } else if (line.startsWith('#EXT-X-KEY:') && keyMethod === null) {
      const method = /(?:^|[:,])METHOD=([^,]+)/.exec(line)?.[1] ?? null
      if (method !== null && method !== 'NONE') keyMethod = method
    } else if (line.startsWith('#EXTINF:')) {
      const value = parseFloat(line.slice('#EXTINF:'.length))
      if (Number.isFinite(value) && value > 0) seconds += value
    } else if (line.startsWith('#EXT-X-MAP:') && init === null) {
      // Only the first: a playlist that switches init segments mid-stream is
      // switching encodes, and its opening one is what a player starts on.
      init = /(?:^|[:,])URI="([^"]+)"/.exec(line)?.[1] ?? null
      const range = /(?:^|[:,])BYTERANGE="(\d+)(?:@(\d+))?"/.exec(line)
      if (range) initRange = { length: Number(range[1]), offset: Number(range[2] ?? 0) }
    }
  }
  return { init, initRange, firstSegment, seconds, keyMethod }
}

/** One variant of an HLS master: its media playlist, and what the master says about it. */
export interface Variant {
  /** Absolute URL of the variant's media playlist. */
  url: string
  /** `BANDWIDTH`, bits per second; 0 when not given. */
  bandwidth: number
  /** From `RESOLUTION`; both null when the master gave none. */
  width: number | null
  height: number | null
}

/**
 * A variant with what the master says about its encoding: `CODECS` as
 * written (`avc1.640028,mp4a.40.2`) and `FRAME-RATE`, each null when not
 * given. What a television can decode is read from them
 * (`streamsignature.ts`); the quality is not, so `masterVariants` leaves
 * them out.
 */
export interface VariantDetails extends Variant {
  codecs: string | null
  frameRate: number | null
}

/** One `#EXT-X-STREAM-INF` line, and the URI on the line after it, as written. */
interface StreamInf {
  bandwidth: number
  width: number | null
  height: number | null
  codecs: string | null
  frameRate: number | null
  uri: string | null
}

/**
 * Every variant an HLS master lists: the one reading of a master in the app.
 *
 * There used to be two, this module's (sizes, for the quality) and the
 * segment window's (URLs, for downloads and the preview cache), and they
 * read the same lines differently: that one kept only the height, so a
 * download of 1920×800 said "800p" where the source list said 1080p, and it
 * matched attributes unanchored, so `AVERAGE-BANDWIDTH` could be read as the
 * bandwidth.
 *
 * Only `#EXT-X-STREAM-INF` lines count. `#EXT-X-I-FRAME-STREAM-INF` carries a
 * `RESOLUTION` too, but it describes the thumbnails a player shows while
 * scrubbing — counting one would be reading a quality off the preview strip.
 * Audio renditions are `#EXT-X-MEDIA` lines and carry no resolution at all.
 */
function streamInfs(text: string): StreamInf[] {
  const found: StreamInf[] = []
  let pending: StreamInf | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      // Anchored on a separator: a quoted CODECS value contains commas, and a
      // custom attribute could end in "RESOLUTION" without being it.
      const size = /(?:^|[:,])RESOLUTION=(\d+)x(\d+)/.exec(line)
      const bandwidth = Number(/(?:^|[:,])BANDWIDTH=(\d+)/.exec(line)?.[1] ?? 0)
      const codecs = /(?:^|[:,])CODECS="([^"]*)"/.exec(line)?.[1]?.trim() || null
      const rate = Number(/(?:^|[:,])FRAME-RATE=([\d.]+)/.exec(line)?.[1])
      pending = {
        bandwidth,
        width: size ? Number(size[1]) : null,
        height: size ? Number(size[2]) : null,
        codecs,
        frameRate: Number.isFinite(rate) && rate > 0 ? rate : null,
        uri: null,
      }
      found.push(pending)
    } else if (pending !== null && line !== '' && !line.startsWith('#')) {
      pending.uri = line
      pending = null
    }
  }
  return found
}

/** The variants of an HLS master fetched from `url`, with their playlists' URLs made absolute. */
export function masterVariants(body: string, url: string): Variant[] {
  return masterVariantDetails(body, url).map(({ url, bandwidth, width, height }) => ({ url, bandwidth, width, height }))
}

/** `masterVariants`, with each variant's codecs and frame rate as the master states them. */
export function masterVariantDetails(body: string, url: string): VariantDetails[] {
  return streamInfs(body).flatMap((inf) => {
    if (inf.uri === null) return []
    let resolved: string
    try {
      resolved = new URL(inf.uri, url).toString()
    } catch {
      return []
    }
    const { bandwidth, width, height, codecs, frameRate } = inf
    return [{ url: resolved, bandwidth, width, height, codecs, frameRate }]
  })
}

/** The renditions of an HLS master that state their size. */
function hlsRenditions(text: string): Rendition[] {
  return streamInfs(text).flatMap((inf) => (inf.height === null ? [] : [{ width: inf.width, height: inf.height }]))
}

/**
 * The video renditions of a DASH manifest.
 *
 * Each `Representation` with a height; failing those, the `AdaptationSet`'s own
 * size or its `maxWidth`/`maxHeight`, which some packagers use instead of
 * repeating the size on every representation. Audio representations carry no
 * height, so they drop out without being named.
 */
function dashRenditions(text: string): Rendition[] {
  const fromTags = (tag: string, widthAttr: string, heightAttr: string): Rendition[] => {
    const renditions: Rendition[] = []
    for (const [element] of text.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))) {
      const height = attribute(element, heightAttr)
      if (height !== null) renditions.push({ width: attribute(element, widthAttr), height })
    }
    return renditions
  }
  const representations = fromTags('Representation', 'width', 'height')
  if (representations.length > 0) return representations
  const sets = fromTags('AdaptationSet', 'width', 'height')
  return sets.length > 0 ? sets : fromTags('AdaptationSet', 'maxWidth', 'maxHeight')
}

/** A positive integer attribute of one XML start tag, or null. */
function attribute(element: string, name: string): number | null {
  const match = new RegExp(`\\s${name}="(\\d+)"`).exec(element)
  const value = match ? Number(match[1]) : NaN
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Best first, and each size once — masters repeat a size across bitrates and audio groups. */
function sorted(renditions: Rendition[]): Rendition[] {
  const seen = new Set<string>()
  return renditions
    .filter((r) => {
      const key = `${r.width ?? '?'}x${r.height}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => qualityClass(b) - qualityClass(a) || b.height - a.height)
}

/**
 * What one probe of one source could say about its quality, and what the
 * answer is worth (`QualityKind`: the best on offer, or a floor under it).
 *
 * - `ladder` — a manifest listed its renditions, so the best is known. Offered.
 * - `player` — the player's own list of qualities, read from its API or from
 *   its quality menu, hidden or not. Offered.
 * - `single-file` — the source served a whole file. When it is the only thing
 *   the page fetched, there is one rendition and the picture the page decoded
 *   *is* the best it offers (offered); beside other files or playlists it is
 *   one of several (a floor).
 * - `single-rendition` — HLS without a master: every playlist the page fetched
 *   was read, each a media playlist. Its size, from its init segment or its
 *   picture, is a floor: a source can keep its other qualities as separate
 *   streams that no master lists (Videasy's 1080p, 720p and 480p are each
 *   their own playlist, chosen in the page).
 * - `rung` — a media playlist was read, but another playlist the page fetched
 *   would not answer again, and a master may have been among those. What was
 *   read is the rung the player started on, a floor. Measured 2026-10-08:
 *   VidRock's master did not answer the scan, which read its variant as
 *   "single-rendition 480p" where the same episode's ladder offered 1080p.
 * - `unlabelled` — HLS that names no sizes and cannot be pinned down: a master
 *   without `RESOLUTION`, or no playlist or picture to go on.
 * - `sealed` — playlists went by, but none answered when asked for again.
 * - `unreadable` — it streamed, but through nothing this can read: segments
 *   only, a blob, a transport with no playlist in the clear.
 * - `no-stream` — nothing streamed, so there is nothing to judge.
 */
export type QualityOutcome =
  | 'ladder'
  | 'player'
  | 'single-file'
  | 'single-rendition'
  | 'rung'
  | 'unlabelled'
  | 'sealed'
  | 'unreadable'
  | 'no-stream'

export interface QualityEvidence {
  streamed: boolean
  /** Every playlist asked for again, and the status and ladder that came back. */
  playlists: Array<{ status: number; ladder: Ladder }>
  /** How many whole-file media requests (MP4, MKV, WebM) the page made. */
  wholeFiles: number
  /**
   * The picture the page was decoding at the end, from its longest `<video>`,
   * and whether that video's length fits the title. Null when none reported a
   * size.
   */
  video: { rendition: Rendition; runtime: 'plausible' | 'implausible' | 'unknown' } | null
  /** The best class the player itself lists, from its API or its menu; null if it said nothing. */
  player?: number | null
  /**
   * The sizes the stream's own init segments declare: one per fMP4 media
   * playlist whose length fits the title. The caller drops the rest — an ad's
   * playlist declares its size just as confidently.
   */
  declared?: Rendition[]
}

export interface QualityJudgement {
  outcome: QualityOutcome
  /** The best class the source offers, when that is known; or, as `kind` says, the least of it. */
  best: number | null
  /** What `best` is worth: the best on offer, or a floor under it. Null when `best` is. */
  kind: QualityKind | null
  /** The class the page was decoding, whatever the outcome; null if unknown or not the title. */
  playing: number | null
  /**
   * The page decoded a better picture than the ladder offers. That means the
   * ladder read is not the whole story — a second master, a different server —
   * and `best` understates. Rare, and worth seeing when it happens.
   */
  contradiction: boolean
  /** The decoded video's length did not fit the title: an ad or a decoy, so its size was ignored. */
  decoy: boolean
}

/**
 * Turn what one probe saw into a verdict on quality.
 *
 * The ladder outranks the picture: an adaptive player decodes whatever rung
 * suits its bandwidth and the size of its window — the probe's is 1280×720 —
 * so the picture is a floor for the best quality, never a ceiling. So is a
 * stream's own header, which describes the same one rendition. Only a list
 * of what is on offer is the best (`offered`): a ladder, the player's own
 * list, or a single whole file with nothing else beside it.
 */
export function judgeQuality(evidence: QualityEvidence): QualityJudgement {
  const decoy = evidence.video?.runtime === 'implausible'
  const playing = evidence.video && !decoy ? qualityClass(evidence.video.rendition) : null
  const verdict = (outcome: QualityOutcome, best: number | null, kind: QualityKind = 'floor'): QualityJudgement => ({
    outcome,
    best,
    kind: best === null ? null : kind,
    playing,
    contradiction: best !== null && playing !== null && playing > best,
    decoy,
  })

  if (!evidence.streamed) return verdict('no-stream', null)

  const answered = evidence.playlists.filter((p) => p.status === 200)
  const offered = answered
    .map((p) => bestQuality(p.ladder))
    .filter((best): best is number => best !== null)
  if (offered.length > 0) return verdict('ladder', Math.max(...offered), 'offered')

  // The player's own list outranks the picture for the same reason the ladder
  // does: an adaptive player decodes what suits it, not the best it has.
  const player = evidence.player ?? null
  if (player !== null) return verdict('player', Math.max(player, playing ?? 0), 'offered')

  const masters = answered.some((p) => p.ladder.kind === 'hls-master')
  const media = answered.some((p) => p.ladder.kind === 'hls-media')
  if (evidence.wholeFiles > 0 && !masters && !media) {
    // One file and nothing else fetched: its picture is all there is. A
    // second file, or any playlist, read or not, may be another quality.
    const alone = evidence.wholeFiles === 1 && evidence.playlists.length === 0
    return verdict('single-file', playing, alone ? 'offered' : 'floor')
  }
  // Media playlists and no master. The init segment and the picture describe
  // the same frames, so either names the rendition, and either is a floor: a
  // source may keep its other qualities as streams no master lists. Called a
  // single rendition only when every playlist the page fetched was read; one
  // that would not answer may have been the master.
  const declared = (evidence.declared ?? []).map(qualityClass)
  if (media && !masters && (declared.length > 0 || playing !== null)) {
    const unread = evidence.playlists.length > answered.length
    return verdict(unread ? 'rung' : 'single-rendition', Math.max(...declared, playing ?? 0))
  }
  if (masters || media) return verdict('unlabelled', null)
  if (evidence.playlists.length > answered.length) return verdict('sealed', null)
  return verdict('unreadable', null)
}
