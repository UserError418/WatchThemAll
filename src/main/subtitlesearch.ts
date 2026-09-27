/**
 * Subtitles from OpenSubtitles, for sources that offer none of their own.
 *
 * Asked for by the owner (2026-09-27): v2 hides the source's page, and with
 * it the subtitles most sources draw there. Where a source exposes no usable
 * track, we fetch a file ourselves.
 *
 * The service is OpenSubtitles' old REST interface, which answers without an
 * API key. The newer API and Wyzie both refused without one (measured
 * 2026-09-27). The old interface is deprecated, so this can stop working
 * whenever OpenSubtitles turns it off, and everything here fails quietly
 * into "no subtitles" when it does.
 *
 * Privacy: a request names the title (IMDB id, season, episode) and the
 * language. It is made only when the viewer opens the subtitles menu or picks
 * a language, and for later episodes once a language has been picked
 * (`Settings.subtitleLanguage`). See docs/PRIVACY.md.
 */

import { parseSubtitles, type Cue, type LoadedSubtitles, type SubtitleLanguage } from '@shared/subtitles'

const BASE = 'https://rest.opensubtitles.org/search'
/** The old interface wants this header, and this is the value it documents for testing. */
const HEADERS = { 'X-User-Agent': 'TemporaryUserAgent' }
const TIMEOUT_MS = 12_000

export interface SubtitleQuery {
  imdbId: string | null
  season: number | null
  episode: number | null
}

/** One search result, as much of it as is used. */
export interface SubtitleFile {
  language: string
  iso: string
  languageName: string
  format: string
  url: string
  encoding: string
  /** The last subtitle's time, `HH:MM:SS`: how long the file's cut runs. */
  lastStamp: string
  downloads: number
  hearingImpaired: boolean
  release: string
}

function searchUrl(query: SubtitleQuery, language?: string): string | null {
  // Seven digits at least: an unpadded id is answered with a redirect to the
  // host `_`, which does not exist (measured 2026-09-27).
  const imdb = query.imdbId?.replace(/^tt/, '').padStart(7, '0')
  if (!imdb || !/^\d+$/.test(imdb)) return null
  // The interface wants its parameters in alphabetical order.
  const parts =
    query.season != null && query.episode != null
      ? [`episode-${query.episode}`, `imdbid-${imdb}`, `season-${query.season}`]
      : [`imdbid-${imdb}`]
  if (language) parts.push(`sublanguageid-${language}`)
  return `${BASE}/${parts.join('/')}`
}

function toFile(raw: Record<string, unknown>): SubtitleFile | null {
  const url = String(raw.SubDownloadLink ?? '')
  if (!url.startsWith('https://')) return null
  return {
    language: String(raw.SubLanguageID ?? ''),
    iso: String(raw.ISO639 ?? ''),
    languageName: String(raw.LanguageName ?? ''),
    format: String(raw.SubFormat ?? '').toLowerCase(),
    url,
    encoding: String(raw.SubEncoding ?? 'UTF-8'),
    lastStamp: String(raw.SubLastTS ?? ''),
    downloads: Number(raw.SubDownloadsCnt ?? 0) || 0,
    hearingImpaired: String(raw.SubHearingImpaired ?? '0') === '1',
    release: String(raw.MovieReleaseName ?? '').trim(),
  }
}

async function search(query: SubtitleQuery, language?: string): Promise<SubtitleFile[]> {
  const url = searchUrl(query, language)
  if (url === null) return []
  const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!response.ok) return []
  const body: unknown = await response.json()
  if (!Array.isArray(body)) return []
  return body.map((raw) => toFile(raw as Record<string, unknown>)).filter((f): f is SubtitleFile => f !== null)
}

