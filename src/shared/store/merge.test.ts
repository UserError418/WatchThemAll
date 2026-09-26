/**
 * Tests for the merge.
 *
 * Two tiers, on purpose. The examples pin the *rules* — the ones a reader would
 * want to check by eye, and the ones that encode a judgement rather than a
 * mechanism. The properties attack the *algebra*, which is where a merge
 * actually fails: not on a case somebody thought of, but on the fourth sync
 * between three devices where the order happened to differ.
 *
 * Property-based testing earns its place here specifically. A merge bug does
 * not throw; it silently drops a record, and the user finds out weeks later
 * when a series they were half-way through has forgotten five episodes. There
 * is nothing for a type checker or a linter to bite on, and an example test
 * only ever finds the case its author already imagined.
 */

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'

import { mergeDocuments } from './merge'
import { COLLECTION_KEYS, SCHEMA_VERSION, identify, type StoreDocument } from './document'
import { DEFAULT_SETTINGS } from './core'
import type { Synced, WatchlistEntry } from '../types'

/* ── Fixtures ───────────────────────────────────────────────────────────── */

function emptyDoc(deviceId: string): StoreDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId,
    preferenceUpdatedAt: {},
    watchlist: [],
    trackers: [],
    history: [],
    watched: [],
    ratings: [],
    resumePoints: [],
    streamOutcomes: [],
    customProviders: [],
    activeProviderIds: [],
    knownProviderIds: [],
    favouriteProviderIds: [],
    providerOrder: [],
    providerScans: [],
    sharedScans: [],
    settings: { ...DEFAULT_SETTINGS },
  }
}

/**
 * A watchlist entry whose marks agree with its watched list.
 *
 * `mergeDocuments` states that both sides are already migrated, and a version 3
 * document always has a stamp for every watched episode — `migrate` puts one
 * there on load. A fixture without them is not a stricter test, it is an input
 * the merge is contractually allowed to normalise, which would make idempotence
 * unstatable. Pass `episodeMarks` explicitly to test the un-migrated shape; the
 * tests that do so say why.
 */
function entry(over: Partial<Synced<WatchlistEntry>> = {}): Synced<WatchlistEntry> {
  const base: Synced<WatchlistEntry> = {
    id: 'tv-1396',
    tmdbId: 1396,
    type: 'tv',
    title: 'Breaking Bad',
    posterPath: null,
    imdbId: null,
    lastSeason: null,
    lastEpisode: null,
    watchedEpisodes: [],
    episodeMarks: {},
    genreIds: [],
    episodeCount: null,
    rating: 0,
    addedAt: 1_000,
    providerId: null,
    updatedAt: 1_000,
    deletedAt: null,
    ...over,
  }

  if (over.episodeMarks !== undefined) return base
  return {
    ...base,
    episodeMarks: Object.fromEntries(
      base.watchedEpisodes.map((key) => [key, { watched: true, at: base.updatedAt }]),
    ),
  }
}

/**
 * The one record a merge was expected to produce.
 *
 * `noUncheckedIndexedAccess` is on, so `list[0]` is `T | undefined` everywhere.
 * Asserting the count here rather than reaching past it with `?.` keeps the
 * failure honest: a merge that returned two records would otherwise quietly
 * pass a test that only ever looked at the first one.
 */
function sole<T>(list: T[]): T {
  expect(list).toHaveLength(1)
  return list[0] as T
}

/** Every record in the document, as `collection:identity` strings. */
function identities(doc: StoreDocument): Set<string> {
  const out = new Set<string>()
  for (const key of COLLECTION_KEYS) {
    for (const record of doc[key]) out.add(`${key}:${identify(key, record)}`)
  }
  return out
}

/* ── The rules ──────────────────────────────────────────────────────────── */

