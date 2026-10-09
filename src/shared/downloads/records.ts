/**
 * The downloads file (`downloads.json`, beside the library and never synced;
 * see `types.ts`) and the questions asked of its records: which download is
 * of this episode, which runs next, what an interrupted run becomes after a
 * restart. Pure: the platform reads and writes the text.
 */

import { QUALITY_CAPS, type DownloadRecord, type DownloadState, type DownloadSubject, type DownloadWhere, type QualityCap } from './types'

export interface DownloadsFile {
  quality: QualityCap
  /** The source every download tries first; null for Automatic. See `DownloadsStatus.preferredSourceId`. */
  preferredSourceId: string | null
  downloads: DownloadRecord[]
}

export const EMPTY_DOWNLOADS: DownloadsFile = { quality: 'best', preferredSourceId: null, downloads: [] }

const STATES: readonly DownloadState[] = ['queued', 'capturing', 'downloading', 'paused', 'failed', 'done']

const isNumberOrNull = (v: unknown): boolean => v === null || typeof v === 'number'
const isStringOrNull = (v: unknown): boolean => v === null || typeof v === 'string'

function isSubject(v: unknown): v is DownloadSubject {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  return (
    typeof s.tmdbId === 'number' &&
    isStringOrNull(s.imdbId) &&
    (s.type === 'movie' || s.type === 'tv') &&
    typeof s.title === 'string' &&
    isNumberOrNull(s.season) &&
    isNumberOrNull(s.episode) &&
    isStringOrNull(s.episodeName) &&
    isNumberOrNull(s.runtimeMinutes) &&
    isStringOrNull(s.posterPath)
  )
}

function isRecord(v: unknown): v is DownloadRecord {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    /^[a-z0-9-]+$/.test(r.id) &&
    isSubject(r.subject) &&
    STATES.includes(r.state as DownloadState) &&
    isStringOrNull(r.preferredProviderId) &&
    (r.source === null || (typeof r.source === 'object' && typeof (r.source as { id?: unknown }).id === 'string')) &&
    Array.isArray(r.refusals) &&
    isNumberOrNull(r.height) &&
    (r.width === undefined || isNumberOrNull(r.width)) &&
    (r.format === null || r.format === 'ts' || r.format === 'fmp4') &&
    isNumberOrNull(r.durationSeconds) &&
    typeof r.segmentsTotal === 'number' &&
    typeof r.segmentsDone === 'number' &&
    typeof r.bytesDone === 'number' &&
    isNumberOrNull(r.estimatedBytes) &&
    isStringOrNull(r.poster) &&
    isStringOrNull(r.error) &&
    typeof r.createdAt === 'number' &&
    typeof r.updatedAt === 'number' &&
    isNumberOrNull(r.finishedAt)
  )
}

/**
 * The file's contents, keeping only well-formed records: it is a file on disk
 * and may be damaged or from another build. A record dropped here leaves its
 * folder behind, which the manager's start-up sweep removes.
 */
export function readDownloadsFile(text: string | null): DownloadsFile {
  if (text === null) return { ...EMPTY_DOWNLOADS, downloads: [] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ...EMPTY_DOWNLOADS, downloads: [] }
  }
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_DOWNLOADS, downloads: [] }
  const file = raw as { quality?: unknown; preferredSourceId?: unknown; downloads?: unknown }
  const quality = QUALITY_CAPS.includes(file.quality as QualityCap) ? (file.quality as QualityCap) : 'best'
  // Absent in a file from before 2.0.17: Automatic, as it was.
  const preferredSourceId = typeof file.preferredSourceId === 'string' ? file.preferredSourceId : null
  const downloads = Array.isArray(file.downloads) ? file.downloads.filter(isRecord) : []
  return { quality, preferredSourceId, downloads }
}

export function writeDownloadsFile(file: DownloadsFile): string {
  return JSON.stringify(
    { version: 1, quality: file.quality, preferredSourceId: file.preferredSourceId, downloads: file.downloads },
    null,
    1,
  )
}

/** A folder name for a new download: unique, and safe in a URL path and on any file system. */
export function downloadId(subject: DownloadWhere, now: number): string {
  const episode = subject.season === null ? 'film' : `s${subject.season}e${subject.episode ?? 0}`
  return `${subject.type}-${subject.tmdbId}-${episode}-${now.toString(36)}`
}

/**
 * Whether a record is of this episode (or film). By TMDB id and type, not by
 * `titleKey`: a title without an IMDB id has one too, and a film and a series
 * can share a TMDB id.
 */
export function isOf(record: DownloadRecord, where: DownloadWhere): boolean {
  const s = record.subject
  return (
    s.tmdbId === where.tmdbId &&
    s.type === where.type &&
    (s.season ?? null) === (where.season ?? null) &&
    (s.episode ?? null) === (where.episode ?? null)
  )
}

/** The download of this episode, whatever its state. There is at most one. */
export function downloadOf(records: readonly DownloadRecord[], where: DownloadWhere): DownloadRecord | null {
  return records.find((r) => isOf(r, where)) ?? null
}

/** The finished download of this episode: what the player plays in a source's place. */
export function playableDownload(records: readonly DownloadRecord[], where: DownloadWhere): DownloadRecord | null {
  const found = downloadOf(records, where)
  return found?.state === 'done' ? found : null
}

/** The next to run: the oldest waiting. */
export function nextInQueue(records: readonly DownloadRecord[]): DownloadRecord | null {
  return records.filter((r) => r.state === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0] ?? null
}

/**
 * The records as a new start finds them. A run cut short by quitting (or a
 * crash) goes back into the queue and carries on by itself: its finished
 * segments are files, so nothing is fetched twice. A paused download stays
 * paused; the viewer stopped it.
 */
export function afterRestart(records: readonly DownloadRecord[]): DownloadRecord[] {
  return records.map((r) => (r.state === 'capturing' || r.state === 'downloading' ? { ...r, state: 'queued' } : r))
}

export function usedBytes(records: readonly DownloadRecord[]): number {
  return records.reduce((sum, r) => sum + r.bytesDone, 0)
}

/** A fresh record for a download asked for now, waiting its turn. */
export function newRecord(subject: DownloadSubject, preferredProviderId: string | null, now: number): DownloadRecord {
  return {
    id: downloadId(subject, now),
    subject,
    state: 'queued',
    preferredProviderId,
    source: null,
    refusals: [],
    height: null,
    width: null,
    format: null,
    durationSeconds: null,
    segmentsTotal: 0,
    segmentsDone: 0,
    bytesDone: 0,
    estimatedBytes: null,
    poster: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  }
}