/** The languages there are files in, most files first. */
export function languagesOf(files: readonly SubtitleFile[]): SubtitleLanguage[] {
  const byCode = new Map<string, SubtitleLanguage>()
  for (const file of files) {
    if (!file.language) continue
    const entry = byCode.get(file.language)
    if (entry) entry.count += 1
    else byCode.set(file.language, { code: file.language, iso: file.iso, name: file.languageName || file.language, count: 1 })
  }
  return [...byCode.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

const stampSeconds = (stamp: string): number | null => {
  const match = /^(\d+):(\d{2}):(\d{2})/.exec(stamp)
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null
}

/**
 * The files to try, best first.
 *
 * Timing matters most. A file made for another cut of the film drifts out of
 * step, and the one clue in a search result is when its last line is. That
 * should be a little before the film ends, where the credits start. After
 * that come files without the hearing-impaired descriptions, then the ones
 * the most people downloaded. Formats other than SubRip and WebVTT are left
 * out: MicroDVD counts frames, and the frame rate is not known here.
 */
export function rankFiles(files: readonly SubtitleFile[], filmSeconds: number | null): SubtitleFile[] {
  const fit = (file: SubtitleFile): number => {
    const last = stampSeconds(file.lastStamp)
    if (filmSeconds === null || last === null) return 1
    // Ends inside the film, no more than eight minutes before its end: a fit.
    const early = filmSeconds - last
    return early >= -30 && early <= 480 ? 0 : 1 + Math.min(Math.abs(early), 3600) / 3600
  }
  return files
    .filter((file) => file.format === 'srt' || file.format === 'vtt')
    .slice()
    .sort(
      (a, b) =>
        fit(a) - fit(b) ||
        Number(a.hearingImpaired) - Number(b.hearingImpaired) ||
        b.downloads - a.downloads,
    )
}

/**
 * Web streams rather than `node:zlib`, so this runs unchanged in the phone's
 * WebView (its `fetch` is native there, so the service's lack of CORS does
 * not matter) as well as in Electron's main process.
 */
async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function download(file: SubtitleFile): Promise<Cue[]> {
  const response = await fetch(file.url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!response.ok) return []
  let bytes = new Uint8Array(await response.arrayBuffer())
  // The download is gzip'd; the magic bytes say so either way.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes)
  let text: string
  try {
    text = new TextDecoder(file.encoding || 'utf-8').decode(bytes)
  } catch {
    // An encoding the runtime does not know: UTF-8 garbles accents, not timing.
    text = new TextDecoder('utf-8').decode(bytes)
  }
  return parseSubtitles(text)
}

/** Remembered for the session: the same title asked twice asks the service once. */
const cache = new Map<string, Promise<unknown>>()
function remembered<T>(key: string, make: () => Promise<T>): Promise<T> {
  let entry = cache.get(key) as Promise<T> | undefined
  if (!entry) {
    entry = make().catch((error: unknown) => {
      // A failure is not remembered: the next ask tries again.
      cache.delete(key)
      throw error
    })
    cache.set(key, entry)
  }
  return entry
}

const keyOf = (query: SubtitleQuery): string => `${query.imdbId}:${query.season ?? 'm'}:${query.episode ?? 'm'}`

/** The languages OpenSubtitles has for this title. Empty when it has none or cannot be reached. */
export async function subtitleLanguages(query: SubtitleQuery): Promise<SubtitleLanguage[]> {
  try {
    return await remembered(`languages:${keyOf(query)}`, async () => languagesOf(await search(query)))
  } catch {
    return []
  }
}

/**
 * The best file in `language` for this title and length, read. Tries the next
 * one when a file will not download or reads as nearly empty.
 */
export async function loadSubtitles(
  query: SubtitleQuery,
  language: string,
  filmSeconds: number | null,
): Promise<LoadedSubtitles | null> {
  try {
    return await remembered(`load:${keyOf(query)}:${language}`, async () => {
      const files = rankFiles(await search(query, language), filmSeconds)
      for (const file of files.slice(0, 3)) {
        const cues = await download(file).catch(() => [])
        if (cues.length >= 10) return { cues, label: `${file.languageName} · ${file.release || 'OpenSubtitles'}` }
      }
      return null
    })
  } catch {
    return null
  }
}
