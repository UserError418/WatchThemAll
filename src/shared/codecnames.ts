/**
 * The words a stream's encoding is described in, shared by every parser that
 * reads one (`streamsignature.ts` for a master's `CODECS`, `initsegment.ts`
 * for an fMP4 init segment, `transportstream.ts` for a TS segment) and by the
 * receiver profiles that judge it (`receivers.ts`).
 *
 * One vocabulary, so the three readings of a stream can be laid over each
 * other and compared with a television's limits without translating: an
 * H.264 High stream is `{ codec: 'h264', profile: 'high' }` whichever bytes
 * said so. A module of its own, rather than part of `streamsignature.ts`,
 * because the parsers import these names and `streamsignature.ts` imports the
 * parsers.
 */

/** The video codecs a stream may carry. `other` for anything this does not name. */
export type VideoCodec = 'h264' | 'hevc' | 'vp8' | 'vp9' | 'av1' | 'mpeg2' | 'other'

/**
 * The audio codecs a stream may carry. AC-3 and E-AC-3 are named apart from
 * the rest because a plain Chromecast plays them only by passing them on to
 * an amplifier over HDMI (see `receivers.ts`).
 */
export type AudioCodec = 'aac' | 'mp3' | 'ac3' | 'eac3' | 'opus' | 'vorbis' | 'flac' | 'other'

/** What a stream says about its video, each field null where nothing said. */
export interface VideoSignature {
  codec: VideoCodec
  /**
   * The codec's profile by name: `baseline`, `constrained-baseline`, `main`,
   * `extended`, `high`, `high10`, `high422` or `high444` for H.264; `main`,
   * `main10` or `rext` for HEVC; `profile0` to `profile3` for VP9; `main`,
   * `high` or `professional` for AV1.
   */
  profile: string | null
  /** The level as written in the codec's own terms: 4.1 for H.264 level 41, 5.1 for HEVC level 153. */
  level: number | null
  width: number | null
  height: number | null
  /** Frames per second, when a master or the stream's own timing says. */
  fps: number | null
}

/**
 * An H.264 profile by `profile_idc` and the constraint flags byte after it.
 *
 * Constrained Baseline is Baseline with `constraint_set1_flag`: the subset
 * every decoder plays, and what most low rungs of a ladder are.
 */
export function h264Profile(profileIdc: number, constraints: number): string | null {
  switch (profileIdc) {
    case 66:
      return (constraints & 0x40) !== 0 ? 'constrained-baseline' : 'baseline'
    case 77:
      return 'main'
    case 88:
      return 'extended'
    case 100:
      return 'high'
    case 110:
      return 'high10'
    case 122:
      return 'high422'
    case 244:
      return 'high444'
    default:
      return null
  }
}

/** An H.264 level by `level_idc`: 41 is level 4.1. */
export function h264Level(levelIdc: number): number | null {
  return levelIdc > 0 ? levelIdc / 10 : null
}

/** An HEVC profile by `general_profile_idc`. */
export function hevcProfile(profileIdc: number): string | null {
  switch (profileIdc) {
    case 1:
      return 'main'
    case 2:
      return 'main10'
    case 3:
      return 'main-still'
    case 4:
      return 'rext'
    default:
      return null
  }
}

/** An HEVC level by `general_level_idc`, which is thirty times the level: 153 is level 5.1. */
export function hevcLevel(levelIdc: number): number | null {
  return levelIdc > 0 ? Math.round((levelIdc / 30) * 10) / 10 : null
}

/** The words a person reads for each codec, for the reasons the cast list gives. */
export const VIDEO_CODEC_NAMES: Record<VideoCodec, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
  mpeg2: 'MPEG-2',
  other: 'an unfamiliar video codec',
}

export const AUDIO_CODEC_NAMES: Record<AudioCodec, string> = {
  aac: 'AAC',
  mp3: 'MP3',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  opus: 'Opus',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  other: 'an unfamiliar audio codec',
}
