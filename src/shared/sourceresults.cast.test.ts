/**
 * What a result carries about casting since 2.0.19, kept and synced whole.
 *
 * Three optional fields: the cast check a test filed on its own result, and
 * the model and signature a television's answer was given with. Each must
 * survive storing, syncing and merging; a malformed one is turned away like
 * any malformed field; and a build that does not know them must keep the
 * record, which it does because every build validates only the fields it
 * knows and keeps the object as it came (the 2.0.18 build included: its
 * `isSourceResult` names no field it was not written with).
 */

import { describe, expect, it } from 'vitest'

import { isSourceResult, mergeResults, resultsFromScan, type SourceResult } from './sourceresults'
import { ResultStore } from './store/results'
import type { StreamSignature } from './streamsignature'
import { FakeDrive, MemoryFile } from './sync/fakedrive.fixture'
import { RESULTS_NAME, syncResults, type ResultsDocument } from './sync/results'

const NOW = Date.UTC(2026, 9, 9)

const SIGNATURE: StreamSignature = {
  container: 'ts',
  video: { codec: 'h264', profile: 'high', level: 5, width: 2160, height: 1080, fps: 24 },
  audio: ['aac'],
  encryption: 'none',
}

const test: SourceResult = {
  titleKey: 'tv:tt14688458',
  season: 1,
  episode: 1,
  providerId: 'videasy',
  at: NOW,
  deviceId: 'desktop-1',
  deviceKind: 'desktop',
  origin: 'test',
  verdict: 'stream',
  ms: 4200,
}

const checked: SourceResult = { ...test, castCheck: { reach: 'ok', identity: 'film', seconds: 2700, signature: SIGNATURE } }

const refused: SourceResult = {
  ...test,
  at: NOW + 1,
  origin: 'play',
  delivery: 'segmented',
  cast: 'refused',
  castReceiver: 'Chromecast',
  castSignature: SIGNATURE,
}

describe('isSourceResult, for what a cast check and an answer carry', () => {
  it('takes them as this build writes them', () => {
    expect(isSourceResult(checked)).toBe(true)
    expect(isSourceResult(refused)).toBe(true)
    expect(isSourceResult({ ...test, castCheck: { reach: 'blocked', identity: 'unknown', status: 403 } })).toBe(true)
  })

  it("keeps a check whose words a newer build added: they are read as no check, and the test's verdict is not lost", () => {
    expect(isSourceResult({ ...test, castCheck: { reach: 'throttled', identity: 'trailer' } })).toBe(true)
  })

  it('turns away a malformed one, as any malformed field', () => {
    expect(isSourceResult({ ...test, castCheck: { reach: 1, identity: 'film' } })).toBe(false)
    expect(isSourceResult({ ...test, castCheck: { reach: 'ok' } })).toBe(false)
    expect(isSourceResult({ ...test, castCheck: { reach: 'ok', identity: 'film', pace: '1.2' } })).toBe(false)
    expect(isSourceResult({ ...test, castCheck: { reach: 'ok', identity: 'film', signature: { audio: 'aac' } } })).toBe(false)
    expect(isSourceResult({ ...refused, castReceiver: 42 })).toBe(false)
    expect(isSourceResult({ ...refused, castSignature: 'h264' })).toBe(false)
  })
})

describe('resultsFromScan, with a run’s cast checks', () => {
  it("files each check on its source's result, and only on one that streamed", () => {
    const filed = resultsFromScan(
      {
        titleKey: test.titleKey,
        at: NOW,
        verdicts: { videasy: 'stream', vidlux: 'dead' },
        testedAt: { videasy: NOW, vidlux: NOW },
        castChecks: { videasy: checked.castCheck!, vidlux: { reach: 'blocked', identity: 'unknown' } },
      },
      { deviceId: 'desktop-1', deviceKind: 'desktop' },
      { season: 1, episode: 1 },
    )
    expect(filed.find((r) => r.providerId === 'videasy')?.castCheck).toEqual(checked.castCheck)
    expect(filed.find((r) => r.providerId === 'vidlux')).not.toHaveProperty('castCheck')
  })
})

describe('copies of a result with a cast check', () => {
  it('settles on the copy with the check, whichever side holds it', () => {
    expect(mergeResults([checked], [test], NOW)).toEqual([checked])
    expect(mergeResults([test], [checked], NOW)).toEqual([checked])
  })

  it('round-trips through the store and the synced file whole, as an older build stores it too', async () => {
    const drive = new FakeDrive()
    const results = new ResultStore(new MemoryFile(), () => NOW)
    await results.load()
    const host = { read: () => results.all(), adopt: (merged: SourceResult[]) => results.adopt(merged) }
    const backend = drive.backend<ResultsDocument>(RESULTS_NAME)

    results.record([checked, refused])
    await syncResults(host, backend, NOW)

    const synced = (JSON.parse(drive.file(RESULTS_NAME)) as ResultsDocument).items
    expect(synced).toEqual([checked, refused])
    // A second device, starting empty, takes both back as they were.
    const other = new ResultStore(new MemoryFile(), () => NOW)
    await other.load()
    await syncResults({ read: () => other.all(), adopt: (merged: SourceResult[]) => other.adopt(merged) }, backend, NOW)
    expect(other.all()).toEqual([checked, refused])
  })
})
