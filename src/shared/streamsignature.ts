/**
 * What a television would have to decode to play a stream: its signature.
 *
 * ## Why (the owner, 2026-10-09)
 *
 * The cast list promised "Casts to this TV" for nearly every source, because
 * castability was predicted from the delivery's form alone: HLS or a whole
 * file meant yes. A form says nothing about the codecs inside it, and a plain
 * Chromecast decodes H.264 up to 1080p, no HEVC, and AC-3 only by passing it
 * to an amplifier. Measured on the owner's Chromecast: Videasy's H.264 at
 * 2160x1080 was refused with LOAD_FAILED. So the cast check during a test
 * (`castcheck.ts`) reads this signature, and the cast list holds it against
 * the chosen television's profile (`receivers.ts`).
 *
 * ## Where it is read from
 *
 * Three places, each in the encoder's or the packager's own words, laid
 * over each other field by field:
 *
 * - the master's `#EXT-X-STREAM-INF` (`CODECS`, `RESOLUTION`, `FRAME-RATE`),
 *   which declares what each variant holds;
 * - an fMP4 rendition's init segment, or a whole MP4's `moov`
 *   (`initsegment.ts`): each track's sample entry and decoder configuration;
 * - a TS rendition's first segment (`transportstream.ts`): the PMT's stream
 *   types and the SPS.
 *
 * The bytes win where they say something: they are what the decoder will
 * meet, while a master is a description someone typed into a packager. The
 * master fills what the bytes leave unknown, and adds the audio codec of a
 * rendition kept apart from the video. A media playlist's `#EXT-X-KEY` says
 * whether the segments are encrypted.
 *
 * Pure and in `shared/`: the desktop's and the phone's cast checks read the
 * same bytes through different keyholes, and must name them alike.
 */

import {
  AUDIO_CODEC_NAMES,
  h264Level,
  h264Profile,
  hevcLevel,
  hevcProfile,
  VIDEO_CODEC_NAMES,
  type AudioCodec,
  type VideoSignature,
} from './codecnames'
import type { InitSegmentCodecs } from './initsegment'
import type { TransportStreamCodecs } from './transportstream'

export type { AudioCodec, VideoCodec, VideoSignature } from './codecnames'

/** How the stream is packaged: HLS in MPEG-TS or fragmented MP4 segments, or one whole MP4 file. */
export type StreamContainer = 'ts' | 'fmp4' | 'mp4'

/**
 * Whether the segments are encrypted, and how. AES-128 is plain HLS
 * encryption with a key the proxy fetches like any segment; a receiver plays
 * it. SAMPLE-AES and common encryption (`other`) are DRM-shaped.
 */
export type StreamEncryption = 'none' | 'aes-128' | 'sample-aes' | 'other'

/** What a television would have to decode to play one rendition of a stream. */
export interface StreamSignature {
  /** Null when nothing said: a playlist whose segments were never read. */
  container: StreamContainer | null
  /** Null when nothing said what the video is: audio only, or never read. */
  video: VideoSignature | null
  /** Every audio codec, without repeats; empty when nothing said. */
  audio: AudioCodec[]
  encryption: StreamEncryption
}

/** Everything one rendition was read from, each absent or null where it was not. */
export interface SignatureEvidence {
  /** What the master says about the variant played: `CODECS` as written, `RESOLUTION`, `FRAME-RATE`. */
  variant?: { codecs: string | null; width: number | null; height: number | null; frameRate: number | null } | null
  /** The media playlist's first `#EXT-X-KEY` method other than NONE (`readMediaPlaylist`). */
  keyMethod?: string | null
  /** The media playlist names an init segment (`#EXT-X-MAP`): its segments are fragmented MP4. */
  initSegment?: boolean
  /** The init segment's reading. */
  init?: InitSegmentCodecs | null
  /** The first TS segment's reading. */
  segment?: TransportStreamCodecs | null
  /** A whole MP4 file's reading, from the head of the file. */
  file?: InitSegmentCodecs | null
}

/** The signature the evidence adds up to; see the header for which reading wins. */
export function streamSignature(evidence: SignatureEvidence): StreamSignature {
  const declared = evidence.variant?.codecs ? codecsAttribute(evidence.variant.codecs) : { video: null, audio: [] }
  const read = evidence.file ?? evidence.init ?? evidence.segment ?? null

  let video: VideoSignature | null = read?.video ?? null
  const fromMaster: VideoSignature | null =
    declared.video ??
    (evidence.variant && (evidence.variant.width !== null || evidence.variant.frameRate !== null)
      ? { codec: 'other', profile: null, level: null, width: null, height: null, fps: null }
      : null)
  if (fromMaster !== null) {
    if (evidence.variant) {
      fromMaster.width ??= evidence.variant.width
      fromMaster.height ??= evidence.variant.height
      fromMaster.fps ??= evidence.variant.frameRate
    }
    video = video === null ? fromMaster : overlay(video, fromMaster)
  }

  const audio = [...new Set([...(read?.audio ?? []), ...declared.audio])]

  const container: StreamContainer | null = evidence.file
    ? 'mp4'
    : evidence.initSegment || evidence.init
      ? 'fmp4'
      : evidence.segment
        ? 'ts'
        : null

  let encryption = encryptionOf(evidence.keyMethod ?? null)
  if (encryption === 'none' && evidence.segment?.sampleAes) encryption = 'sample-aes'
  if (encryption === 'none' && (evidence.init?.encrypted || evidence.file?.encrypted)) encryption = 'other'

  return { container, video, audio, encryption }
}

