/**
 * The results file: what one sync of it takes, keeps and sends.
 */

import { describe, expect, it } from 'vitest'

import { syncResults, type ResultsDocument, type ResultsHost } from './results'
import type { RemoteDocument, SyncBackend } from './types'
import type { SourceResult } from '../sourceresults'

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

const result = (deviceId: string, at: number, providerId = 'a'): SourceResult => ({
  titleKey: 'tv:tt1',
  season: 1,
  episode: 1,
  providerId,
  at,
  deviceId,
  deviceKind: deviceId.startsWith('phone') ? 'phone' : 'desktop',
  origin: 'test',
  verdict: 'stream',
})

function hostWith(results: SourceResult[]): ResultsHost & { results: SourceResult[]; adoptions: number } {
  const host = {
    results,
    adoptions: 0,
    read: () => host.results,
    adopt: (next: SourceResult[]) => {
      host.results = next
      host.adoptions += 1
    },
  }
  return host
}

function backendWith(document: unknown | null): SyncBackend<ResultsDocument> & { pushed: ResultsDocument[] } {
  const backend = {
    pushed: [] as ResultsDocument[],
    pull: async (): Promise<RemoteDocument<ResultsDocument> | null> =>
      document === null ? null : { document: document as ResultsDocument, version: null },
    push: async (next: ResultsDocument) => {
      backend.pushed.push(next)
    },
  }
  return backend
}

describe('syncResults', () => {
  it("keeps every result from both sides and sends the union back", async () => {
    const mine = result('pc-1', NOW - 2 * DAY)
    const theirs = result('phone-1', NOW - DAY)
    const host = hostWith([mine])
    const backend = backendWith({ results: 1, items: [theirs] })

    expect(await syncResults(host, backend, NOW)).toEqual({ adopted: true, pushed: true })
    expect(host.results).toEqual([mine, theirs])
    expect(backend.pushed).toEqual([{ results: 1, items: [mine, theirs] }])
  })

  it('does nothing when both sides already agree', async () => {
    const both = [result('pc-1', NOW - DAY)]
    const host = hostWith(both)
    const backend = backendWith({ results: 1, items: both })

    expect(await syncResults(host, backend, NOW)).toEqual({ adopted: false, pushed: false })
    expect(host.adoptions).toBe(0)
  })

  it('creates the file on the first sync', async () => {
    const host = hostWith([result('pc-1', NOW - DAY)])
    const backend = backendWith(null)

    expect(await syncResults(host, backend, NOW)).toEqual({ adopted: false, pushed: true })
    expect(backend.pushed[0]?.items).toHaveLength(1)
  })

  it('drops malformed records and a file of the wrong shape instead of taking them in', async () => {
    const host = hostWith([])
    await syncResults(host, backendWith({ results: 1, items: [{ ...result('phone-1', NOW), verdict: 'great' }, 42] }), NOW)
    await syncResults(host, backendWith({ something: 'else' }), NOW)
    expect(host.results).toEqual([])
    expect(host.adoptions).toBe(0)
  })
})
