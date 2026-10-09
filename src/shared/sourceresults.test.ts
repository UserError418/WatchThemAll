import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { RESULT_TTL_MS } from './scanrow'
import {
  deviceRows,
  isSourceResult,
  KEEP_MS,
  KEEP_PER_EPISODE,
  legacyResults,
  MAX_RESULTS,
  mergeResults,
  pruneResults,
  resultsFromScan,
  titleResults,
  type SourceResult,
} from './sourceresults'
import type { ProviderScan } from './types'

const now = 1_800_000_000_000
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const PC = { deviceId: 'pc-1', deviceKind: 'desktop' as const }
const PC2 = { deviceId: 'pc-2', deviceKind: 'desktop' as const }
const PHONE = { deviceId: 'phone-1', deviceKind: 'phone' as const }

/** One result; every field that matters to a test is named, the rest defaulted. */
function result(parts: Partial<SourceResult> & { ago?: number }): SourceResult {
  const { ago = HOUR, ...rest } = parts
  const device = rest.deviceId === undefined ? PC : { deviceId: rest.deviceId, deviceKind: rest.deviceKind ?? 'desktop' }
  return {
    titleKey: 'tv:tt1',
    season: 1,
    episode: 1,
    providerId: 'a',
    at: now - ago,
    ...device,
    origin: 'test',
    verdict: 'stream',
    ...rest,
  }
}

const read = (results: SourceResult[], episode: { season: number; episode: number } | null = { season: 1, episode: 1 }, here: 'desktop' | 'phone' = 'desktop', playedAt?: Record<string, number>) =>
  titleResults({ results, titleKey: 'tv:tt1', episode, here, now, ...(playedAt ? { playedAt } : {}) })

describe('pruneResults', () => {
  it('keeps the newest ten per source, episode and kind of device', () => {
    const many = Array.from({ length: 14 }, (_, i) => result({ ago: (i + 1) * MINUTE }))
    const phone = result({ ...PHONE, ago: 20 * MINUTE })
    const otherEpisode = result({ episode: 2, ago: 30 * MINUTE })
    const kept = pruneResults([...many, phone, otherEpisode], now)
    expect(kept.filter((r) => r.deviceKind === 'desktop' && r.episode === 1)).toEqual(many.slice(0, KEEP_PER_EPISODE).reverse())
    expect(kept).toContainEqual(phone)
    expect(kept).toContainEqual(otherEpisode)
  })

  it('drops what is older than the keeping time, and keeps a result once however often it arrives', () => {
    const old = result({ ago: KEEP_MS + MINUTE })
    const recent = result({})
    expect(pruneResults([old, recent, recent], now)).toEqual([recent])
  })

  it('holds its bounds and its order for any history', () => {
    const arbitraryResult = fc.record({
      provider: fc.constantFrom('a', 'b'),
      episode: fc.constantFrom(1, 2),
      phone: fc.boolean(),
      ago: fc.integer({ min: 0, max: KEEP_MS + DAY }),
    })
    fc.assert(
      fc.property(fc.array(arbitraryResult, { maxLength: 60 }), (drawn) => {
        const history = drawn.map((d) =>
          result({ providerId: d.provider, episode: d.episode, ago: d.ago, ...(d.phone ? PHONE : PC) }),
        )
        const kept = pruneResults(history, now)
        const groups = new Map<string, number>()
        for (const r of kept) {
          const key = `${r.providerId}/${r.episode}/${r.deviceKind}`
          groups.set(key, (groups.get(key) ?? 0) + 1)
          expect(now - r.at).toBeLessThanOrEqual(KEEP_MS)
        }
        for (const count of groups.values()) expect(count).toBeLessThanOrEqual(KEEP_PER_EPISODE)
        expect(kept.map((r) => r.at)).toEqual([...kept.map((r) => r.at)].sort((x, y) => x - y))
        // Pruning twice changes nothing: a sync that repeats is harmless.
        expect(pruneResults(kept, now)).toEqual(kept)
      }),
      { numRuns: 200 },
    )
  })

  it('bounds the whole history, newest kept', () => {
    const titles = Array.from({ length: MAX_RESULTS + 5 }, (_, i) => result({ titleKey: `movie:tt${i}`, season: null, episode: null, ago: i + 1 }))
    const kept = pruneResults(titles, now)
    expect(kept).toHaveLength(MAX_RESULTS)
    expect(kept.at(-1)).toEqual(titles[0])
  })
})