/** The bytes' reading, with the master's filling in whatever the bytes left unknown. */
function overlay(read: VideoSignature, declared: VideoSignature): VideoSignature {
  // A codec the bytes could not name is the master's, profile and level included.
  if (read.codec === 'other' && declared.codec !== 'other') return { ...declared, ...withoutNulls({ ...read, codec: declared.codec }) }
  if (declared.codec !== read.codec && declared.codec !== 'other') {
    // The master names another codec than the bytes hold: believe the bytes,
    // and take nothing else of the master's either but the frame rate.
    return { ...read, fps: read.fps ?? declared.fps }
  }
  return {
    codec: read.codec,
    profile: read.profile ?? declared.profile,
    level: read.level ?? declared.level,
    width: read.width ?? declared.width,
    height: read.height ?? declared.height,
    fps: read.fps ?? declared.fps,
  }
}

function withoutNulls<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null)) as Partial<T>
}

/** A playlist's `#EXT-X-KEY` method as an encryption. */
export function encryptionOf(keyMethod: string | null): StreamEncryption {
  if (keyMethod === null || keyMethod === 'NONE') return 'none'
  if (keyMethod === 'AES-128') return 'aes-128'
  if (keyMethod.startsWith('SAMPLE-AES')) return 'sample-aes'
  return 'other'
}

/**
 * What a `CODECS` attribute declares (RFC 6381): the first video codec, with
 * the profile and level its parameters encode, and every audio codec.
 *
 * - `avc1.640028`: H.264, `profile_idc` 0x64 (High), constraints 0x00, level
 *   0x28 (4.0). The legacy decimal form `avc1.100.40` reads the same.
 * - `hvc1.2.4.L153.B0`: HEVC, profile 2 (Main 10), tier L, level 153 (5.1).
 * - `vp09.00.40.08`: VP9 profile 0, level 4.0. `av01.0.08M.08`: AV1 Main,
 *   level index 8 (4.0).
 * - `mp4a.40.2` (AAC-LC), `mp4a.40.5` (HE-AAC), `mp4a.40.34` or `mp4a.6B`
 *   (MP3), `ac-3`, `ec-3`, `opus`, `flac`.
 *
 * Unfamiliar entries are `other`, never dropped: an unknown audio codec is a
 * reason a television might not play the stream, and saying nothing would
 * hide it.
 */
export function codecsAttribute(codecs: string): { video: VideoSignature | null; audio: AudioCodec[] } {
  let video: VideoSignature | null = null
  const audio: AudioCodec[] = []
  for (const entry of codecs.split(',').map((part) => part.trim()).filter(Boolean)) {
    const [kind = '', ...parameters] = entry.split('.')
    const sample = kind.toLowerCase()
    const sound = audioEntryCodec(sample, parameters)
    if (sound !== null) {
      if (!audio.includes(sound)) audio.push(sound)
      continue
    }
    video ??= videoEntryCodec(sample, parameters)
  }
  return { video, audio }
}

/** One `CODECS` entry as audio, or null when it is not an audio codec this names. */
function audioEntryCodec(sample: string, parameters: string[]): AudioCodec | null {
  switch (sample) {
    case 'mp4a': {
      // The object type: 40 is MPEG-4 audio (AAC, or MP3 as audio object type 34),
      // 66–68 MPEG-2 AAC, 69 and 6B MPEG audio (MP3).
      const objectType = (parameters[0] ?? '').toLowerCase()
      if (objectType === '69' || objectType === '6b') return 'mp3'
      if (objectType === '40' && parameters[1] === '34') return 'mp3'
      return 'aac'
    }
    case 'ac-3':
      return 'ac3'
    case 'ec-3':
      return 'eac3'
    case 'mp3':
      return 'mp3'
    case 'opus':
      return 'opus'
    case 'flac':
      return 'flac'
    case 'vorbis':
      return 'vorbis'
    default:
      return null
  }
}

