/**
 * What each kind of television decodes, and whether a stream's signature
 * fits it.
 *
 * ## Where the limits come from
 *
 * Google's published specifications, read 2026-10-09:
 *
 * - developers.google.com/cast/docs/media ("Supported Media for Google
 *   Cast"): the per-device video codec lines, quoted on each entry below;
 *   the audio codecs every device plays (HE-AAC, LC-AAC, MP3, Opus, Vorbis,
 *   FLAC, WAV); and AC-3 and E-AC-3 as *passthrough* only.
 * - support.google.com/chromecast/answer/3046409 (the consumer specs page):
 *   the Chromecast with Google TV (HD), which the developer page does not
 *   list: "Up to 1080p HDR, 60 fps".
 *
 * Every limit is therefore `verified: false`: it is what the specification
 * says, not what a television here was seen to do. The one exception is a
 * measurement (`MEASURED`): the owner's Chromecast (a plain dongle, mDNS
 * `md=Chromecast`) refused Videasy's H.264 at 2160x1080 with LOAD_FAILED on
 * 2026-09-26. The owner accepted that the rest comes from the spec until a
 * session in front of a television (2026-10-09).
 *
 * ## Which television is which
 *
 * By its model name: the desktop reads it from the mDNS TXT record's `md`
 * (`castdiscovery.ts`), the phone from `CastDevice.getModelName()`. A plain
 * Chromecast of any of the first three generations calls itself
 * "Chromecast", so that name gets the first and second generation's limits,
 * the stricter of the three. A model this does not recognise, or none, gets
 * the strictest profile in the table (`CONSERVATIVE`), so an unknown
 * television is never promised more than the least capable Chromecast plays.
 *
 * ## What a fit says, and does not
 *
 * - `no`: the codec, its profile, the frame or the frame rate is outside
 *   the published limits, or this model was measured refusing exactly this
 *   frame. The cast list hides the source, with the reason.
 * - `unknown`: the specification does not settle it. AC-3 and E-AC-3 play
 *   only when the television passes them to an amplifier, which nothing here
 *   can see; a level above the published one on a frame inside it often
 *   plays (encoders over-declare), and DRM-shaped encryption needs a licence
 *   the cast does not carry. The source is listed, not promised.
 * - `yes`: inside every published limit. Still a prediction: only a
 *   television's own answer proves it (`castability.ts`).
 */

import { AUDIO_CODEC_NAMES, VIDEO_CODEC_NAMES, type AudioCodec, type VideoCodec, type VideoSignature } from './codecnames'
import { describeVideo, type StreamSignature } from './streamsignature'

/** One frame size and rate a decoder is specified for: 1080p at 30 fps, 720p at 60. */
export interface DecodeMode {
  width: number
  height: number
  fps: number
}

/** What a television decodes of one video codec. */
export interface VideoLimit {
  codec: VideoCodec
  /** The profiles it decodes, by the names in `codecnames.ts`. */
  profiles: readonly string[]
  /** The highest level the specification names. */
  maxLevel: number | null
  /** The frame sizes and rates it is specified for; a frame fits one of them. */
  modes: readonly DecodeMode[]
  /** Never true here: the specification, not a measurement. See the header. */
  verified: boolean
  /** The specification's own words, for whoever checks this against a television. */
  spec: string
}

/** What a television was seen to do with one frame of one codec. */
export interface MeasuredFrame {
  codec: VideoCodec
  width: number
  height: number
  outcome: 'refused'
  /** Where and when, in words. */
  note: string
}

export interface ReceiverProfile {
  id: string
  /** The kind of television, in words: "a plain Chromecast". */
  name: string
  video: readonly VideoLimit[]
  /** Audio codecs it decodes itself. */
  audio: readonly AudioCodec[]
  /** Audio codecs it only passes on to an amplifier over HDMI: whether they play depends on what is attached. */
  passthrough: readonly AudioCodec[]
  /** What this model was seen to refuse. */
  measured: readonly MeasuredFrame[]
}

const SPEC_PAGE = 'developers.google.com/cast/docs/media, read 2026-10-09'
const CONSUMER_SPEC_PAGE = 'support.google.com/chromecast/answer/3046409, read 2026-10-09'

/** Every Cast device plays these itself, by the developer page. */
const AUDIO: readonly AudioCodec[] = ['aac', 'mp3', 'opus', 'vorbis', 'flac']
/** Passthrough only, by the developer page. */
const PASSTHROUGH: readonly AudioCodec[] = ['ac3', 'eac3']

