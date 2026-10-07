/**
 * Downloads, in the words and numbers the renderer shows: the state line,
 * the percentage, the size, and which changes deserve a toast. Pure, so the
 * strings (each with an edge case that would read as nonsense) are tested.
 */

import type { DownloadView, QualityCap } from '@shared/ipc'
import { episodeCode } from './format'

/** A download is under way: it takes its turn, is being captured, or is downloading. */
export function isUnderWay(download: DownloadView): boolean {
  return download.state === 'queued' || download.state === 'capturing' || download.state === 'downloading'
}

/** How far along, 0-100. A finished download is 100 whatever its counts say. */
export function percentOf(download: DownloadView): number {
  if (download.state === 'done') return 100
  if (download.segmentsTotal <= 0) return 0
  return Math.min(99, Math.floor((download.segmentsDone / download.segmentsTotal) * 100))
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  if (bytes <= 0) return '0 MB'
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

/** "1080p", or null when neither the playlist nor the stream said. */
export function qualityLabel(height: number | null): string | null {
  return height === null ? null : `${height}p`
}

export const QUALITY_LABELS: Record<string, string> = { best: 'Best available', 1080: 'Up to 1080p', 720: 'Up to 720p', 480: 'Up to 480p' }

/** The preferred-source menu's id for Automatic: a select's values are strings. */
export const AUTOMATIC_SOURCE = ''

/**
 * The Downloads tab's preferred-source menu: Automatic, then every enabled
 * provider in the user's order.
 *
 * A preference for a provider switched off since stays stored (switching it
 * back on brings the preference back) and is listed last, saying so: the
 * menu showing "Automatic" while another choice is kept would be the menu
 * lying about the setting. It is never tried while off (`sourceOrder`).
 */
export function preferredSourceOptions(
  enabled: ReadonlyArray<{ id: string; name: string }>,
  catalogue: ReadonlyArray<{ id: string; name: string }>,
  preferredSourceId: string | null,
): Array<{ id: string; label: string }> {
  const options = [{ id: AUTOMATIC_SOURCE, label: 'Automatic' }, ...enabled.map((p) => ({ id: p.id, label: p.name }))]
  if (preferredSourceId !== null && !enabled.some((p) => p.id === preferredSourceId)) {
    const name = catalogue.find((p) => p.id === preferredSourceId)?.name ?? preferredSourceId
    options.push({ id: preferredSourceId, label: `${name} (switched off)` })
  }
  return options
}

export function qualityCapLabel(cap: QualityCap): string {
  return QUALITY_LABELS[String(cap)] ?? 'Best available'
}

/** The title line: the film, or the series with the episode's code and name. */
export function downloadTitle(download: DownloadView): { title: string; episode: string | null } {
  const s = download.subject
  if (s.season === null || s.episode === null) return { title: s.title, episode: null }
  const code = episodeCode(s.season, s.episode)
  return { title: s.title, episode: s.episodeName ? `${code} · ${s.episodeName}` : code }
}

/** What it is doing, in a few words. */
export function stateLine(download: DownloadView): string {
  switch (download.state) {
    case 'queued':
      return 'Waiting'
    case 'capturing':
      return download.source ? `Finding the stream on ${download.source.name}…` : 'Finding the stream…'
    case 'downloading':
      return `Downloading · ${percentOf(download)}%`
    case 'paused':
      return `Paused · ${percentOf(download)}%`
    case 'failed':
      return download.error ?? 'Stopped'
    case 'done':
      return 'Downloaded'
  }
}

/** A finished or failed download since the last status: each is a toast. */
export interface DownloadEvent {
  kind: 'done' | 'failed'
  download: DownloadView
}

/**
 * The downloads that finished or failed between two statuses. Only a change
 * counts: a failure already shown is not shown again with every progress
 * update, and nothing is announced for what the first status already held.
 */
export function downloadEvents(previous: readonly DownloadView[] | null, next: readonly DownloadView[]): DownloadEvent[] {
  if (previous === null) return []
  const before = new Map(previous.map((d) => [d.id, d.state]))
  const events: DownloadEvent[] = []
  for (const download of next) {
    const was = before.get(download.id)
    if (was === undefined || was === download.state) continue
    if (download.state === 'done') events.push({ kind: 'done', download })
    else if (download.state === 'failed') events.push({ kind: 'failed', download })
  }
  return events
}

/** The toast for one of those. */
export function eventMessage(event: DownloadEvent): string {
  const { title, episode } = downloadTitle(event.download)
  const what = episode ? `${title} ${episode.split(' · ')[0]}` : title
  return event.kind === 'done' ? `Downloaded: ${what}` : `Download failed: ${what}. ${event.download.error ?? ''}`.trim()
}
