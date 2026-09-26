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
 * a 16:9 720p stream it is sharper than. So a rendition's class is taken from
 * whichever of its dimensions claims more, the width read as if it were 16:9.
 */

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

/**
 * The lower edge of each class.
 *
 * Generous on purpose, because encodes are cropped: a "1080p" film is 1920×800
 * or 1920×1036 as often as 1920×1080, and a "720p" one 1280×536. The edges sit
 * roughly two thirds of the way down to the class below, which is where no
 * real encode of either class lands.
 */
const CLASS_FLOOR: Record<(typeof CLASSES)[number], number> = {
  2160: 1800,
  1440: 1300,
  1080: 900,
  720: 600,
  480: 420,
  360: 300,
  240: 0,
}

/** The quality class of a rendition — 1080 for 1920×800, 720 for 1280×528. */
export function qualityClass(rendition: Rendition): number {
  const fromWidth = rendition.width === null ? 0 : Math.round((rendition.width * 9) / 16)
  const size = Math.max(rendition.height, fromWidth)
  return CLASSES.find((c) => size >= CLASS_FLOOR[c]) ?? 240
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
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (line !== '' && !line.startsWith('#')) {
      firstSegment ??= line
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
  return { init, initRange, firstSegment, seconds }
}

/**
 * The renditions of an HLS master.
 *
 * Only `#EXT-X-STREAM-INF` lines count. `#EXT-X-I-FRAME-STREAM-INF` carries a
 * `RESOLUTION` too, but it describes the thumbnails a player shows while
 * scrubbing — counting one would be reading a quality off the preview strip.
 * Audio renditions are `#EXT-X-MEDIA` lines and carry no resolution at all.
 */
function hlsRenditions(text: string): Rendition[] {
  const renditions: Rendition[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue
    // Anchored on a separator: a quoted CODECS value contains commas, and a
    // custom attribute could end in "RESOLUTION" without being it.
    const match = /(?:^|[:,])RESOLUTION=(\d+)x(\d+)/.exec(line)
    if (match) renditions.push({ width: Number(match[1]), height: Number(match[2]) })
  }
  return renditions
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
 * What one probe of one source could say about its quality.
 *
 * - `ladder` — a manifest listed its renditions, so the best is known.
 * - `player` — the player's own list of qualities, read from its API or from
 *   its quality menu, hidden or not.
 * - `single-file` — the source served one whole file. There is only one
 *   rendition, so the picture the page decoded *is* the best it offers.
 * - `single-rendition` — HLS without a master: the page fetched media playlists
 *   and never a list of renditions, so there is one, and its size is the best.
 *   Read from its init segment, or failing that from the picture.
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
  /** The best class the source offers, when that is known. */
  best: number | null
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
 * so the picture is a floor for the best quality, never a ceiling. Only a
 * single whole file makes the two the same thing.
 */
export function judgeQuality(evidence: QualityEvidence): QualityJudgement {
  const decoy = evidence.video?.runtime === 'implausible'
  const playing = evidence.video && !decoy ? qualityClass(evidence.video.rendition) : null
  const verdict = (outcome: QualityOutcome, best: number | null): QualityJudgement => ({
    outcome,
    best,
    playing,
    contradiction: best !== null && playing !== null && playing > best,
    decoy,
  })

  if (!evidence.streamed) return verdict('no-stream', null)

  const answered = evidence.playlists.filter((p) => p.status === 200)
  const offered = answered
    .map((p) => bestQuality(p.ladder))
    .filter((best): best is number => best !== null)
  if (offered.length > 0) return verdict('ladder', Math.max(...offered))

  // The player's own list outranks the picture for the same reason the ladder
  // does: an adaptive player decodes what suits it, not the best it has.
  const player = evidence.player ?? null
  if (player !== null) return verdict('player', Math.max(player, playing ?? 0))

  const masters = answered.some((p) => p.ladder.kind === 'hls-master')
  const media = answered.some((p) => p.ladder.kind === 'hls-media')
  if (evidence.wholeFiles > 0 && !masters && !media) return verdict('single-file', playing)
  // Every playlist a media playlist, and the page's whole traffic watched from
  // the first request: there was no master, so there is one rendition. Its
  // init segment and its picture describe the same frames; either will do.
  const declared = (evidence.declared ?? []).map(qualityClass)
  if (media && !masters && (declared.length > 0 || playing !== null)) {
    return verdict('single-rendition', Math.max(...declared, playing ?? 0))
  }
  if (masters || media) return verdict('unlabelled', null)
  if (evidence.playlists.length > answered.length) return verdict('sealed', null)
  return verdict('unreadable', null)
}
