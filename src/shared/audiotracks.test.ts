import { describe, expect, it } from 'vitest'
import { audioLanguage, isAudioList, languageList, masterAudio, trackLanguages } from './audiotracks'

describe('audioLanguage', () => {
  it('keeps the primary subtag of a language tag, lower case', () => {
    expect(audioLanguage('en')).toBe('en')
    expect(audioLanguage('en-US')).toBe('en')
    expect(audioLanguage('es-419')).toBe('es')
    expect(audioLanguage('PT_br')).toBe('pt')
  })

  it('turns three-letter codes into their two-letter form where one exists', () => {
    expect(audioLanguage('eng')).toBe('en')
    expect(audioLanguage('ger')).toBe('de')
    expect(audioLanguage('deu')).toBe('de')
    expect(audioLanguage('jpn')).toBe('ja')
    // One this does not know stays as it is: still a language, still shown.
    expect(audioLanguage('tgl')).toBe('tgl')
  })

  it('falls back on a name that is a language, and on nothing else', () => {
    expect(audioLanguage(null, 'English')).toBe('en')
    expect(audioLanguage('', 'Deutsch')).toBe('de')
    expect(audioLanguage(undefined, 'Commentary')).toBeNull()
    expect(audioLanguage(undefined, 'Track 2')).toBeNull()
  })

  it('names no language for the codes that say there is none', () => {
    expect(audioLanguage('und')).toBeNull()
    expect(audioLanguage('mul')).toBeNull()
    expect(audioLanguage('zxx', 'English')).toBe('en')
  })
})

describe('languageList', () => {
  it('keeps each code once, in the order first seen, and drops the unknown', () => {
    expect(languageList(['ja', null, 'en', 'ja', 'en'])).toEqual(['ja', 'en'])
  })
})

describe('masterAudio', () => {
  /** The shape real masters use: one audio group, one rendition per language. */
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="en-US",NAME="English",DEFAULT=YES,URI="en/a.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="deu",NAME="Deutsch",URI="de/a.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ac3",LANGUAGE="en",NAME="English 5.1",URI="en/b.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="fr",NAME="Français",URI="fr.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x800,AUDIO="aac",SUBTITLES="subs"',
    '1080.m3u8',
  ].join('\n')

  it('lists the languages of the audio renditions, each once', () => {
    expect(masterAudio(master)).toEqual(['en', 'de'])
  })

  it('reads a rendition named but not tagged, and skips one with neither', () => {
    const body = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Japanese",URI="ja.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Audio 2",URI="x.m3u8"',
    ].join('\n')
    expect(masterAudio(body)).toEqual(['ja'])
  })

  it('says nothing about a master without audio renditions, nor reads subtitles as sound', () => {
    expect(masterAudio('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\nhd.m3u8\n')).toEqual([])
    expect(masterAudio('#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,LANGUAGE="en",NAME="English",URI="s.m3u8"\n')).toEqual([])
  })

  it('does not take an attribute that only ends in LANGUAGE', () => {
    const body = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",X-ASSOC-LANGUAGE="fr",NAME="English",URI="a.m3u8"\n'
    expect(masterAudio(body)).toEqual(['en'])
  })
})

describe('trackLanguages', () => {
  it("reads an engine's tracks as the page reported them, skipping anything else", () => {
    expect(trackLanguages([{ language: 'ja', name: '日本語' }, { language: '', name: 'English' }, 'junk', null, { language: 7 }])).toEqual(['ja', 'en'])
    expect(trackLanguages('not a list')).toEqual([])
  })
})

describe('isAudioList', () => {
  it('accepts only what this module writes', () => {
    expect(isAudioList(['en', 'de', 'tgl'])).toBe(true)
    expect(isAudioList([])).toBe(true)
    expect(isAudioList(['EN'])).toBe(false)
    expect(isAudioList(['english'])).toBe(false)
    expect(isAudioList('en')).toBe(false)
    expect(isAudioList([1])).toBe(false)
  })
})