describe('isSourceResult', () => {
  it('takes what this app writes, and nothing malformed', () => {
    const good = result({ ms: 1_000, quality: 1080, delivery: 'segmented', cast: 'played' })
    expect(isSourceResult(good)).toBe(true)
    expect(isSourceResult({ ...good, season: null, episode: null })).toBe(true)
    expect(isSourceResult({ ...good, verdict: 'great' })).toBe(false)
    expect(isSourceResult({ ...good, at: Number.NaN })).toBe(false)
    expect(isSourceResult({ ...good, deviceKind: 'tv' })).toBe(false)
    expect(isSourceResult({ ...good, ms: '1000' })).toBe(false)
    expect(isSourceResult({ ...good, reason: 'slow' })).toBe(false)
    expect(isSourceResult(null)).toBe(false)
  })

  it('turns away a result for a download, which is not a source', () => {
    // The phone filed one until 2.0.18, casting a download.
    expect(isSourceResult(result({ providerId: 'downloaded', origin: 'play', delivery: 'segmented' }))).toBe(false)
  })
})

describe('mergeResults', () => {
  it("is every result either device had, whichever side it is merged from", () => {
    const mine = [result({ ago: 2 * HOUR }), result({ ago: HOUR })]
    const theirs = [result({ ...PHONE, ago: 90 * MINUTE }), mine[1]!]
    const merged = mergeResults(mine, theirs, now)
    expect(merged).toEqual([mine[0], theirs[0], mine[1]])
    expect(mergeResults(theirs, mine, now)).toEqual(merged)
  })
})

describe('resultsFromScan', () => {
  it('turns a test row into one result per source, with the details that belong to each', () => {
    const scan: ProviderScan = {
      titleKey: 'tv:tt1',
      at: now,
      verdicts: { a: 'stream', b: 'dead' },
      testedAt: { a: now - MINUTE, b: now },
      timings: { a: 2_000 },
      qualities: { a: 1080 },
      reasons: { b: { kind: 'error', status: 404 } },
      delivery: { a: 'segmented' },
    }
    const results = resultsFromScan(scan, PC, { season: 2, episode: 3 })
    expect(results).toEqual([
      {
        titleKey: 'tv:tt1',
        season: 2,
        episode: 3,
        providerId: 'a',
        at: now - MINUTE,
        ...PC,
        origin: 'test',
        verdict: 'stream',
        ms: 2_000,
        quality: 1080,
        delivery: 'segmented',
      },
      {
        titleKey: 'tv:tt1',
        season: 2,
        episode: 3,
        providerId: 'b',
        at: now,
        ...PC,
        origin: 'test',
        verdict: 'dead',
        reason: { kind: 'error', status: 404 },
      },
    ])
  })
})

describe('legacyResults', () => {
  it("reads the old title-wide rows as results of the whole title, each device's as its own", () => {
    const mine: ProviderScan = { titleKey: 'tv:tt1', at: now - HOUR, verdicts: { a: 'dead' } }
    const theirs = { titleKey: 'tv:tt1', at: now - 2 * HOUR, verdicts: { a: 'stream' as const }, ...PHONE }
    const results = legacyResults({ providerScans: [mine], sharedScans: [theirs] }, PC)
    expect(results.map((r) => [r.deviceId, r.verdict, r.season, r.episode])).toEqual([
      ['pc-1', 'dead', null, null],
      ['phone-1', 'stream', null, null],
    ])
  })
})

