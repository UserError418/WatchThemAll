import { describe, expect, it } from 'vitest'

import { parsePlayerMessage } from './playermessage'

/**
 * The two payloads below are transcribed from an Android 16 emulator, captured
 * by listening on the app window while each provider actually played. They are
 * the specification — if a provider changes shape, these are what should be
 * re-measured rather than guessed at.
 */
const VIDFAST = {
  type: 'PLAYER_EVENT',
  data: {
    event: 'timeupdate',
    currentTime: 2.068976,
    duration: 3388.6349999999793,
    tmdbId: 95350,
    mediaType: 'tv',
    season: 1,
    episode: 1,
    playing: false,
    muted: true,
    volume: 0.8,
  },
}

const VIDEASY = {
  type: 'PLAYER_EVENT',
  data: {
    event: 'timeupdate',
    currentTime: 29.675498,
    duration: 3388,
    id: '95350',
    mediaType: 'tv',
    season: 1,
    episode: 1,
  },
}

describe('parsePlayerMessage', () => {
  it('reads VidFast, structured', () => {
    expect(parsePlayerMessage(VIDFAST)).toEqual({
      tmdbId: 95350,
      seconds: 2.068976,
      duration: 3388.6349999999793,
      season: 1,
      episode: 1,
      ended: false,
      playing: false,
    })
  })

  it('reads Videasy, structured', () => {
    expect(parsePlayerMessage(VIDEASY)).toEqual({
      tmdbId: 95350,
      seconds: 29.675498,
      duration: 3388,
      season: 1,
      episode: 1,
      ended: false,
      playing: null,
    })
  })

  it('reads the same payload posted as a JSON string', () => {
    expect(parsePlayerMessage(JSON.stringify(VIDFAST))).toEqual(parsePlayerMessage(VIDFAST))
  })

  it('accepts `timestamp` as an alias for `currentTime`', () => {
    const reading = parsePlayerMessage({
      type: 'PLAYER_EVENT',
      data: { event: 'timeupdate', timestamp: 129.5, duration: 3388, progress: 0.03 },
    })
    expect(reading?.seconds).toBe(129.5)
  })

  it('marks `ended`, which is the one reading that forgets a resume point', () => {
    const reading = parsePlayerMessage({
      type: 'PLAYER_EVENT',
      data: { event: 'ended', currentTime: 3388, duration: 3388 },
    })
    expect(reading?.ended).toBe(true)
  })

  it('does not mark `ended` for a position that merely reached the duration', () => {
    expect(parsePlayerMessage(VIDFAST)?.ended).toBe(false)
  })

  describe('ignores what is not a position report', () => {
    const rejected: Array<[string, unknown]> = [
      ['a non-object', 42],
      ['null', null],
      ['an array', [1, 2, 3]],
      ['a plain string', 'hello'],
      ['unparseable JSON that starts like an object', '{nope'],
      ['another app messaging our window', { type: 'ANALYTICS', data: { currentTime: 12 } }],
      // Measured alongside the timeupdates. Real, ours, and carrying no position.
      ['NEXT_EPISODE_AVAILABLE', { type: 'NEXT_EPISODE_AVAILABLE', data: { season: 1, episode: 2 } }],
      ['an event we do not act on', { type: 'PLAYER_EVENT', data: { event: 'volumechange', currentTime: 12 } }],
      ['no event name at all', { type: 'PLAYER_EVENT', data: { currentTime: 12 } }],
      ['no position', { type: 'PLAYER_EVENT', data: { event: 'timeupdate', duration: 3388 } }],
      ['a data field that is not an object', { type: 'PLAYER_EVENT', data: 'timeupdate' }],
    ]
    for (const [name, payload] of rejected) {
      it(name, () => expect(parsePlayerMessage(payload)).toBeNull())
    }
  })

  describe('refuses implausible numbers, which a hostile page can send freely', () => {
    const position = (currentTime: unknown): unknown => ({
      type: 'PLAYER_EVENT',
      data: { event: 'timeupdate', currentTime, duration: 3388 },
    })

    it.each([
      ['negative', -1],
      ['infinite', Number.POSITIVE_INFINITY],
      ['NaN', Number.NaN],
      ['a millisecond timestamp mistaken for seconds', 1_757_000_000_000],
      ['an empty string', ''],
      ['whitespace, which Number() reads as zero', '   '],
      ['not a number at all', 'soon'],
    ])('%s', (_name, value) => {
      expect(parsePlayerMessage(position(value))).toBeNull()
    })

    it('takes a numeric string, because one provider sends one', () => {
      expect(parsePlayerMessage(position('129.5'))?.seconds).toBe(129.5)
    })
  })

  describe('duration', () => {
    const withDuration = (duration: unknown): unknown => ({
      type: 'PLAYER_EVENT',
      data: { event: 'timeupdate', currentTime: 120, duration },
    })

    // Every threshold in `resume.ts` divides by or compares against duration,
    // and a zero one makes all of them meaningless. Absent is the honest
    // reading, and `resumeAction` already handles a null.
    it.each([
      ['zero', 0],
      ['negative', -1],
      ['missing', undefined],
      ['a string that is not a number', 'unknown'],
    ])('is null when %s', (_name, value) => {
      expect(parsePlayerMessage(withDuration(value))?.duration).toBeNull()
    })

    it('still reports the position when the duration is unusable', () => {
      expect(parsePlayerMessage(withDuration(0))?.seconds).toBe(120)
    })
  })

  describe('season and episode', () => {
    const withEpisode = (season: unknown, episode: unknown): unknown => ({
      type: 'PLAYER_EVENT',
      data: { event: 'timeupdate', currentTime: 120, duration: 3388, season, episode },
    })

    it('reads numeric strings, as one provider sends them', () => {
      expect(parsePlayerMessage(withEpisode('2', '7'))).toMatchObject({ season: 2, episode: 7 })
    })

    it('is null for a film, which names neither', () => {
      expect(parsePlayerMessage(withEpisode(undefined, undefined))).toMatchObject({
        season: null,
        episode: null,
      })
    })

    it('refuses a fractional episode rather than rounding one into existence', () => {
      expect(parsePlayerMessage(withEpisode(1, 1.5))?.episode).toBeNull()
    })
  })
})

