/**
 * Downloads (the owner, 2026-10-04): a film or an episode kept on the device
 * and played by the app's own player with no network, like a Netflix
 * download. These are the types every part shares: the record kept in
 * `downloads.json`, what the renderer is shown, and the quality cap.
 *
 * ## The pieces, and who runs them
 *
 * Everything in `shared/downloads/` is pure and runs on both platforms:
 * `records.ts` (the file and the queue's order), `plan.ts` (which playlist
 * is the film, at which quality, and the local playlist), `aes.ts`
 * (decrypting AES-128 segments), `transfer.ts` (fetching the segments,
 * politely and resumably) and `manager.ts` (the queue, the sources tried,
 * pause, resume, delete). A platform supplies only `DownloadPlatform`
 * (`manager.ts`): loading a source hidden to capture what it fetches, HTTP
 * with the source's headers, and files. The desktop's is
 * `src/main/downloadplatform.ts`.
 *
 * ## Device-local, never synced
 *
 * The files are on this device, so the records are too: `downloads.json`
 * sits beside the library and is not part of the synced document. A synced
 * record would promise another device a film it does not have.
 */

export type DownloadState =
  /** Waiting its turn: one download runs at a time. */
  | 'queued'
  /** A source is loaded hidden to learn where its stream is. */
  | 'capturing'
  /** Segments are being fetched. */
  | 'downloading'
  /** Stopped by the viewer; resumes where it stopped. */
  | 'paused'
  /** Stopped by a problem, said in `error`; can be resumed. */
  | 'failed'
  /** Complete: plays with no network. */
  | 'done'

/** The Settings choice: the best a source offers, or at most this many lines. */
export type QualityCap = 'best' | 1080 | 720 | 480

export const QUALITY_CAPS: readonly QualityCap[] = ['best', 1080, 720, 480]

/** What is downloaded: enough to list it, and to play it, with no network. */
export interface DownloadSubject {
  tmdbId: number
  imdbId: string | null
  type: 'movie' | 'tv'
  title: string
  /** Null for a film. */
  season: number | null
  episode: number | null
  episodeName: string | null
  /**
   * TMDB's runtime in minutes: the stream's length is held to it before a
   * byte is kept, and the player judges positions by it.
   */
  runtimeMinutes: number | null
  /** TMDB's poster path, fetched once into the download's folder for offline use. */
  posterPath: string | null
}

/** Asking for a download: the subject, and the source chosen by hand for the title, if any. */
export interface DownloadRequest extends DownloadSubject {
  providerId: string | null
}

export interface DownloadRecord {
  /** Its folder's name: letters, digits and dashes only. */
  id: string
  subject: DownloadSubject
  state: DownloadState
  /**
   * The source chosen by hand for the title when the download was asked for:
   * tried after the Downloads tab's preferred source (`DownloadsStatus.preferredSourceId`),
   * before the Automatic order, as Resume would.
   */
  preferredProviderId: string | null
  /** The source being tried, or the one the stream came from. */
  source: { id: string; name: string } | null
  /**
   * Sources that did not yield this film in the current attempt, and why, in
   * words. Skipped until the viewer resumes, which starts a fresh attempt.
   */
  refusals: Array<{ providerId: string; reason: string }>
  /** The picture's height in lines, when the playlist or the stream said. */
  height: number | null
  /** MPEG-TS or fragmented MP4 segments; either plays in the app's own player. */
  format: 'ts' | 'fmp4' | null
  durationSeconds: number | null
  segmentsTotal: number
  segmentsDone: number
  /** Bytes in the folder so far. */
  bytesDone: number
  /** What the whole will take, once the stream is known; null before. */
  estimatedBytes: number | null
  /** The poster image in the folder, by name. */
  poster: string | null
  /** Why it stopped, in words the viewer reads. */
  error: string | null
  createdAt: number
  updatedAt: number
  finishedAt: number | null
}

/** One download as the renderer sees it: the record, and where its poster is served. */
export interface DownloadView extends DownloadRecord {
  posterUrl: string | null
}

/** Everything the Downloads page, the detail view and Settings show. */
export interface DownloadsStatus {
  downloads: DownloadView[]
  quality: QualityCap
  /**
   * The source every download tries first (the owner, 2026-10-07: the
   * Downloads tab's dropdown); null for Automatic. When it cannot give the
   * film, the download carries on through the usual order. Kept on this
   * device beside the quality cap, never synced.
   */
  preferredSourceId: string | null
  /** Bytes all downloads take on disk, finished or not. */
  usedBytes: number
  /** Free space where they are kept; null when the platform cannot say. */
  freeBytes: number | null
}

/** Which episode (or film) a download is of: what the player and the buttons look it up by. */
export interface DownloadWhere {
  tmdbId: number
  type: 'movie' | 'tv'
  season: number | null
  episode: number | null
}

/**
 * The id the player knows a download by, in a source's place. It is in no
 * catalogue, and never filed as a test result or an outcome: a download
 * always plays, and counting it would teach the resume rule that this title
 * "streams" on a source that is not one.
 */
export const DOWNLOADED_SOURCE_ID = 'downloaded'
export const DOWNLOADED_SOURCE_NAME = 'Downloaded'

export function isDownloadedSource(providerId: string | null | undefined): boolean {
  return providerId === DOWNLOADED_SOURCE_ID
}