const H264_PROFILES = ['constrained-baseline', 'baseline', 'main', 'high'] as const
/** 1080 is coded as 1088: a stream that declares the uncropped height is the same picture. */
const P1080 = { width: 1920, height: 1088 }
const P720 = { width: 1280, height: 720 }
const P2160 = { width: 4096, height: 2176 }

/**
 * The owner's measurement: Videasy's Silo stream, H.264 at 2160x1080,
 * refused by the owner's Chromecast with LOAD_FAILED (2026-09-26).
 */
const MEASURED_ON_CHROMECAST: readonly MeasuredFrame[] = [
  {
    codec: 'h264',
    width: 2160,
    height: 1080,
    outcome: 'refused',
    note: "refused with LOAD_FAILED by the owner's Chromecast (md=Chromecast), 2026-09-26",
  },
]

/** Chromecast, first and second generation; every plain Chromecast calls itself this, so the third gets these too. */
const CHROMECAST: ReceiverProfile = {
  id: 'chromecast',
  name: 'a plain Chromecast',
  video: [
    {
      codec: 'h264',
      profiles: H264_PROFILES,
      maxLevel: 4.1,
      modes: [
        { ...P1080, fps: 30 },
        { ...P720, fps: 60 },
      ],
      verified: false,
      spec: `"H.264 High Profile up to level 4.1 (720p/60fps or 1080p/30fps)", ${SPEC_PAGE}`,
    },
    {
      codec: 'vp8',
      profiles: [],
      maxLevel: null,
      modes: [
        { ...P1080, fps: 30 },
        { ...P720, fps: 60 },
      ],
      verified: false,
      spec: `"VP8 (720p/60fps or 1080p/30fps)", ${SPEC_PAGE}`,
    },
  ],
  audio: AUDIO,
  passthrough: PASSTHROUGH,
  measured: MEASURED_ON_CHROMECAST,
}

const CHROMECAST_ULTRA: ReceiverProfile = {
  id: 'chromecast-ultra',
  name: 'a Chromecast Ultra',
  video: [
    {
      codec: 'h264',
      profiles: H264_PROFILES,
      maxLevel: 4.2,
      modes: [{ ...P1080, fps: 60 }],
      verified: false,
      spec: `"H.264 High Profile up to level 4.2 (1080p/60fps)", ${SPEC_PAGE}`,
    },
    {
      codec: 'hevc',
      profiles: ['main', 'main10'],
      maxLevel: 5.1,
      modes: [{ ...P2160, fps: 60 }],
      verified: false,
      spec: `"HEVC / H.265 Main and Main10 Profiles up to level 5.1 (4K/60fps)", ${SPEC_PAGE}`,
    },
    {
      codec: 'vp9',
      profiles: ['profile0', 'profile2'],
      maxLevel: 5.1,
      modes: [{ ...P2160, fps: 60 }],
      verified: false,
      spec: `"VP9 Profile 0 and Profile 2 up to level 5.1 (4K/60fps)", ${SPEC_PAGE}`,
    },
    {
      codec: 'vp8',
      profiles: [],
      maxLevel: null,
      modes: [{ ...P2160, fps: 30 }],
      verified: false,
      spec: `"VP8 (4K/30fps)", ${SPEC_PAGE}`,
    },
  ],
  audio: AUDIO,
  passthrough: PASSTHROUGH,
  measured: [],
}

/** Chromecast with Google TV (4K), as the developer page lists it. */
const GOOGLE_TV_4K: ReceiverProfile = {
  id: 'google-tv-4k',
  name: 'a Chromecast with Google TV',
  video: [
    {
      codec: 'h264',
      profiles: H264_PROFILES,
      maxLevel: 5.1,
      modes: [{ ...P2160, fps: 30 }],
      verified: false,
      spec: `"H.264 High Profile up to level 5.1 (4Kx2K/30fps)", ${SPEC_PAGE}`,
    },
    {
      codec: 'hevc',
      profiles: ['main', 'main10'],
      maxLevel: 5.1,
      modes: [{ ...P2160, fps: 60 }],
      verified: false,
      spec: `"HEVC / H.265 Main and Main10 Profiles up to level 5.1 (4Kx2K@60fps)", ${SPEC_PAGE}`,
    },
    {
      codec: 'vp9',
      profiles: ['profile0', 'profile2'],
      maxLevel: null,
      modes: [{ ...P2160, fps: 60 }],
      verified: false,
      spec: `"VP9 Profile-2 up to 4Kx2K@60fps", ${SPEC_PAGE}`,
    },
  ],
  audio: AUDIO,
  passthrough: PASSTHROUGH,
  measured: [],
}