describe('merging records', () => {
  it('unions watched episodes rather than choosing a side', () => {
    // The case the whole design exists for: watch S01E01 on the desktop and
    // S01E02 on the phone, offline, and lose neither.
    const local = emptyDoc('a')
    local.watchlist = [entry({ watchedEpisodes: ['1:1'], updatedAt: 2_000 })]
    const remote = emptyDoc('b')
    remote.watchlist = [entry({ watchedEpisodes: ['1:2'], updatedAt: 1_500 })]

    expect(sole(mergeDocuments(local, remote).watchlist).watchedEpisodes).toEqual(['1:1', '1:2'])
  })

  it('takes the position last set, even when it is earlier in the series', () => {
    // This used to keep whichever position was further along, which sounds
    // protective and means the user cannot start a series again: the old
    // position comes straight back on the next sync. The position is a cursor,
    // every write stamps `updatedAt`, and the device that moved it last is the
    // one the user was holding.
    const local = emptyDoc('a')
    local.watchlist = [entry({ lastSeason: 1, lastEpisode: 1, updatedAt: 5_000 })]
    const remote = emptyDoc('b')
    remote.watchlist = [entry({ lastSeason: 3, lastEpisode: 7, updatedAt: 1_000 })]

    const merged = sole(mergeDocuments(local, remote).watchlist)
    expect([merged.lastSeason, merged.lastEpisode]).toEqual([1, 1])
  })

  it('lets an episode be un-marked without another device putting it back', () => {
    // The bug this whole field exists for. The phone still has 1:3 marked; the
    // desktop un-marked it a moment ago. A set union can only grow, so the old
    // rule handed 1:3 straight back — and because the merge result is written
    // to disk, the user saw their own change revert seconds after making it.
    const local = emptyDoc('a')
    local.watchlist = [
      entry({
        watchedEpisodes: ['1:1', '1:2'],
        episodeMarks: {
          '1:1': { watched: true, at: 1_000 },
          '1:2': { watched: true, at: 1_000 },
          '1:3': { watched: false, at: 9_000 },
        },
        updatedAt: 9_000,
      }),
    ]
    const remote = emptyDoc('b')
    remote.watchlist = [entry({ watchedEpisodes: ['1:1', '1:2', '1:3'], updatedAt: 1_000 })]

    expect(sole(mergeDocuments(local, remote).watchlist).watchedEpisodes).toEqual(['1:1', '1:2'])
  })

  it('still keeps an episode the other device marked while this one was offline', () => {
    // The case the union existed to protect, and the reason "newer record wins"
    // is not the fix: it cannot tell "removed this" from "never saw this".
    const local = emptyDoc('a')
    local.watchlist = [
      entry({
        watchedEpisodes: ['1:1'],
        episodeMarks: { '1:1': { watched: true, at: 9_000 } },
        updatedAt: 9_000,
      }),
    ]
    const remote = emptyDoc('b')
    remote.watchlist = [
      entry({
        watchedEpisodes: ['1:2'],
        episodeMarks: { '1:2': { watched: true, at: 1_000 } },
        updatedAt: 1_000,
      }),
    ]

    expect(sole(mergeDocuments(local, remote).watchlist).watchedEpisodes).toEqual(['1:1', '1:2'])
  })

  it('reads a version 2 peer\'s watched list as marks rather than dropping it', () => {
    // A device still running the old code sends episodes with no stamps. They
    // must not be discarded as "unmarked"; they are read as having been marked
    // when that record was last written, which is the latest they could be.
    const local = emptyDoc('a')
    local.watchlist = [entry({ watchedEpisodes: [], episodeMarks: {}, updatedAt: 500 })]
    const remote = emptyDoc('b')
    remote.watchlist = [
      entry({ watchedEpisodes: ['1:1', '1:2'], episodeMarks: {}, updatedAt: 1_000 }),
    ]

    const merged = sole(mergeDocuments(local, remote).watchlist)
    expect(merged.watchedEpisodes).toEqual(['1:1', '1:2'])
    expect(merged.episodeMarks['1:1']).toEqual({ watched: true, at: 1_000 })
  })

  it('lets a version 2 peer\'s stale list lose to a newer un-marking', () => {
    const local = emptyDoc('a')
    local.watchlist = [
      entry({
        watchedEpisodes: [],
        episodeMarks: { '1:1': { watched: false, at: 2_000 } },
        updatedAt: 2_000,
      }),
    ]
    const remote = emptyDoc('b')
    remote.watchlist = [entry({ watchedEpisodes: ['1:1'], episodeMarks: {}, updatedAt: 1_000 })]

    expect(sole(mergeDocuments(local, remote).watchlist).watchedEpisodes).toEqual([])
  })

  it('does not resurrect a deletion that is newer than the edit', () => {
    const local = emptyDoc('a')
    local.watchlist = [entry({ updatedAt: 1_000 })]
    const remote = emptyDoc('b')
    remote.watchlist = [entry({ updatedAt: 2_000, deletedAt: 2_000 })]

    expect(sole(mergeDocuments(local, remote).watchlist).deletedAt).toBe(2_000)
  })

  it('lets an edit made after a deletion undo it', () => {
    // Deleting on the phone and re-adding on the desktop an hour later is the
    // user changing their mind, and the later action is the one they meant.
    const local = emptyDoc('a')
    local.watchlist = [entry({ updatedAt: 9_000, deletedAt: null })]
    const remote = emptyDoc('b')
    remote.watchlist = [entry({ updatedAt: 2_000, deletedAt: 2_000 })]

    expect(sole(mergeDocuments(local, remote).watchlist).deletedAt).toBeNull()
  })

  it('takes nextEpisode and lastChecked from the same side', () => {
    // Splitting them would leave a fresh lastChecked next to a stale
    // nextEpisode, which suppresses the sweep that would have corrected it.
    const stub = { season: 3, episode: 4, name: 'Later', airDate: '2026-01-01' }
    const local = emptyDoc('a')
    local.trackers = [
      {
        id: 'tv-1',
        tmdbId: 1,
        title: 'Show',
        posterPath: null,
        status: 'Returning Series',
        nextEpisode: null,
        lastNotified: null,
        addedAt: 0,
        lastChecked: 500,
        updatedAt: 9_000,
        deletedAt: null,
      },
    ]
    const remote = emptyDoc('b')
    remote.trackers = [{ ...sole(local.trackers), nextEpisode: stub, lastChecked: 8_000, updatedAt: 1 }]

    const merged = sole(mergeDocuments(local, remote).trackers)
    expect(merged.nextEpisode).toEqual(stub)
    expect(merged.lastChecked).toBe(8_000)
  })

  it('does not move lastNotified backwards', () => {
    const earlier = { season: 1, episode: 1, name: 'a', airDate: null }
    const later = { season: 2, episode: 5, name: 'b', airDate: null }
    const base = {
      id: 'tv-1',
      tmdbId: 1,
      title: 'Show',
      posterPath: null,
      status: '',
      nextEpisode: null,
      addedAt: 0,
      lastChecked: 0,
      deletedAt: null,
    }
    const local = emptyDoc('a')
    local.trackers = [{ ...base, lastNotified: later, updatedAt: 1 }]
    const remote = emptyDoc('b')
    remote.trackers = [{ ...base, lastNotified: earlier, updatedAt: 9_000 }]

    expect(sole(mergeDocuments(local, remote).trackers).lastNotified).toEqual(later)
  })
})