describe('titleResults', () => {
  it('is empty when nothing was measured', () => {
    expect(read([])).toEqual({ scan: null, sharedFrom: {} })
  })

  it("decides each episode by its own results: a source can serve episode 1 and not episode 2", () => {
    const history = [
      result({ providerId: 'a', episode: 1, verdict: 'stream', ms: 1_500 }),
      result({ providerId: 'a', episode: 2, verdict: 'dead', reason: { kind: 'error', status: 404 } }),
      result({ providerId: 'b', episode: 2, verdict: 'stream', ms: 3_000 }),
    ]
    expect(read(history, { season: 1, episode: 1 }).scan?.verdicts).toEqual({ a: 'stream', b: 'stream' })
    expect(read(history, { season: 1, episode: 2 }).scan?.verdicts).toEqual({ a: 'dead', b: 'stream' })
    expect(read(history, { season: 1, episode: 2 }).scan?.reasons).toEqual({ a: { kind: 'error', status: 404 } })
  })

  it('falls back to the season, then to the whole title, for an episode nothing measured', () => {
    const history = [
      result({ providerId: 'a', season: 1, episode: 4, verdict: 'dead', ago: HOUR }),
      result({ providerId: 'a', season: 2, episode: 1, verdict: 'stream', ago: 2 * HOUR }),
      result({ providerId: 'b', season: null, episode: null, verdict: 'stream' }),
    ]
    const scan = read(history, { season: 1, episode: 9 }).scan
    // The season says dead, although the newest title-wide result would not.
    expect(scan?.verdicts).toEqual({ a: 'dead', b: 'stream' })
    expect(read(history, { season: 3, episode: 1 }).scan?.verdicts).toEqual({ a: 'dead', b: 'stream' })
    expect(read(history, { season: 2, episode: 5 }).scan?.verdicts.a).toBe('stream')
  })

  it('lets the newest test decide, whatever it says', () => {
    const history = [result({ verdict: 'stream', ago: 2 * HOUR }), result({ verdict: 'dead', ago: HOUR })]
    expect(read(history).scan?.verdicts).toEqual({ a: 'dead' })
    expect(read([...history, result({ origin: 'play', verdict: 'stream', ago: MINUTE })]).scan?.verdicts).toEqual({ a: 'stream' })
  })

  it('weighs a failure seen while playing below a test: one makes a source amber, two in a row red', () => {
    const tested = result({ verdict: 'stream', ago: 3 * HOUR })
    const refused = { origin: 'play' as const, verdict: 'dead' as const, reason: { kind: 'refused' as const, status: 403 } }
    const once = [tested, result({ ...refused, ago: 2 * HOUR })]
    expect(read(once).scan?.verdicts).toEqual({ a: 'unsure' })
    expect(read(once).scan?.reasons).toEqual({ a: refused.reason })
    const twice = [...once, result({ ...refused, ago: HOUR })]
    expect(read(twice).scan?.verdicts).toEqual({ a: 'dead' })
    // A success in between breaks the run.
    const broken = [...once, result({ origin: 'preview', verdict: 'stream', ago: 90 * MINUTE }), result({ ...refused, ago: HOUR })]
    expect(read(broken).scan?.verdicts).toEqual({ a: 'unsure' })
    // And a failure older than the test that decided is history.
    expect(read([result({ ...refused, ago: 5 * HOUR }), tested]).scan?.verdicts).toEqual({ a: 'stream' })
  })

  it('takes the median time of the latest successes, and the best quality among them', () => {
    const history = [
      result({ ms: 9_000, quality: 1080, ago: 7 * HOUR }),
      result({ ms: 1_000, ago: 6 * HOUR }),
      result({ ms: 2_000, quality: 720, ago: 5 * HOUR }),
      result({ ms: 30_000, ago: 4 * HOUR }),
      result({ ms: 3_000, origin: 'play', ago: 3 * HOUR }),
      result({ origin: 'play', quality: 480, ago: 2 * HOUR }),
      result({ ms: 2_500, origin: 'preview', ago: HOUR }),
    ]
    const scan = read(history).scan
    // The latest five: 2 500, (none), 3 000, 30 000, 2 000 → median of four.
    expect(scan?.timings).toEqual({ a: 2_750 })
    // The 1080 is the sixth newest: outside the sample.
    expect(scan?.qualities).toEqual({ a: 720 })
  })

  it('has no time or quality beside anything but a green', () => {
    const scan = read([result({ ms: 1_000, quality: 1080, ago: 2 * HOUR }), result({ verdict: 'unsure', ago: HOUR })]).scan
    expect(scan?.timings).toEqual({})
    expect(scan?.qualities).toEqual({})
  })

  it('reads two desktops as one kind: what one measured decides for the other', () => {
    const history = [result({ verdict: 'dead', ago: 2 * HOUR }), result({ ...PC2, verdict: 'stream', ms: 1_000, ago: HOUR })]
    expect(read(history)).toEqual(expect.objectContaining({ sharedFrom: {} }))
    expect(read(history).scan?.verdicts).toEqual({ a: 'stream' })
  })

  describe('across kinds of device', () => {
    it("fills a gap with the other kind's green as amber, without its time, and says where it worked", () => {
      const history = [result({ ...PHONE, verdict: 'stream', ms: 1_000, quality: 1080, delivery: 'segmented' })]
      const { scan, sharedFrom } = read(history)
      expect(scan?.verdicts).toEqual({ a: 'unsure' })
      expect(scan?.timings).toEqual({})
      expect(scan?.delivery).toEqual({ a: 'segmented' })
      expect(sharedFrom).toEqual({ a: 'phone' })
      // Both ways: the desktop's green is amber on the phone too.
      expect(read([result({ verdict: 'stream' })], undefined, 'phone').sharedFrom).toEqual({ a: 'desktop' })
    })

    it("never lets the other kind's failure count here", () => {
      const history = [result({ verdict: 'stream', ms: 2_000, ago: 2 * HOUR }), result({ ...PHONE, verdict: 'dead', ago: HOUR })]
      expect(read(history).scan?.verdicts).toEqual({ a: 'stream' })
      expect(read([result({ ...PHONE, verdict: 'dead' })]).scan).toBeNull()
    })

    it("keeps this kind's own red over the other kind's newer green", () => {
      const history = [result({ verdict: 'dead', ago: 2 * HOUR }), result({ ...PHONE, verdict: 'stream', ago: HOUR })]
      expect(read(history)).toEqual(expect.objectContaining({ sharedFrom: {} }))
      expect(read(history).scan?.verdicts).toEqual({ a: 'dead' })
    })

    it('stops reporting a green the other kind has since found dead', () => {
      const history = [result({ ...PHONE, verdict: 'stream', ago: 2 * HOUR }), result({ ...PHONE, verdict: 'dead', ago: HOUR })]
      expect(read(history).scan).toBeNull()
    })

    it('decides the other kind by episode too', () => {
      const history = [
        result({ ...PHONE, episode: 1, verdict: 'stream' }),
        result({ ...PHONE, episode: 2, verdict: 'dead' }),
      ]
      expect(read(history, { season: 1, episode: 1 }).sharedFrom).toEqual({ a: 'phone' })
      expect(read(history, { season: 1, episode: 2 }).scan).toBeNull()
    })
  })

  describe('plays from the play log', () => {
    it('lets a play here overtake an older failure, as before', () => {
      const history = [result({ verdict: 'dead', ago: 2 * HOUR })]
      expect(read(history, undefined, 'desktop', { a: now - HOUR }).scan).toBeNull()
      expect(read(history, undefined, 'desktop', { a: now - 3 * HOUR }).scan?.verdicts).toEqual({ a: 'dead' })
    })

    it("lets it overtake the other kind's green as well", () => {
      const history = [result({ ...PHONE, verdict: 'stream', ago: 2 * HOUR })]
      expect(read(history, undefined, 'desktop', { a: now - HOUR }).scan).toBeNull()
    })
  })

  it('ignores results past their lifetime, and other titles', () => {
    const history = [result({ ago: RESULT_TTL_MS + MINUTE }), result({ titleKey: 'tv:tt2' })]
    expect(read(history).scan).toBeNull()
  })

  it("takes a television's answer from the newest success that saw how the video came, so a newer test replaces it", () => {
    const cast = result({ origin: 'play', delivery: 'progressive', cast: 'refused', ago: 2 * HOUR })
    expect(read([cast]).scan?.casts).toEqual({ a: 'refused' })
    const retested = [cast, result({ delivery: 'segmented', ago: HOUR })]
    expect(read(retested).scan?.casts).toEqual({})
    expect(read(retested).scan?.delivery).toEqual({ a: 'segmented' })
    // A play that did not see the delivery leaves both as they were.
    const played = [cast, result({ origin: 'play', ms: 1_000, ago: HOUR })]
    expect(read(played).scan?.casts).toEqual({ a: 'refused' })
  })

  it('dates each source by the result that decided it, and the row by the newest', () => {
    const history = [result({ providerId: 'a', ago: 2 * HOUR }), result({ providerId: 'b', ago: HOUR })]
    const scan = read(history).scan
    expect(scan?.testedAt).toEqual({ a: now - 2 * HOUR, b: now - HOUR })
    expect(scan?.at).toBe(now - HOUR)
  })
})

describe('deviceRows', () => {
  it("is one title-wide row per device and title, each read as that device reads its own", () => {
    const history = [
      result({ ...PC, verdict: 'stream', episode: 1 }),
      result({ ...PHONE, verdict: 'dead', episode: 1 }),
      result({ ...PHONE, titleKey: 'movie:tt2', season: null, episode: null, verdict: 'stream' }),
    ]
    const rows = deviceRows(history, now)
    expect(rows.map((r) => [r.deviceId, r.titleKey, r.verdicts])).toEqual([
      ['pc-1', 'tv:tt1', { a: 'stream' }],
      ['phone-1', 'tv:tt1', { a: 'dead' }],
      ['phone-1', 'movie:tt2', { a: 'stream' }],
    ])
  })
})