/**
 * Chromecast with Google TV (HD): not on the developer page. The consumer
 * page gives only "Up to 1080p HDR, 60 fps", so H.264 is held to the 4K
 * model's codec line within that frame, and nothing else is claimed: HEVC
 * and VP9 on it read as codecs this profile does not name, which hides
 * them. That errs strict, by the header's rule for what is not known.
 */
const GOOGLE_TV_HD: ReceiverProfile = {
  id: 'google-tv-hd',
  name: 'a Chromecast with Google TV (HD)',
  video: [
    {
      codec: 'h264',
      profiles: H264_PROFILES,
      maxLevel: 4.2,
      modes: [{ ...P1080, fps: 60 }],
      verified: false,
      spec: `"Up to 1080p HDR, 60 fps", ${CONSUMER_SPEC_PAGE}; codec line assumed from the 4K model`,
    },
  ],
  audio: AUDIO,
  passthrough: PASSTHROUGH,
  measured: [],
}

const GOOGLE_TV_STREAMER: ReceiverProfile = {
  id: 'google-tv-streamer',
  name: 'a Google TV Streamer',
  video: [
    {
      codec: 'h264',
      profiles: H264_PROFILES,
      maxLevel: 5.2,
      modes: [{ ...P2160, fps: 60 }],
      verified: false,
      spec: `"H.264 High Profile up to level 5.2 (4Kx2K/60fps)", ${SPEC_PAGE}`,
    },
    {
      codec: 'hevc',
      profiles: ['main', 'main10'],
      maxLevel: 5.1,
      modes: [{ ...P2160, fps: 60 }],
      verified: false,
      spec: `"HEVC / H.265 Main and Main10 Profiles up to level 5.1 (4Kx2K@60fps)", ${SPEC_PAGE}`,
    },
    {
      codec: 'vp9',
      profiles: ['profile0', 'profile2'],
      maxLevel: null,
      modes: [{ ...P2160, fps: 60 }],
      verified: false,
      spec: `"VP9 Profile-2 up to 4Kx2K@60fps", ${SPEC_PAGE}`,
    },
    {
      codec: 'av1',
      profiles: ['main'],
      maxLevel: 5.1,
      modes: [{ ...P2160, fps: 60 }],
      verified: false,
      spec: `"AV1 Main profile up to level 5.1 (4Kx2K@60fps)", ${SPEC_PAGE}`,
    },
  ],
  audio: AUDIO,
  passthrough: PASSTHROUGH,
  measured: [],
}

/**
 * For a television whose model is unknown or unrecognised: the plain
 * Chromecast's limits, the strictest in the table, under a name that says
 * the model was not known. The measurement stays with the model it was
 * made on.
 */
export const CONSERVATIVE: ReceiverProfile = { ...CHROMECAST, id: 'unknown', name: 'this TV', measured: [] }

/** Every profile, for the tests and for whoever reads the table. */
export const RECEIVER_PROFILES: readonly ReceiverProfile[] = [
  CHROMECAST,
  CHROMECAST_ULTRA,
  GOOGLE_TV_HD,
  GOOGLE_TV_4K,
  GOOGLE_TV_STREAMER,
  CONSERVATIVE,
]

/**
 * The profile for a television by its model name (`md`, `getModelName()`).
 *
 * Matched loosely, because the exact names the newer models announce were
 * not observed here: anything naming "Streamer", "Ultra" or "Google TV" goes
 * to that profile, a Google TV not named 4K to the HD one (the stricter),
 * and "Chromecast" alone to the plain dongle's.
 */
export function receiverProfile(model: string | null | undefined): ReceiverProfile {
  const name = (model ?? '').trim().toLowerCase()
  if (name === '') return CONSERVATIVE
  if (name.includes('streamer')) return GOOGLE_TV_STREAMER
  if (name.includes('ultra')) return CHROMECAST_ULTRA
  if (name.includes('google tv') || name === 'chromecast hd') return name.includes('4k') ? GOOGLE_TV_4K : GOOGLE_TV_HD
  if (name === 'chromecast') return CHROMECAST
  return CONSERVATIVE
}

/** Whether a signature fits a profile, with the reason in words when it does not, or may not. */
export interface ProfileFit {
  fit: 'yes' | 'no' | 'unknown'
  /**
   * In words, with the television as "this TV" (the list is for the one
   * chosen): "this TV can't play H.264 2160×1080". Null for `yes`.
   */
  reason: string | null
  /** True when the answer rests on a measurement on this model rather than on the specification. */
  measured: boolean
}