describe('merging preferences', () => {
  it('decides each key on its own stamp', () => {
    const local = emptyDoc('a')
    local.activeProviderIds = ['videasy']
    local.providerOrder = ['videasy', 'vidrock']
    local.preferenceUpdatedAt = { activeProviderIds: 9_000, providerOrder: 1_000 }

    const remote = emptyDoc('b')
    remote.activeProviderIds = ['vidrock']
    remote.providerOrder = ['vidrock', 'videasy']
    remote.preferenceUpdatedAt = { activeProviderIds: 2_000, providerOrder: 5_000 }

    const merged = mergeDocuments(local, remote)
    expect(merged.activeProviderIds).toEqual(['videasy'])
    expect(merged.providerOrder).toEqual(['vidrock', 'videasy'])
  })

  it('never lets an unstamped side overwrite a stamped one', () => {
    // A fresh install syncing for the first time has no stamps at all. Treating
    // "absent" as zero would let its defaults flatten a configured device.
    const fresh = emptyDoc('new')
    const configured = emptyDoc('old')
    configured.activeProviderIds = ['videasy']
    configured.preferenceUpdatedAt = { activeProviderIds: 1_000 }

    expect(mergeDocuments(fresh, configured).activeProviderIds).toEqual(['videasy'])
    expect(mergeDocuments(configured, fresh).activeProviderIds).toEqual(['videasy'])
  })

  it('keeps the local deviceId', () => {
    expect(mergeDocuments(emptyDoc('local'), emptyDoc('remote')).deviceId).toBe('local')
  })
})

/* ── The algebra ────────────────────────────────────────────────────────── */

/**
 * Documents built from a small pool of identities, so collisions — the only
 * interesting case — actually happen. Random ids would generate two disjoint
 * documents almost every time and test nothing but concatenation.
 */
const arbEntry = fc.record({
  updatedAt: fc.integer({ min: 0, max: 20 }),
  deletedAt: fc.option(fc.integer({ min: 0, max: 20 }), { nil: null }),
  watchedEpisodes: fc.uniqueArray(fc.constantFrom('1:1', '1:2', '1:3', '2:1'), { maxLength: 4 }),
  lastSeason: fc.option(fc.integer({ min: 1, max: 3 }), { nil: null }),
  lastEpisode: fc.option(fc.integer({ min: 1, max: 9 }), { nil: null }),
})

