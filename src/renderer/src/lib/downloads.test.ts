import { describe, expect, it } from 'vitest'
import { downloadEvents, downloadTitle, eventMessage, formatBytes, percentOf, stateLine } from './downloads'
import type { DownloadView } from '@shared/ipc'

function view(overrides: Partial<DownloadView> = {}): DownloadView {
  return {
    id: 'tv-1-s1e2-x',
    subject: { tmdbId: 1, imdbId: null, type: 'tv', title: 'Show', season: 1, episode: 2, episodeName: 'Two', runtimeMinutes: 22, posterPath: null },
    state: 'downloading',
    preferredProviderId: null,
    source: { id: 'vidrock', name: 'VidRock' },
    refusals: [],
    height: 1080,
    format: 'ts',
    durationSeconds: 1300,
    segmentsTotal: 200,
    segmentsDone: 50,
    bytesDone: 100e6,
    estimatedBytes: 400e6,
    poster: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    finishedAt: null,
    posterUrl: null,
    ...overrides,
  }
}

describe('the words', () => {
  it('says what a download is doing', () => {
    expect(stateLine(view())).toBe('Downloading · 25%')
    expect(stateLine(view({ state: 'capturing' }))).toBe('Finding the stream on VidRock…')
    expect(stateLine(view({ state: 'failed', error: 'VidRock plays something else here' }))).toBe('VidRock plays something else here')
    expect(stateLine(view({ state: 'done' }))).toBe('Downloaded')
  })

  it('never reads 100% before it is done, nor divides by nothing', () => {
    expect(percentOf(view({ segmentsDone: 199 }))).toBe(99)
    expect(percentOf(view({ segmentsTotal: 0, segmentsDone: 0 }))).toBe(0)
    expect(percentOf(view({ state: 'done', segmentsDone: 0 }))).toBe(100)
  })

  it('names the episode, or the film alone', () => {
    expect(downloadTitle(view())).toEqual({ title: 'Show', episode: 'S01E02 · Two' })
    expect(downloadTitle(view({ subject: { ...view().subject, type: 'movie', season: null, episode: null } }))).toEqual({ title: 'Show', episode: null })
  })

  it('formats sizes', () => {
    expect(formatBytes(0)).toBe('0 MB')
    expect(formatBytes(1_500)).toBe('2 KB')
    expect(formatBytes(781e6)).toBe('781 MB')
    expect(formatBytes(1.24e9)).toBe('1.2 GB')
  })
})

describe('downloadEvents', () => {
  it('announces a download that finished or failed since the last status, once', () => {
    const before = [view(), view({ id: 'b' })]
    const after = [view({ state: 'done' }), view({ id: 'b', state: 'failed', error: 'No room' })]
    const events = downloadEvents(before, after)
    expect(events.map((e) => e.kind)).toEqual(['done', 'failed'])
    expect(eventMessage(events[0]!)).toBe('Downloaded: Show S01E02')
    expect(eventMessage(events[1]!)).toBe('Download failed: Show S01E02. No room')
    expect(downloadEvents(after, after)).toEqual([])
  })

  it('announces nothing the app found on starting', () => {
    expect(downloadEvents(null, [view({ state: 'done' })])).toEqual([])
  })
})
