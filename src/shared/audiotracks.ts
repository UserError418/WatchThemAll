/**
 * Which languages a stream can be heard in.
 *
 * Read from two places, both already in hand when a source is tested or
 * played: an HLS master's `#EXT-X-MEDIA:TYPE=AUDIO` lines, which list every
 * audio rendition with its `LANGUAGE` and `NAME`, and the streaming engine's
 * own list of audio tracks where the film relay can reach it (hls.js keeps
 * one, `audioTracks`, with `lang` and `name`).
 *
 * ## Dub or sub
 *
 * Nothing here decides whether a source is "dubbed" or "subtitled". When a
 * stream offers more than one language, the languages themselves are the
 * answer the viewer needs ("JA/EN": both), and a classifier on top would be a
 * guess about which one is the original. So the record is the list, and the
 * label prints it.
 *
 * ## The codes
 *
 * Kept as the primary subtag of a BCP-47 tag, lower case: "en", "de", "ja".
 * Packagers write `en`, `en-US`, `eng` and `English` for the same track, and
 * the label beside a source has room for two letters each. A region
 * ("es-419") is dropped with the rest of the tag; three-letter ISO 639-2 codes
 * become their two-letter form where one exists. A track that names no
 * language anything here can read is left out rather than guessed at, and so
 * are the codes for "undetermined" and "no language".
 */

/** ISO 639-2 codes, bibliographic and terminological, for the languages these streams carry. */
const THREE_LETTER: Readonly<Record<string, string>> = {
  ara: 'ar',
  chi: 'zh',
  zho: 'zh',
  cze: 'cs',
  ces: 'cs',
  dan: 'da',
  dut: 'nl',
  nld: 'nl',
  eng: 'en',
  fin: 'fi',
  fre: 'fr',
  fra: 'fr',
  ger: 'de',
  deu: 'de',
  gre: 'el',
  ell: 'el',
  heb: 'he',
  hin: 'hi',
  hun: 'hu',
  ind: 'id',
  ita: 'it',
  jpn: 'ja',
  kor: 'ko',
  nor: 'no',
  nob: 'no',
  pol: 'pl',
  por: 'pt',
  rum: 'ro',
  ron: 'ro',
  rus: 'ru',
  spa: 'es',
  swe: 'sv',
  tam: 'ta',
  tel: 'te',
  tha: 'th',
  tur: 'tr',
  ukr: 'uk',
  vie: 'vi',
}

/**
 * Track names that are a language's name, for tracks that give no `LANGUAGE`.
 * English and the language's own name; nothing else is read from a name, so
 * "Commentary" or "Track 2" stays unknown.
 */
const NAMES: Readonly<Record<string, string>> = {
  arabic: 'ar',
  chinese: 'zh',
  mandarin: 'zh',
  dutch: 'nl',
  nederlands: 'nl',
  english: 'en',
  french: 'fr',
  français: 'fr',
  francais: 'fr',
  german: 'de',
  deutsch: 'de',
  hindi: 'hi',
  italian: 'it',
  italiano: 'it',
  japanese: 'ja',
  korean: 'ko',
  polish: 'pl',
  polski: 'pl',
  portuguese: 'pt',
  português: 'pt',
  russian: 'ru',
  spanish: 'es',
  español: 'es',
  espanol: 'es',
  castellano: 'es',
  turkish: 'tr',
  türkçe: 'tr',
}

/** Codes that say there is no language to name: undetermined, several, none, uncoded. */
const NOT_A_LANGUAGE = new Set(['und', 'mul', 'zxx', 'mis'])

/** The most languages one record keeps; a master listing more is listing something else. */
const MAX_LANGUAGES = 12

/**
 * One track's language as a code, from its language tag or, failing that,
 * its name. Null when neither names a language this can read.
 */
export function audioLanguage(language: string | null | undefined, name?: string | null): string | null {
  const primary = (language ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? ''
  if (/^[a-z]{2}$/.test(primary)) return primary
  if (/^[a-z]{3}$/.test(primary) && !NOT_A_LANGUAGE.has(primary)) return THREE_LETTER[primary] ?? primary
  const word = (name ?? '').trim().toLowerCase()
  return NAMES[word] ?? null
}

/** Codes in the order first seen, each once, at most `MAX_LANGUAGES`. */
export function languageList(codes: Iterable<string | null>): string[] {
  const seen: string[] = []
  for (const code of codes) {
    if (code === null || seen.includes(code)) continue
    seen.push(code)
    if (seen.length >= MAX_LANGUAGES) break
  }
  return seen
}

/**
 * The languages of a list of tracks as a page reported them, each
 * `{ language, name }` (`audioTracksOf` in `enginereader.ts`). Anything else
 * in the list is skipped: a provider's page answered it.
 */
export function trackLanguages(tracks: unknown): string[] {
  if (!Array.isArray(tracks)) return []
  return languageList(
    tracks.map((track: unknown) => {
      const t = (typeof track === 'object' && track !== null ? track : {}) as Record<string, unknown>
      return audioLanguage(typeof t.language === 'string' ? t.language : null, typeof t.name === 'string' ? t.name : null)
    }),
  )
}

/** A quoted attribute of one playlist tag line, anchored on a separator as `streamquality.ts` reads them. */
function quoted(line: string, name: string): string | null {
  return new RegExp(`(?:^|[:,])${name}="([^"]*)"`).exec(line)?.[1] ?? null
}

/**
 * The languages an HLS master's audio renditions are in, in the order it
 * lists them. Empty for a master with no separate audio renditions, which
 * says nothing about the sound inside its video.
 */
export function masterAudio(body: string): string[] {
  const codes: Array<string | null> = []
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('#EXT-X-MEDIA:')) continue
    if (!/(?:^|[:,])TYPE=AUDIO(?:,|$)/.test(line)) continue
    codes.push(audioLanguage(quoted(line, 'LANGUAGE'), quoted(line, 'NAME')))
  }
  return languageList(codes)
}

/**
 * Whether a stored value is a list of language codes this module could have
 * written. Synced records come from the user's own Drive, where anything can
 * be edited, so a record's `audio` is checked like its other fields.
 */
export function isAudioList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_LANGUAGES &&
    value.every((code) => typeof code === 'string' && /^[a-z]{2,3}$/.test(code))
  )
}