/**
 * A document, with each identity appearing at most once.
 *
 * That uniqueness is a precondition of the algebra, not a convenience: a
 * document holding the same id twice is malformed, the merge collapses it on
 * sight — correctly — and idempotence cannot be stated over inputs the merge is
 * expected to change. The collapsing itself is pinned by an example below.
 */
const arbDoc = fc
  .record({
    deviceId: fc.constantFrom('a', 'b', 'c'),
    watchlist: fc.uniqueArray(
      fc.tuple(fc.constantFrom('tv-1', 'tv-2', 'tv-3'), arbEntry),
      { selector: ([id]) => id, maxLength: 3 },
    ),
    activeStamp: fc.option(fc.integer({ min: 0, max: 20 }), { nil: undefined }),
    activeProviderIds: fc.uniqueArray(fc.constantFrom('videasy', 'vidrock', 'vidlux')),
  })
  .map(({ deviceId, watchlist, activeStamp, activeProviderIds }) => {
    const doc = emptyDoc(deviceId)
    doc.watchlist = watchlist.map(([id, w]) => entry({ id, ...w }))
    doc.activeProviderIds = activeProviderIds
    if (activeStamp !== undefined) doc.preferenceUpdatedAt = { activeProviderIds: activeStamp }
    return doc
  })

describe('merge algebra', () => {
  it('is idempotent — merging a document with itself changes nothing', () => {
    fc.assert(
      fc.property(arbDoc, (doc) => {
        expect(mergeDocuments(doc, doc)).toEqual(doc)
      }),
    )
  })

  it('reaches a fixed point — merging the result again changes nothing', () => {
    // The property that actually matters in service: sync runs on every launch,
    // and a merge that drifts by one field per run corrupts a library slowly
    // enough that no single sync looks wrong.
    fc.assert(
      fc.property(arbDoc, arbDoc, (a, b) => {
        const once = mergeDocuments(a, b)
        expect(mergeDocuments(once, b)).toEqual(once)
      }),
    )
  })

  it('holds the same records whichever side is called local', () => {
    fc.assert(
      fc.property(arbDoc, arbDoc, (a, b) => {
        expect(identities(mergeDocuments(a, b))).toEqual(identities(mergeDocuments(b, a)))
      }),
    )
  })

  it('never loses a record that either side had', () => {
    // Tombstones are records too: "gone" has to survive a merge as surely as
    // "present" does, or the next sync from a third device revives it.
    fc.assert(
      fc.property(arbDoc, arbDoc, (a, b) => {
        const merged = identities(mergeDocuments(a, b))
        for (const id of [...identities(a), ...identities(b)]) expect(merged).toContain(id)
      }),
    )
  })

  it('never loses a watched episode', () => {
    fc.assert(
      fc.property(arbDoc, arbDoc, (a, b) => {
        const merged = mergeDocuments(a, b)
        for (const side of [a, b]) {
          for (const before of side.watchlist) {
            if (before.deletedAt !== null) continue
            const after = merged.watchlist.find((w) => w.id === before.id)
            // A live entry that lost to a newer tombstone is gone on purpose.
            if (after === undefined || after.deletedAt !== null) continue
            for (const ep of before.watchedEpisodes) expect(after.watchedEpisodes).toContain(ep)
          }
        }
      }),
    )
  })

  it('collapses a document that already held the same id twice', () => {
    // The merge is the only place that sees both copies, so it is the only
    // place that can settle them — and it settles them by the same rule it uses
    // across devices rather than by position.
    const local = emptyDoc('a')
    local.watchlist = [
      entry({ watchedEpisodes: ['1:1'], updatedAt: 1_000 }),
      entry({ watchedEpisodes: ['1:2'], updatedAt: 2_000 }),
    ]

    const merged = sole(mergeDocuments(local, emptyDoc('b')).watchlist)
    expect(merged.watchedEpisodes.toSorted()).toEqual(['1:1', '1:2'])
  })

  it('produces a document of exactly the declared shape', () => {
    // Guards against a merge that quietly forgets a collection: the loop is
    // driven by COLLECTION_KEYS, so a new one is included automatically, and
    // this fails loudly if that ever stops being true.
    fc.assert(
      fc.property(arbDoc, arbDoc, (a, b) => {
        const merged = mergeDocuments(a, b)
        expect(Object.keys(merged).sort()).toEqual(Object.keys(emptyDoc('x')).sort())
        for (const key of COLLECTION_KEYS) expect(Array.isArray(merged[key])).toBe(true)
      }),
    )
  })
})

