import { describe, expect, it } from 'vitest'
import { groupDownloads, heightsLabel, overviewOf, runtimeLabel, seasonCountLabel, totalsOf } from './downloadgroups'
import { SpeedMeter, speedLabel, timeLeftLabel } from './downloadspeed'
import type { DownloadView } from '@shared/ipc'

let made = 0
function episode(tmdbId: number, season: number, ep: number, overrides: Partial<DownloadView> = {}): DownloadView {
  made += 1
  return {
    id: `tv-${tmdbId}-s${season}e${ep}-${made}`,
    subject: { tmdbId, imdbId: null, type: 'tv', title: `Show ${tmdbId}`, season, episode: ep, episodeName: null, runtimeMinutes: 22, posterPath: null },
    state: 'done',
    preferredProviderId: null,
    source: { id: 'vidsrc', name: 'VidSrc' },
    refusals: [],
    height: 720,
    format: 'ts',
    durationSeconds: 1320,
    segmentsTotal: 100,
    segmentsDone: 100,
    bytesDone: 200e6,
    estimatedBytes: 200e6,
    poster: null,
    error: null,
    createdAt: made,
    updatedAt: made,
    finishedAt: made,
    posterUrl: null,
    ...overrides,
  }
}

function film(tmdbId: number, overrides: Partial<DownloadView> = {}): DownloadView {
  const base = episode(tmdbId, 0, 0, overrides)
  return { ...base, id: `movie-${tmdbId}-${made}`, subject: { ...base.subject, type: 'movie', title: `Film ${tmdbId}`, season: null, episode: null } }
}

describe('groupDownloads', () => {
  it('puts every episode of a series in one card, seasons and episodes in order', () => {
    const list = [episode(1, 2, 3), episode(1, 1, 2), film(9), episode(1, 1, 1), episode(1, 2, 1)]
    const groups = groupDownloads(list)
    expect(groups).toHaveLength(2)
    const series = groups.find((g) => g.kind === 'series')!
    if (series.kind !== 'series') throw new Error('not a series')
    expect(series.seasons.map((s) => [s.season, s.episodes.map((e) => e.subject.episode)])).toEqual([
      [1, [1, 2]],
      [2, [1, 3]],
    ])
    expect(series.totals).toMatchObject({ count: 4, done: 4, bytes: 800e6, seconds: 4 * 1320 })
  })

  it('keeps two series apart, and newest download first', () => {
    const old = episode(1, 1, 1)
    const newer = episode(2, 1, 1)
    const newest = film(3)
    expect(groupDownloads([old, newer, newest]).map((g) => g.key)).toEqual([newest.id, 'tv-2', 'tv-1'])
  })

  it('puts a group with a download under way first', () => {
    const running = episode(1, 1, 1, { state: 'downloading' })
    const later = film(5)
    expect(groupDownloads([later, running]).map((g) => g.kind)).toEqual(['series', 'film'])
  })

  it('takes the poster from any episode that has one', () => {
    const [series] = groupDownloads([episode(1, 1, 1, { posterUrl: 'p.jpg' }), episode(1, 1, 2)])
    expect(series!.kind === 'series' && series!.posterUrl).toBe('p.jpg')
  })
})

describe('totals', () => {
  it('counts states, and lengths and qualities of finished downloads only', () => {
    const t = totalsOf([
      episode(1, 1, 1, { height: 480 }),
      episode(1, 1, 2, { height: 1080, source: { id: 'vidrock', name: 'VidRock' } }),
      episode(1, 1, 3, { state: 'downloading', height: 2160, bytesDone: 50e6 }),
      episode(1, 1, 4, { state: 'failed', bytesDone: 0 }),
    ])
    expect(t).toMatchObject({ count: 4, done: 2, underWay: 1, failed: 1, bytes: 450e6, seconds: 2640, heights: { low: 480, high: 1080 } })
    expect(t.sources[0]).toBe('VidSrc')
  })

  it('reads as words', () => {
    expect(heightsLabel({ low: 720, high: 720 })).toBe('720p')
    expect(heightsLabel({ low: 480, high: 1080 })).toBe('480p–1080p')
    expect(heightsLabel(null)).toBeNull()
    expect(runtimeLabel(0)).toBeNull()
    expect(runtimeLabel(48 * 60)).toBe('48 min')
    expect(runtimeLabel(125 * 60)).toBe('2 h 05 min')
    expect(seasonCountLabel(8, 10)).toBe('8 of 10 episodes')
    expect(seasonCountLabel(1, null)).toBe('1 episode')
  })

  it('adds up the device', () => {
    const groups = groupDownloads([episode(1, 1, 1), episode(1, 1, 2, { state: 'queued' }), film(2), episode(3, 1, 1, { state: 'failed' })])
    expect(overviewOf(groups)).toEqual({ films: 1, series: 2, episodes: 1, seconds: 2 * 1320, waiting: 1, failed: 1 })
  })
})

describe('SpeedMeter', () => {
  it('measures over a window and says how long is left', () => {
    const meter = new SpeedMeter()
    meter.observe('a', 0, 0, 0)
    expect(meter.reading({ bytes: 100e6, segments: 50 })).toBeNull()
    meter.observe('a', 10e6, 5, 5_000)
    const r = meter.reading({ bytes: 100e6, segments: 50 })!
    expect(r.bytesPerSecond).toBe(2e6)
    expect(r.secondsLeft).toBe(50)
    // No size estimate: from segments.
    expect(meter.reading({ bytes: null, segments: 50 })!.secondsLeft).toBe(50)
  })

  it('starts afresh for another download, and forgets samples past the window', () => {
    const meter = new SpeedMeter()
    meter.observe('a', 0, 0, 0)
    meter.observe('a', 1e6, 1, 3_000)
    meter.observe('b', 5e6, 2, 4_000)
    expect(meter.reading({ bytes: 1, segments: 1 })).toBeNull()
    meter.observe('b', 6e6, 3, 30_000)
    meter.observe('b', 8e6, 4, 34_000)
    expect(meter.reading({ bytes: 1, segments: 1 })!.bytesPerSecond).toBe(5e5)
  })

  it('reads as words', () => {
    expect(speedLabel(4.24e6)).toBe('4.2 MB/s')
    expect(speedLabel(640e3)).toBe('640 KB/s')
    expect(timeLeftLabel(30)).toBe('less than a minute left')
    expect(timeLeftLabel(12 * 60)).toBe('about 12 min left')
    expect(timeLeftLabel(65 * 60)).toBe('about 1 h 05 min left')
  })
})