const YES: ProfileFit = { fit: 'yes', reason: null, measured: false }

/** How far a frame rate may run over a limit and still be it: 29.97 and 30 are one rate. */
const FPS_SLACK = 0.5

/**
 * Whether a stream with this signature fits what this television decodes;
 * see the header for what each answer claims.
 *
 * The first thing outside the limits decides: a measurement on this model,
 * then the codec, its profile, the frame and the frame rate (`no`); then
 * what only may not play (`unknown`): a level over the specification's,
 * passthrough audio, an unfamiliar audio codec, DRM-shaped encryption.
 */
export function fitsProfile(signature: StreamSignature, profile: ReceiverProfile): ProfileFit {
  const video = signature.video
  if (video === null) return { fit: 'unknown', reason: 'its video could not be read', measured: false }

  const measured = profile.measured.find(
    (m) => m.codec === video.codec && m.width === video.width && m.height === video.height,
  )
  if (measured) return { fit: 'no', reason: `a TV like this one refused ${describeVideo(video)}`, measured: true }

  const limit = video.codec === 'other' ? undefined : profile.video.find((l) => l.codec === video.codec)
  if (video.codec === 'other') return { fit: 'unknown', reason: `it uses ${VIDEO_CODEC_NAMES.other}`, measured: false }
  if (!limit) return no(`this TV can't play ${VIDEO_CODEC_NAMES[video.codec]}`)

  if (video.profile !== null && limit.profiles.length > 0 && !limit.profiles.includes(video.profile)) {
    return no(`this TV can't play ${VIDEO_CODEC_NAMES[video.codec]} ${profileName(video.profile)}`)
  }

  const frameFit = frameFits(video, limit.modes)
  if (frameFit === 'size') return no(`this TV can't play ${describeVideo(video)}`)
  if (frameFit === 'rate') return no(`this TV can't play ${describeVideo(video)} at ${Math.round(video.fps!)} fps`)
  if (frameFit === 'unknown') return { fit: 'unknown', reason: 'its picture size could not be read', measured: false }

  if (video.level !== null && limit.maxLevel !== null && video.level > limit.maxLevel + 1e-9) {
    return {
      fit: 'unknown',
      reason: `it declares ${VIDEO_CODEC_NAMES[video.codec]} level ${video.level}, above the ${limit.maxLevel} ${profile.name} is specified for`,
      measured: false,
    }
  }

  for (const audio of signature.audio) {
    if (profile.passthrough.includes(audio)) {
      return {
        fit: 'unknown',
        reason: `its ${AUDIO_CODEC_NAMES[audio]} sound plays only through an amplifier connected to the TV`,
        measured: false,
      }
    }
    if (!profile.audio.includes(audio)) {
      return { fit: 'unknown', reason: `its sound is ${AUDIO_CODEC_NAMES[audio]}`, measured: false }
    }
  }

  if (signature.encryption === 'sample-aes' || signature.encryption === 'other') {
    return { fit: 'unknown', reason: 'it is encrypted in a way a TV needs a licence for', measured: false }
  }
  return YES
}

function no(reason: string): ProfileFit {
  return { fit: 'no', reason, measured: false }
}

/**
 * Whether a frame fits one of the modes: `size` when no mode holds the frame
 * at all, `rate` when one holds it only at a lower frame rate, `unknown` when
 * the size is not known. A frame rate not known is judged by size alone:
 * films and series are 24 to 30 frames a second.
 */
function frameFits(video: VideoSignature, modes: readonly DecodeMode[]): 'yes' | 'size' | 'rate' | 'unknown' {
  if (video.width === null || video.height === null) return 'unknown'
  const holding = modes.filter((mode) => video.width! <= mode.width && video.height! <= mode.height)
  if (holding.length === 0) return 'size'
  if (video.fps === null) return 'yes'
  return holding.some((mode) => video.fps! <= mode.fps + FPS_SLACK) ? 'yes' : 'rate'
}

/** A profile's name as a person reads it: High 10, Main 10. */
function profileName(profile: string): string {
  const names: Record<string, string> = {
    high10: 'High 10',
    high422: 'High 4:2:2',
    high444: 'High 4:4:4',
    extended: 'Extended',
    main10: 'Main 10',
    rext: 'Range Extensions',
    'main-still': 'Main Still Picture',
    profile1: 'Profile 1',
    profile3: 'Profile 3',
    high: 'High',
    professional: 'Professional',
  }
  return names[profile] ?? profile
}