/**
 * Seasons, added in version 5.
 *
 * A merge is where a new identity scheme fails, and it fails silently: two
 * records that should be distinct collapse into one, and the user finds out
 * when half their watched list has disappeared. Both of these would pass a type
 * check and a linter regardless of which way the identity went.
 */
describe('season-scoped watched and ratings', () => {
  it('keeps one watched entry per season rather than collapsing them', () => {
    const local = emptyDoc('a')
    const remote = emptyDoc('b')

    local.watched = [
      {
        id: 's1',
        tmdbId: 1396,
        type: 'tv',
        season: 1,
        title: 'Breaking Bad',
        posterPath: null,
        imdbId: 'tt0903747',
        genreIds: [],
        rating: 0,
        addedAt: 1,
        source: 'user',
        malId: null,
        updatedAt: 1,
        deletedAt: null,
      },
    ]
    remote.watched = [{ ...local.watched[0]!, id: 's2', season: 2, updatedAt: 2 }]

    const merged = mergeDocuments(local, remote)
    expect(merged.watched.map((w) => w.season).sort()).toEqual([1, 2])
  })

  /**
   * The season suffix is what makes this work. A `season` field alone would
   * leave every season of a series sharing one key, so the newest write would
   * win and the rest would vanish.
   */
  it('keeps a season opinion separate from the opinion of the series', () => {
    const local = emptyDoc('a')
    const remote = emptyDoc('b')

    local.ratings = [
      {
        key: 'tv:tt0903747',
        tmdbId: 1396,
        type: 'tv',
        season: null,
        value: 8,
        coarse: false,
        rating: 'like',
        genreIds: [],
        at: 1,
        updatedAt: 1,
        deletedAt: null,
      },
    ]
    remote.ratings = [
      {
        ...local.ratings[0]!,
        key: 'tv:tt0903747:s3',
        season: 3,
        value: 3,
        rating: 'dislike',
        updatedAt: 2,
      },
    ]

    const merged = mergeDocuments(local, remote)
    expect(merged.ratings).toHaveLength(2)
    expect(merged.ratings.find((r) => r.season === null)?.value).toBe(8)
    expect(merged.ratings.find((r) => r.season === 3)?.value).toBe(3)
  })
})

/**
 * The 1–10 scale, where a rating carries its verdict twice: as `value`, and as
 * the like/dislike string builds up to 1.7.3 read.
 *
 * The two only stay consistent if a merge takes a rating whole. A field-level
 * merge could pair one device's 9 with the other's "dislike", and every build
 * would then read a different opinion out of the same record.
 */
describe('ratings on the 1–10 scale', () => {
  const rating = (over: Partial<StoreDocument['ratings'][number]>) => ({
    key: 'tv:tt0903747',
    tmdbId: 1396,
    type: 'tv' as const,
    season: null,
    value: 9 as const,
    coarse: false,
    rating: 'like' as const,
    genreIds: [],
    at: 1,
    updatedAt: 1,
    deletedAt: null,
    ...over,
  })

  it('takes the newer rating whole, never a value from one side and a string from the other', () => {
    const local = emptyDoc('a')
    const remote = emptyDoc('b')
    local.ratings = [rating({ value: 9, coarse: false, rating: 'like', updatedAt: 5 })]
    remote.ratings = [rating({ value: 4, coarse: true, rating: 'dislike', updatedAt: 6 })]

    for (const merged of [mergeDocuments(local, remote), mergeDocuments(remote, local)]) {
      expect(merged.ratings).toEqual([remote.ratings[0]])
    }
  })
})

describe('test results across devices', () => {
  it("files the peer's own results as shared and leaves this device's untouched", () => {
    const at = Date.now()
    const local: StoreDocument = {
      ...emptyDoc('phone-1'),
      deviceKind: 'phone',
      providerScans: [{ titleKey: 'tv:tt1', at, verdicts: { a: 'dead' } }],
    }
    const remote: StoreDocument = {
      ...emptyDoc('pc-1'),
      deviceKind: 'desktop',
      providerScans: [{ titleKey: 'tv:tt1', at, verdicts: { a: 'stream' } }],
    }
    const merged = mergeDocuments(local, remote)
    // Never overwritten by a peer: a red here stays this device's own answer.
    expect(merged.providerScans).toEqual(local.providerScans)
    expect(merged.deviceKind).toBe('phone')
    expect(merged.sharedScans).toEqual([{ ...remote.providerScans[0], deviceId: 'pc-1', deviceKind: 'desktop' }])
  })
})