/**
 * VidFast's whole progress store, transcribed from the emulator. Two shows,
 * because that is what exposed the trap: the payload is a library, only one
 * entry is about what is on screen, and which one that is has to be guessed.
 */
const MEDIA_DATA = {
  type: 'MEDIA_DATA',
  data: {
    t95350: {
      id: 95350,
      type: 'tv',
      title: 'Lanterns',
      progress: { watched: 5.120525, duration: 3388.6349999999793 },
      last_updated: 1789280633632,
      last_season_watched: 1,
      last_episode_watched: 1,
      show_progress: {
        s1e1: {
          season: 1,
          episode: 1,
          progress: { watched: 5.120525, duration: 3388.6349999999793 },
          last_updated: 1789280633632,
        },
      },
    },
    t247718: {
      id: 247718,
      type: 'tv',
      title: 'MobLand',
      progress: { watched: 23.222184, duration: 3558.0547229999975 },
      last_updated: 1789283063667,
      last_season_watched: 1,
      last_episode_watched: 1,
      show_progress: {
        s1e1: {
          season: 1,
          episode: 1,
          progress: { watched: 23.222184, duration: 3558.0547229999975 },
          last_updated: 1789283063667,
        },
      },
    },
  },
}

describe('parsePlayerMessage, over a provider progress store', () => {
  it('reads the entry the provider is currently writing, not the first one', () => {
    // MobLand carries the newer `last_updated`, so it is the one being played.
    // Lanterns is a leftover from an earlier session in the same WebView.
    expect(parsePlayerMessage(MEDIA_DATA)).toEqual({
      tmdbId: 247718,
      seconds: 23.222184,
      duration: 3558.0547229999975,
      season: 1,
      episode: 1,
      ended: false,
      playing: null,
    })
  })

  it('names the title, so a caller that asked for the other one can tell', () => {
    expect(parsePlayerMessage(MEDIA_DATA)?.tmdbId).not.toBe(95350)
  })

  it('reads a film, which has no per-episode breakdown', () => {
    const reading = parsePlayerMessage({
      type: 'MEDIA_DATA',
      data: {
        t550: {
          id: 550,
          type: 'movie',
          title: 'Fight Club',
          progress: { watched: 1200.5, duration: 8340 },
          last_updated: 1789283063667,
        },
      },
    })
    expect(reading).toMatchObject({ tmdbId: 550, seconds: 1200.5, season: null, episode: null })
  })

  it('prefers the episode position over the show-wide one', () => {
    // The top-level `progress` is where the *series* was left — episode four —
    // and filing that against episode one would resume an hour into a show the
    // user has just started.
    const reading = parsePlayerMessage({
      type: 'MEDIA_DATA',
      data: {
        t95350: {
          id: 95350,
          progress: { watched: 2000, duration: 3388 },
          last_updated: 1,
          last_season_watched: 1,
          last_episode_watched: 1,
          show_progress: {
            s1e1: { season: 1, episode: 1, progress: { watched: 120, duration: 3388 } },
            s1e4: { season: 1, episode: 4, progress: { watched: 2000, duration: 3388 } },
          },
        },
      },
    })
    expect(reading?.seconds).toBe(120)
  })

  it('says nothing when the named episode has no stored position yet', () => {
    expect(
      parsePlayerMessage({
        type: 'MEDIA_DATA',
        data: {
          t95350: {
            id: 95350,
            last_updated: 1,
            last_season_watched: 2,
            last_episode_watched: 9,
            show_progress: { s1e1: { progress: { watched: 120, duration: 3388 } } },
          },
        },
      }),
    ).toBeNull()
  })

  it('ignores an empty store', () => {
    expect(parsePlayerMessage({ type: 'MEDIA_DATA', data: {} })).toBeNull()
    expect(parsePlayerMessage({ type: 'MEDIA_DATA', data: null })).toBeNull()
  })
})
