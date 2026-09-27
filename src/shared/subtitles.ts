/**
 * Subtitle files, read: SubRip (`.srt`) and WebVTT (`.vtt`) into timed lines.
 *
 * v2 draws subtitles itself (`PlayerOverlay.svelte`), because a source's own
 * are drawn in its page, and its page is hidden. Where a source exposes no
 * usable track, the files come from OpenSubtitles (`main/subtitlesearch.ts`).
 * Those files carry the service's adverts as cues of their own ("Watch Online
 * Movies and Series for FREE www.osdb.link/…", measured 2026-09-27), and
 * often the credits of whoever made the file ("Subs collected, corrected and
 * if necessary adapted by …", over the opening of Breaking Bad). Both are
 * dropped here.
 *
 * Plain logic with no Electron in it, tested in `subtitles.test.ts`.
 */

/** A language OpenSubtitles has files in, for one title (`main/subtitlesearch.ts`). */
export interface SubtitleLanguage {
  /** OpenSubtitles' own id: ISO 639-2, `eng`, `ger`, `pob` for Brazilian Portuguese. */
  code: string
  /** ISO 639-1 where there is one, for matching a source's own tracks: `en`. */
  iso: string
  name: string
  /** How many files were found, of at most a hundred in the first answer. */
  count: number
}

/** A file read and ready to draw. */
export interface LoadedSubtitles {
  cues: Cue[]
  /** What was chosen, for the menu: "English · Breaking.Bad.S01E02…". */
  label: string
}

export interface Cue {
  /** Seconds into the film. */
  start: number
  end: number
  /** Plain text, one entry per line; markup such as `<i>` and `{\an8}` is removed. */
  lines: string[]
}

/** `00:01:02,345`, `00:01:02.345`, or `01:02.345` (WebVTT may omit the hours). */
function seconds(stamp: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})$/.exec(stamp.trim())
  if (!match) return null
  const [, h, m, s, ms] = match
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms!.padEnd(3, '0')) / 1000
}

/**
 * Lines that are not the film's words: the service's adverts, the file
 * maker's credits, and release names ("BDRip DVDRip HDTV"). Each phrase is
 * one no character says; "I stand corrected" must survive.
 */
const NOT_THE_FILM = new RegExp(
  [
    /osdb\.link|opensubtitles|advertise your product|become vip|support us and|api\.os/,
    /www\.[a-z0-9-]+\.[a-z]{2,}/,
    /subtitles by|\bsubs?\s+(?:collected|corrected|ripped|synced|by)\b/,
    /\b(?:re)?sync(?:ed|hronized)?\s+(?:(?:and|&)\s+\w+\s+)?by\b|\b(?:ripped|encoded|captioned) by\b|\btranscript(?:ion)? by\b/,
    /\b(?:bdrip|brrip|dvdrip|hdtv|web-?dl|webrip|x26[45])\b/,
  ]
    .map((part) => part.source)
    .join('|'),
  'i',
)

function clean(line: string): string {
  return line
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

/**
 * Parse either format. Blocks are separated by blank lines; a block's timing
 * line is the one with `-->`, whatever comes before it (an SRT counter, a VTT
 * cue id). `WEBVTT` headers, `NOTE` and `STYLE` blocks have no timing line and
 * fall away on their own.
 */
export function parseSubtitles(text: string): Cue[] {
  const cues: Cue[] = []
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/)
  for (const block of blocks) {
    const rows = block.split('\n')
    const timing = rows.findIndex((row) => row.includes('-->'))
    if (timing < 0) continue
    const [from, rest] = rows[timing]!.split('-->')
    const start = seconds(from ?? '')
    // VTT settings may follow the end time: `00:00:05.000 line:0 position:50%`.
    const end = seconds((rest ?? '').trim().split(/\s+/)[0] ?? '')
    if (start === null || end === null || end <= start) continue
    const lines = rows
      .slice(timing + 1)
      .map(clean)
      .filter((line) => line.length > 0)
    if (lines.length === 0 || lines.some((line) => NOT_THE_FILM.test(line))) continue
    cues.push({ start, end, lines })
  }
  return cues.sort((a, b) => a.start - b.start)
}

/**
 * The lines to show at `time`, from cues sorted by start. Overlapping cues
 * are all shown, in order.
 */
export function cuesAt(cues: readonly Cue[], time: number): string[] {
  // The first cue that has not ended yet, by bisection: cues are sorted by
  // start, and a film has a couple of thousand of them.
  let low = 0
  let high = cues.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (cues[mid]!.start <= time) low = mid + 1
    else high = mid
  }
  const lines: string[] = []
  // Walk back over the cues that started at or before `time`; long overlaps
  // are rare, so a short walk finds them all.
  for (let i = low - 1; i >= 0 && i >= low - 8; i--) {
    const cue = cues[i]!
    if (cue.end > time) lines.unshift(...cue.lines)
  }
  return lines
}
