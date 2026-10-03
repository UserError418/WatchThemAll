/**
 * Two copies of one result settle on the one that knows more.
 *
 * The desktop files a play when its stream starts, then files it again under
 * the same key when the picture has climbed. If a sync uploaded the first copy
 * in between, the next sync merged `[re-filed, uploaded]`, the second copy won
 * because it came second, and the play kept no quality for good.
 */

import { describe, expect, it } from 'vitest'

import { mergeResults, type SourceResult } from './sourceresults'
import { ResultStore } from './store/results'
import { FakeDrive, MemoryFile } from './sync/fakedrive.fixture'
import { RESULTS_NAME, syncResults, type ResultsDocument } from './sync/results'

const NOW = Date.UTC(2026, 9, 1)

const play: SourceResult = {
  titleKey: 'movie:tt15398776',
  season: null,
  episode: null,
  providerId: 'vidrock',
  at: NOW,
  deviceId: 'desktop-1',
  deviceKind: 'desktop',
  origin: 'play',
  verdict: 'stream',
  ms: 3100,
}

describe('copies of one result', () => {
  it('keeps the quality a play was re-filed with over the copy uploaded before it', async () => {
    const drive = new FakeDrive()
    const results = new ResultStore(new MemoryFile(), () => NOW)
    await results.load()
    const host = { read: () => results.all(), adopt: (merged: SourceResult[]) => results.adopt(merged) }
    const backend = drive.backend<ResultsDocument>(RESULTS_NAME)

    results.record([play]) // the stream started
    await syncResults(host, backend, NOW) // the library sync after the history row carries the results
    results.record([{ ...play, quality: 1080 }]) // the picture climbed within the minute
    await syncResults(host, backend, NOW)

    expect(results.all()[0]!.quality).toBe(1080)
    expect((JSON.parse(drive.file(RESULTS_NAME)) as ResultsDocument).items[0]!.quality).toBe(1080)
  })

  it('settles the same way whichever side holds which copy', () => {
    const refiled = { ...play, quality: 1080 }
    expect(mergeResults([refiled], [play], NOW)).toEqual([refiled])
    expect(mergeResults([play], [refiled], NOW)).toEqual([refiled])
  })
})
