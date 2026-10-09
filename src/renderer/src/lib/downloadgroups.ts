/**
 * The Downloads tab's shape (the owner, 2026-10-04): one card per series,
 * its seasons folding out with their episodes, one per film; totals for the
 * whole device, each series and each season. Pure, so the grouping, the
 * order and every number are tested.
 *
 * Order: a group with a download running or waiting comes first, since that
 * is what the viewer is watching the page for; then the newest download
 * first. Within a series, seasons and episodes go in their own order.
 */

import type { DownloadView } from '@shared/ipc'
import { formatQuality } from '@shared/scanrank'
import { qualityClass } from '@shared/streamquality'
import { isUnderWay } from './downloads'

/** What a set of downloads adds up to. Sizes and lengths count what is on the device; lengths only finished downloads. */
export interface DownloadTotals {
  count: number
  done: number
  underWay: number
  paused: number
  failed: number
  bytes: number
  /** Seconds of video in the finished ones. */
  seconds: number
  /** Lowest and highest quality class among the finished ones, or null when none said. See `qualityLabel`. */
  qualities: { low: number; high: number } | null
  /** The sources they came from, most used first. */
  sources: string[]
}

export interface SeasonGroup {
  season: number
  episodes: DownloadView[]
  totals: DownloadTotals
}

export type DownloadGroup =
  | { kind: 'film'; key: string; download: DownloadView; totals: DownloadTotals; latestAt: number }
  | {
      kind: 'series'
      key: string
      tmdbId: number
      title: string
      posterUrl: string | null
      seasons: SeasonGroup[]
      totals: DownloadTotals
      latestAt: number
    }

export interface DownloadsOverview {
  films: number
  series: number
  /** Finished episodes, across every series. */
  episodes: number
  /** Seconds of video stored, finished downloads only. */
  seconds: number
  waiting: number
  failed: number
}

export function totalsOf(downloads: readonly DownloadView[]): DownloadTotals {
  const sources = new Map<string, number>()
  let low = Infinity
  let high = -Infinity
  const totals: DownloadTotals = { count: downloads.length, done: 0, underWay: 0, paused: 0, failed: 0, bytes: 0, seconds: 0, qualities: null, sources: [] }
  for (const d of downloads) {
    totals.bytes += d.bytesDone
    if (d.source) sources.set(d.source.name, (sources.get(d.source.name) ?? 0) + 1)
    if (isUnderWay(d)) totals.underWay += 1
    else if (d.state === 'paused') totals.paused += 1
    else if (d.state === 'failed') totals.failed += 1
    else if (d.state === 'done') {
      totals.done += 1
      totals.seconds += d.durationSeconds ?? 0
      if (d.height !== null) {
        const quality = qualityClass({ width: d.width ?? null, height: d.height })
        low = Math.min(low, quality)
        high = Math.max(high, quality)
      }
    }
  }
  if (low !== Infinity) totals.qualities = { low, high }
  totals.sources = [...sources.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name)
  return totals
}

/** "720p", "480p–1080p", or null. */
export function qualitiesLabel(qualities: DownloadTotals['qualities']): string | null {
  if (qualities === null) return null
  const { low, high } = qualities
  return low === high ? formatQuality(high) : `${formatQuality(low)}–${formatQuality(high)}`
}

/** Hours and minutes of video, as a total: "2 h 05 min", "48 min". */
export function runtimeLabel(seconds: number): string | null {
  if (seconds <= 0) return null
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

/** "8 of 10 episodes" when the season's length is known, "8 episodes" when not (offline). */
export function seasonCountLabel(done: number, episodesInSeason: number | null): string {
  const noun = (n: number): string => (n === 1 ? 'episode' : 'episodes')
  return episodesInSeason === null || episodesInSeason <= 0 ? `${done} ${noun(done)}` : `${done} of ${episodesInSeason} ${noun(episodesInSeason)}`
}

const latest = (downloads: readonly DownloadView[]): number => Math.max(...downloads.map((d) => d.createdAt))

export function groupDownloads(list: readonly DownloadView[]): DownloadGroup[] {
  const groups: DownloadGroup[] = []
  const series = new Map<number, DownloadView[]>()
  for (const d of list) {
    if (d.subject.type === 'movie' || d.subject.season === null) {
      groups.push({ kind: 'film', key: d.id, download: d, totals: totalsOf([d]), latestAt: d.createdAt })
      continue
    }
    const episodes = series.get(d.subject.tmdbId) ?? []
    episodes.push(d)
    series.set(d.subject.tmdbId, episodes)
  }
  for (const [tmdbId, episodes] of series) {
    const bySeason = new Map<number, DownloadView[]>()
    for (const e of episodes) {
      const season = e.subject.season ?? 0
      bySeason.set(season, [...(bySeason.get(season) ?? []), e])
    }
    const seasons = [...bySeason.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([season, list]) => {
        const sorted = [...list].sort((a, b) => (a.subject.episode ?? 0) - (b.subject.episode ?? 0))
        return { season, episodes: sorted, totals: totalsOf(sorted) }
      })
    // The newest download's name and poster: a series renamed on TMDB reads as it does now.
    const newest = [...episodes].sort((a, b) => b.createdAt - a.createdAt)
    groups.push({
      kind: 'series',
      key: `tv-${tmdbId}`,
      tmdbId,
      title: newest[0]!.subject.title,
      posterUrl: newest.find((e) => e.posterUrl !== null)?.posterUrl ?? null,
      seasons,
      totals: totalsOf(episodes),
      latestAt: latest(episodes),
    })
  }
  return groups.sort((a, b) => Number(b.totals.underWay > 0) - Number(a.totals.underWay > 0) || b.latestAt - a.latestAt)
}

export function overviewOf(groups: readonly DownloadGroup[]): DownloadsOverview {
  const overview: DownloadsOverview = { films: 0, series: 0, episodes: 0, seconds: 0, waiting: 0, failed: 0 }
  for (const group of groups) {
    if (group.kind === 'film') overview.films += 1
    else {
      overview.series += 1
      overview.episodes += group.totals.done
    }
    overview.seconds += group.totals.seconds
    overview.failed += group.totals.failed
    const all = group.kind === 'film' ? [group.download] : group.seasons.flatMap((s) => s.episodes)
    overview.waiting += all.filter((d) => d.state === 'queued').length
  }
  return overview
}
