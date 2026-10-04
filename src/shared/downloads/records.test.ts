import { describe, expect, it } from 'vitest'
import { afterRestart, downloadId, downloadOf, newRecord, nextInQueue, playableDownload, readDownloadsFile, writeDownloadsFile } from './records'
import type { DownloadSubject } from './types'

const episode = (n: number): DownloadSubject => ({
  tmdbId: 1399,
  imdbId: 'tt0944947',
  type: 'tv',
  title: 'A Series',
  season: 1,
  episode: n,
  episodeName: `Episode ${n}`,
  runtimeMinutes: 55,
  posterPath: '/poster.jpg',
})

const film: DownloadSubject = { ...episode(0), tmdbId: 550, type: 'movie', season: null, episode: null, episodeName: null }

describe('the downloads file', () => {
  it('round-trips, with the quality cap', () => {
    const file = { quality: 720 as const, downloads: [newRecord(episode(1), null, 1_000)] }
    expect(readDownloadsFile(writeDownloadsFile(file))).toEqual(file)
  })

  it('keeps only well-formed records from a damaged file', () => {
    const good = newRecord(film, 'vidrock', 5)
    const text = JSON.stringify({ quality: 'nonsense', downloads: [good, { id: '../etc', state: 'done' }, null, { ...good, state: 'flying' }] })
    expect(readDownloadsFile(text)).toEqual({ quality: 'best', downloads: [good] })
    expect(readDownloadsFile('{')).toEqual({ quality: 'best', downloads: [] })
    expect(readDownloadsFile(null)).toEqual({ quality: 'best', downloads: [] })
  })
})

describe('finding a download', () => {
  const records = [
    { ...newRecord(episode(1), null, 1), state: 'done' as const },
    { ...newRecord(episode(2), null, 2), state: 'downloading' as const },
    { ...newRecord(film, null, 3), state: 'done' as const },
  ]

  it('by episode, and only a finished one plays', () => {
    expect(downloadOf(records, { tmdbId: 1399, type: 'tv', season: 1, episode: 2 })?.state).toBe('downloading')
    expect(playableDownload(records, { tmdbId: 1399, type: 'tv', season: 1, episode: 2 })).toBeNull()
    expect(playableDownload(records, { tmdbId: 1399, type: 'tv', season: 1, episode: 1 })).not.toBeNull()
  })

  it('tells a film from a series sharing its TMDB id', () => {
    expect(downloadOf(records, { tmdbId: 550, type: 'tv', season: null, episode: null })).toBeNull()
    expect(downloadOf(records, { tmdbId: 550, type: 'movie', season: null, episode: null })?.subject.title).toBe('A Series')
  })
})

describe('the queue', () => {
  it('runs the oldest waiting first', () => {
    const records = [
      { ...newRecord(episode(3), null, 30) },
      { ...newRecord(episode(1), null, 10), state: 'paused' as const },
      { ...newRecord(episode(2), null, 20) },
    ]
    expect(nextInQueue(records)?.subject.episode).toBe(2)
  })

  it('puts a run cut short by quitting back in the queue, and leaves a pause alone', () => {
    const records = afterRestart([
      { ...newRecord(episode(1), null, 1), state: 'downloading' },
      { ...newRecord(episode(2), null, 2), state: 'capturing' },
      { ...newRecord(episode(3), null, 3), state: 'paused' },
      { ...newRecord(episode(4), null, 4), state: 'done' },
    ])
    expect(records.map((r) => r.state)).toEqual(['queued', 'queued', 'paused', 'done'])
  })
})

describe('downloadId', () => {
  it('is safe in a path and a URL', () => {
    expect(downloadId(episode(12), 1_700_000_000_000)).toMatch(/^tv-1399-s1e12-[a-z0-9]+$/)
    expect(downloadId(film, 1)).toMatch(/^movie-550-film-[a-z0-9]+$/)
  })
})