/** One `CODECS` entry as video, with what its parameters say; `other` for an unfamiliar one. */
function videoEntryCodec(sample: string, parameters: string[]): VideoSignature {
  const unread = { profile: null, level: null, width: null, height: null, fps: null }
  switch (sample) {
    case 'avc1':
    case 'avc3': {
      const [first = '', second] = parameters
      if (second !== undefined) {
        // The legacy decimal form: profile.level.
        return { codec: 'h264', ...unread, profile: h264Profile(Number(first), 0), level: h264Level(Number(second)) }
      }
      if (!/^[0-9a-f]{6}$/i.test(first)) return { codec: 'h264', ...unread }
      const byte = (at: number): number => Number.parseInt(first.slice(at, at + 2), 16)
      return { codec: 'h264', ...unread, profile: h264Profile(byte(0), byte(2)), level: h264Level(byte(4)) }
    }
    case 'hvc1':
    case 'hev1': {
      // [profile space letter]profile_idc . compatibility . tier+level . constraints
      const profileIdc = Number((parameters[0] ?? '').replace(/^[A-C]/i, ''))
      const levelIdc = Number(/^[LH](\d+)$/i.exec(parameters[2] ?? '')?.[1])
      return {
        codec: 'hevc',
        ...unread,
        profile: Number.isFinite(profileIdc) ? hevcProfile(profileIdc) : null,
        level: Number.isFinite(levelIdc) ? hevcLevel(levelIdc) : null,
      }
    }
    case 'vp09': {
      const profile = Number(parameters[0])
      const level = Number(parameters[1])
      return {
        codec: 'vp9',
        ...unread,
        profile: Number.isInteger(profile) ? `profile${profile}` : null,
        level: Number.isFinite(level) ? level / 10 : null,
      }
    }
    case 'vp8':
    case 'vp08':
      return { codec: 'vp8', ...unread }
    case 'av01': {
      const profile = Number(parameters[0])
      const levelIndex = Number(/^(\d+)/.exec(parameters[1] ?? '')?.[1])
      return {
        codec: 'av1',
        ...unread,
        profile: ['main', 'high', 'professional'][profile] ?? null,
        level: Number.isFinite(levelIndex) ? 2 + (levelIndex >> 2) + (levelIndex & 3) / 10 : null,
      }
    }
    case 'mp2v':
      return { codec: 'mpeg2', ...unread }
    default:
      return { codec: 'other', ...unread }
  }
}

/**
 * The class a signature belongs to, for what a television said about it: a
 * refusal of one source's stream is filed under its class, and applies to
 * every source whose stream is of the same class on the same model of
 * television (`castability.ts`).
 *
 * Exact on purpose: the codec, profile, level, frame size, frame-rate band,
 * audio, packaging and encryption must all be the same. Generalising past the
 * frame the television was shown is the profile's job (`receivers.ts`), with
 * the spec behind it, not the evidence's: a refusal of 2160x1080 says nothing
 * certain about 1920x1080. Null when the video's codec or size is unknown,
 * since two unknowns are not known to be alike.
 */
export function signatureClass(signature: StreamSignature): string | null {
  const video = signature.video
  if (video === null || video.codec === 'other' || video.width === null || video.height === null) return null
  const band = video.fps === null ? '?' : video.fps <= 30.5 ? '30' : video.fps <= 60.5 ? '60' : 'high'
  const audio = [...signature.audio].sort().join('+') || 'none'
  return [
    signature.container ?? '?',
    video.codec,
    video.profile ?? '?',
    video.level ?? '?',
    `${video.width}x${video.height}`,
    `${band}fps`,
    audio,
    signature.encryption,
  ].join('/')
}

/** The video as a person reads it: "H.264 2160×1080", "HEVC Main 10 3840×1600". */
export function describeVideo(video: VideoSignature): string {
  const parts = [VIDEO_CODEC_NAMES[video.codec]]
  if (video.width !== null && video.height !== null) parts.push(`${video.width}×${video.height}`)
  return parts.join(' ')
}

/** An audio codec as a person reads it. */
export function describeAudio(codec: AudioCodec): string {
  return AUDIO_CODEC_NAMES[codec]
}

/** Whether a value read back from a stored result is a signature this build can read. */
export function isStreamSignature(value: unknown): value is StreamSignature {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  const nullableNumber = (v: unknown): boolean => v === null || (typeof v === 'number' && Number.isFinite(v))
  const nullableString = (v: unknown): boolean => v === null || typeof v === 'string'
  const video = s.video as Record<string, unknown> | null | undefined
  const videoOk =
    video === null ||
    (typeof video === 'object' &&
      video !== undefined &&
      typeof video.codec === 'string' &&
      nullableString(video.profile) &&
      nullableNumber(video.level) &&
      nullableNumber(video.width) &&
      nullableNumber(video.height) &&
      nullableNumber(video.fps))
  return (
    nullableString(s.container) &&
    videoOk &&
    Array.isArray(s.audio) &&
    s.audio.every((a) => typeof a === 'string') &&
    typeof s.encryption === 'string'
  )
}
