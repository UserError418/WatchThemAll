import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, emptyStore, migrate } from './migrate'
import { mergeDocuments } from '@shared/store/merge'

/**
 * Migration runs once, against data the user cannot get back if it goes wrong.
 * These cases are the ones where being wrong is silent — the app would start,
 * look fine, and simply have less in it than before.
 */
describe('migrate', () => {
  it('leaves a current-version document alone apart from the version stamp', () => {
    const current = { ...emptyStore(), activeProviderIds: ['moviesapi'] }
    const result = migrate(current)
    expect(result.activeProviderIds).toEqual(['moviesapi'])
    expect(result.schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('fills in keys a document written by an older minor version is missing', () => {
    // A v1 document that predates `trackers` must not come back undefined —
    // the renderer maps over these arrays without guarding.
    const partial = { schemaVersion: 1, watchlist: [] } as Record<string, unknown>
    const result = migrate(partial)
    expect(result.trackers).toEqual([])
    expect(result.history).toEqual([])
    expect(result.settings.releaseCheckMinutes).toBeGreaterThan(0)
  })

  it('carries legacy bookmarks across instead of dropping them', () => {
    const legacy = {
      vidsrc_bookmarks: [
        {
          bookmarkId: 'abc123',
          name: 'Breaking Bad',
          imdb: 'tt0903747',
          schemaId: 'moviesapi',
          type: 'tv',
          lastSeason: 3,
          lastEpisode: 7,
        },
      ],
    }
    const [entry] = migrate(legacy).watchlist
    expect(entry).toBeDefined()
    expect(entry!.title).toBe('Breaking Bad')
    expect(entry!.imdbId).toBe('tt0903747')
    expect(entry!.lastSeason).toBe(3)
    expect(entry!.lastEpisode).toBe(7)
  })

  it('keeps a legacy bookmark that has no schemaId', () => {
    // The original filtered these out on load, which is how bookmarks added
    // from a recommendation tile silently vanished on restart. Migrating must
    // not repeat that: an unknown provider is recoverable, a deleted entry is
    // not.
    const legacy = {
      vidsrc_bookmarks: [{ bookmarkId: 'x', name: 'Silo', imdb: 'tt14688458', schemaId: '' }],
    }
    const [entry] = migrate(legacy).watchlist
    expect(entry).toBeDefined()
    expect(entry!.title).toBe('Silo')
    expect(entry!.providerId).toBeNull()
  })

  it('gives movies a null position rather than season 1 episode 1', () => {
    const legacy = {
      vidsrc_bookmarks: [{ bookmarkId: 'm', name: 'Dune', imdb: 'tt1160419', type: 'movie' }],
    }
    const [entry] = migrate(legacy).watchlist
    expect(entry!.type).toBe('movie')
    expect(entry!.lastSeason).toBeNull()
    expect(entry!.lastEpisode).toBeNull()
  })

  it('skips malformed entries without failing the whole migration', () => {
    const legacy = {
      vidsrc_bookmarks: [null, 'not an object', { bookmarkId: 'ok', name: 'Real Show' }],
    }
    const result = migrate(legacy)
    expect(result.watchlist).toHaveLength(1)
    expect(result.watchlist[0]!.title).toBe('Real Show')
  })

  it('migrates history and active providers', () => {
    const legacy = {
      vidsrc_history: [
        { historyId: 'h1', name: 'Reacher', season: 2, episode: 4, watchedAt: 1_700_000_000_000 },
      ],
      vidsrc_active_providers: ['moviesapi', 'vidflix', 42],
    }
    const result = migrate(legacy)
    expect(result.history[0]!.title).toBe('Reacher')
    expect(result.history[0]!.season).toBe(2)
    // The numeric entry is not a provider id and must not survive as one.
    expect(result.activeProviderIds).toEqual(['moviesapi', 'vidflix'])
  })

  it('returns an empty store for an unrecognised document', () => {
    expect(migrate({}).watchlist).toEqual([])
    expect(migrate({ nonsense: true }).schemaVersion).toBe(SCHEMA_VERSION)
  })
})

describe('position repair', () => {
  it('rewrites a zeroed position to episode one', () => {
    // The original's player preload guessed season/episode from the URL and
    // wrote 0 when it could not parse them, which renders as "S00E00" and
    // makes the resume button useless.
    const doc = {
      schemaVersion: 1,
      watchlist: [
        {
          id: 'x',
          tmdbId: 1,
          type: 'tv',
          title: 'Silo',
          posterPath: null,
          imdbId: null,
          lastSeason: 0,
          lastEpisode: 0,
          watchedEpisodes: ['1:1', '0:0', '1:2'],
          genreIds: [],
          addedAt: 0,
          providerId: null,
        },
      ],
    } as unknown as Parameters<typeof migrate>[0]

    const [entry] = migrate(doc).watchlist
    expect(entry!.lastSeason).toBe(1)
    expect(entry!.lastEpisode).toBe(1)
    // The junk key must not survive to be counted in the progress figure.
    expect(entry!.watchedEpisodes).toEqual(['1:1', '1:2'])
  })

  it('leaves a valid position alone', () => {
    const doc = {
      schemaVersion: 1,
      watchlist: [
        {
          id: 'x',
          tmdbId: 1,
          type: 'tv',
          title: 'Silo',
          posterPath: null,
          imdbId: null,
          lastSeason: 3,
          lastEpisode: 7,
          watchedEpisodes: ['2:10'],
          genreIds: [],
          addedAt: 0,
          providerId: null,
        },
      ],
    } as unknown as Parameters<typeof migrate>[0]

    const [entry] = migrate(doc).watchlist
    expect(entry!.lastSeason).toBe(3)
    expect(entry!.lastEpisode).toBe(7)
    expect(entry!.watchedEpisodes).toEqual(['2:10'])
  })

  it('keeps films positionless', () => {
    const doc = {
      schemaVersion: 1,
      watchlist: [
        {
          id: 'm',
          tmdbId: 2,
          type: 'movie',
          title: 'Dune',
          posterPath: null,
          imdbId: null,
          lastSeason: 0,
          lastEpisode: 0,
          watchedEpisodes: [],
          genreIds: [],
          addedAt: 0,
          providerId: null,
        },
      ],
    } as unknown as Parameters<typeof migrate>[0]

    const [entry] = migrate(doc).watchlist
    expect(entry!.lastSeason).toBeNull()
    expect(entry!.lastEpisode).toBeNull()
  })
})

/**
 * Settings needs a nested merge, not a top-level spread.
 *
 * Every field added to `Settings` after a document was last written arrives as
 * `undefined` unless the defaults are merged underneath it — and `undefined` is
 * a third state that reads as false everywhere and renders as blank. Adding
 * `previewAudio` (which defaults to ON) is the case that made this concrete:
 * without the merge, every existing install would silently have got muted
 * previews with no way to tell why.
 */
describe('settings added after a document was written', () => {
  it('fills in a setting the stored document has never heard of', () => {
    const result = migrate({
      schemaVersion: 1,
      watchlist: [],
      trackers: [],
      history: [],
      activeProviderIds: [],
      customProviders: [],
      // A settings object from before `previewAudio` and `historyCollapsed`.
      settings: { releaseCheckMinutes: 90, notificationsEnabled: false, defaultProviderId: 'x' },
    } as never)

    expect(result.settings.previewAudio).toBe(true)
    expect(result.settings.historyCollapsed).toBe(false)
  })

  it('does not clobber settings the user has already chosen', () => {
    const result = migrate({
      schemaVersion: 1,
      watchlist: [],
      trackers: [],
      history: [],
      activeProviderIds: [],
      customProviders: [],
      settings: { releaseCheckMinutes: 90, notificationsEnabled: false, defaultProviderId: 'x' },
    } as never)

    expect(result.settings.releaseCheckMinutes).toBe(90)
    expect(result.settings.notificationsEnabled).toBe(false)
    expect(result.settings.defaultProviderId).toBe('x')
  })

  it('survives a document with no settings key at all', () => {
    const result = migrate({ schemaVersion: 1, watchlist: [] } as never)
    expect(result.settings.previewAudio).toBe(true)
    expect(result.settings.releaseCheckMinutes).toBeGreaterThan(0)
  })
})

describe('the episode total used for watchlist progress', () => {
  it('is null rather than zero on entries written before it existed', () => {
    const result = migrate({
      schemaVersion: 1,
      watchlist: [
        {
          id: 'a',
          tmdbId: 1396,
          type: 'tv',
          title: 'Breaking Bad',
          posterPath: null,
          imdbId: null,
          lastSeason: 2,
          lastEpisode: 4,
          watchedEpisodes: ['1:1'],
          genreIds: [],
          addedAt: 0,
          providerId: null,
        },
      ],
    } as never)

    // Zero would render as "0 of 0" and a full-looking bar; null renders as
    // the resume position alone, which is the honest answer.
    expect(result.watchlist[0]!.episodeCount).toBeNull()
  })
})

describe('watched and ratings', () => {
  it('gives a document written before they existed empty lists, not undefined', () => {
    // The same class of bug as the settings merge above: spreading fills in
    // absent top-level keys only because `emptyStore()` supplies them. Losing
    // that line would hand the renderer `undefined` where it iterates.
    const migrated = migrate({ schemaVersion: 1, watchlist: [], trackers: [], history: [] })

    expect(migrated.watched).toEqual([])
    expect(migrated.ratings).toEqual([])
  })

  it('repairs a non-array written by a corrupted or hand-edited file', () => {
    const migrated = migrate({
      schemaVersion: 1,
      watched: null as never,
      ratings: 'nonsense' as never,
    })

    expect(migrated.watched).toEqual([])
    expect(migrated.ratings).toEqual([])
  })

  it('preserves entries that are already there', () => {
    const entry = {
      id: 'a',
      tmdbId: 1396,
      type: 'tv' as const,
      title: 'Breaking Bad',
      posterPath: null,
      imdbId: 'tt0903747',
      genreIds: [18],
      addedAt: 1,
      source: 'user' as const,
      malId: null,
    }

    expect(migrate({ schemaVersion: 1, watched: [entry] }).watched).toEqual([
      // Plus the sync metadata, which is what version 2 adds. `updatedAt`
      // reuses the record's own `addedAt` rather than "now" — see the note on
      // EXISTING_TIMESTAMP for why that matters on the first merge.
      //
      // And `season: null`, which version 5 adds. An entry written before
      // seasons were scoped meant "the whole series", and null is exactly that
      // — a normalisation rather than a reinterpretation, so nothing the user
      // did changes meaning.
      { ...entry, season: null, updatedAt: 1, deletedAt: null },
    ])
  })
})

describe('migrate to version 2', () => {
  it('dates a record from the timestamp it already carries', () => {
    const doc = migrate(
      {
        schemaVersion: 1,
        history: [
          { id: 'h', tmdbId: 1, type: 'tv', title: 'x', posterPath: null,
            season: 1, episode: 1, watchedAt: 1_700_000_000_000 },
        ],
      },
      9_999_999_999_999,
    )
    expect(doc.history[0]?.updatedAt).toBe(1_700_000_000_000)
  })

  it('falls back to the migration time when a record carries no usable one', () => {
    const doc = migrate(
      { schemaVersion: 1, watched: [{ id: 'w', tmdbId: 1, type: 'tv', title: 'x',
        posterPath: null, imdbId: null, genreIds: [], addedAt: 0, source: 'user', malId: null }] },
      1234,
    )
    expect(doc.watched[0]?.updatedAt).toBe(1234)
  })

  it('treats every version-1 record as live, because that shape could not express a deletion', () => {
    const doc = migrate({
      schemaVersion: 1,
      watchlist: [{ id: 'a', tmdbId: 1, type: 'tv', title: 'x', posterPath: null, imdbId: null,
        lastSeason: 1, lastEpisode: 1, watchedEpisodes: [], genreIds: [], episodeCount: null,
        addedAt: 5, providerId: null }],
    })
    expect(doc.watchlist[0]?.deletedAt).toBeNull()
  })

  it("keeps a resume point's own updatedAt, which is already the field it needs", () => {
    const doc = migrate(
      { schemaVersion: 1, resumePoints: [{ key: '1:m:m', tmdbId: 1, seconds: 30,
        duration: 100, updatedAt: 777 }] },
      1234,
    )
    expect(doc.resumePoints[0]?.updatedAt).toBe(777)
  })

  it('gives every install a device id', () => {
    expect(migrate({ schemaVersion: 1 }).deviceId).toMatch(/.+/)
  })

  it('keeps the device id a document already has', () => {
    expect(migrate({ schemaVersion: 2, deviceId: 'abc' }).deviceId).toBe('abc')
  })
})

describe('version 2 to 3 — per-episode stamps', () => {
  const v2Entry = {
    id: 'tv-1396',
    tmdbId: 1396,
    type: 'tv',
    title: 'Breaking Bad',
    posterPath: null,
    imdbId: null,
    lastSeason: 1,
    lastEpisode: 3,
    watchedEpisodes: ['1:1', '1:2'],
    genreIds: [],
    episodeCount: null,
    addedAt: 1_000,
    providerId: null,
    updatedAt: 4_242,
    deletedAt: null,
  }

  it('gives every already-watched episode a stamp', () => {
    const doc = migrate({ schemaVersion: 2, watchlist: [v2Entry] }, 9_999)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.watchlist[0]?.episodeMarks).toEqual({
      '1:1': { watched: true, at: 4_242 },
      '1:2': { watched: true, at: 4_242 },
    })
  })

  it('dates the marks from the record, not from the clock', () => {
    // Using `now` would make whichever device happened to launch second outrank
    // one that migrated the same document an hour earlier, purely for being
    // later to start. `updatedAt` is the latest moment the marks could be true.
    const doc = migrate({ schemaVersion: 2, watchlist: [v2Entry] }, 9_999)
    for (const mark of Object.values(doc.watchlist[0]?.episodeMarks ?? {})) {
      expect(mark.at).toBe(4_242)
    }
  })

  it('leaves marks alone once they exist', () => {
    // Migration runs on every load, so it has to be a no-op the second time.
    const once = migrate({ schemaVersion: 2, watchlist: [v2Entry] }, 9_999)
    const twice = migrate(once, 11_111)
    expect(twice.watchlist[0]?.episodeMarks).toEqual(once.watchlist[0]?.episodeMarks)
  })

  it('does not invent a mark for an episode that was never watched', () => {
    const doc = migrate(
      { schemaVersion: 2, watchlist: [{ ...v2Entry, watchedEpisodes: [] }] },
      9_999,
    )
    expect(doc.watchlist[0]?.episodeMarks).toEqual({})
  })
})

/**
 * Migration composed with merging.
 *
 * Both were well covered on their own and the bug lived precisely between them:
 * `migrate` runs on every load and rewrote `updatedAt`, which only `merge` ever
 * reads. Each test suite was right about its own module and the pair was
 * broken, so these tests exercise the seam rather than either side of it.
 */
describe('a document that has been through migrate still merges correctly', () => {
  const saved = (over: Record<string, unknown> = {}) => ({
    schemaVersion: SCHEMA_VERSION,
    watchlist: [
      {
        id: 'tv-1396', tmdbId: 1396, type: 'tv', title: 'Breaking Bad',
        posterPath: null, imdbId: null, lastSeason: 1, lastEpisode: 1,
        watchedEpisodes: [], episodeMarks: {}, genreIds: [], episodeCount: null,
        addedAt: 1_000, providerId: null, updatedAt: 1_000, deletedAt: null,
        ...over,
      },
    ],
  })

  it('keeps an edit newer than the moment the title was added', () => {
    // `addedAt` travels with the record, so it is the *same number* on every
    // device. Dating `updatedAt` from it made every cross-device comparison a
    // tie, and a tie has no winner to be last.
    const edited = migrate(saved({ lastSeason: 2, lastEpisode: 4, updatedAt: 8_000 }), 9_999)
    expect(edited.watchlist[0]?.updatedAt).toBe(8_000)

    const stale = migrate(saved(), 9_999)
    const merged = mergeDocuments(edited, stale)
    expect([merged.watchlist[0]?.lastSeason, merged.watchlist[0]?.lastEpisode]).toEqual([2, 4])
  })

  it('lets a title be re-added after it was deleted on the other device', () => {
    // The same tie, with teeth: ties deliberately prefer the tombstone, so an
    // un-delete could never win and a re-added title vanished on every sync.
    const readded = migrate(saved({ updatedAt: 8_000, deletedAt: null }), 9_999)
    const deleted = migrate(saved({ updatedAt: 3_000, deletedAt: 3_000 }), 9_999)

    expect(mergeDocuments(readded, deleted).watchlist[0]?.deletedAt).toBeNull()
  })

  it('still dates a version 1 record from the time it does record', () => {
    // The fallback the original code was written for, and it must survive: a
    // version 1 record has no `updatedAt` at all, and dating every one of them
    // `now` would let a fresh install outrank a real one on the first sync.
    const doc = migrate(
      { schemaVersion: 1, watchlist: [{ id: 'tv-1', tmdbId: 1, type: 'tv', title: 'X', addedAt: 4_242 }] },
      9_999,
    )
    expect(doc.watchlist[0]?.updatedAt).toBe(4_242)
  })
})

/**
 * The 1–10 rating scale.
 *
 * Every rating the user made before it is a like or a dislike, and the only
 * copy of those opinions is this document — so the conversion is tested for
 * what it keeps as much as for what it adds. It also runs on every load and on
 * every sync pull, which makes idempotence and an untouched `updatedAt` part
 * of correctness rather than tidiness: the last time `migrate` rewrote a
 * stamp on load, the sync merge lost the ability to tell old from new.
 */
describe('the 1–10 rating scale', () => {
  /** A rating exactly as 1.7.3 wrote it: no `value`, no `coarse`. */
  const legacy = (over: Record<string, unknown> = {}) => ({
    key: 'tv:tt0903747',
    tmdbId: 1396,
    type: 'tv',
    season: null,
    rating: 'like',
    genreIds: [18, 80],
    at: 1_700_000_000_000,
    updatedAt: 1_700_000_500_000,
    deletedAt: null,
    ...over,
  })

  const ratingsOf = (...records: Record<string, unknown>[]) =>
    migrate({ schemaVersion: SCHEMA_VERSION, ratings: records }, 9_999).ratings

  it('turns a legacy like into an 8 and a dislike into a 4, both marked coarse', () => {
    const [like, dislike] = ratingsOf(
      legacy(),
      legacy({ key: 'tv:tt0903747:s2', season: 2, rating: 'dislike' }),
    )
    expect(like).toMatchObject({ value: 8, coarse: true, rating: 'like' })
    expect(dislike).toMatchObject({ value: 4, coarse: true, rating: 'dislike' })
  })

  /**
   * The fields a merge and the scope lookups identify a record by. Changing
   * any of them turns one opinion into another, or makes it lose every
   * conflict it should win.
   */
  it('leaves updatedAt, key, season, at and genreIds exactly as they were', () => {
    const before = legacy({ key: 'tv:tt0903747:s3', season: 3 })
    const [after] = ratingsOf(before)
    expect(after).toMatchObject({
      key: before.key,
      season: before.season,
      at: before.at,
      genreIds: before.genreIds,
      updatedAt: before.updatedAt,
      deletedAt: null,
    })
  })

  it('is a no-op the second time, field for field', () => {
    const once = migrate({ schemaVersion: SCHEMA_VERSION, ratings: [legacy()] }, 9_999)
    const twice = migrate(once, 11_111)
    expect(twice.ratings).toEqual(once.ratings)
    // Key order too — the sync decides whether to push by comparing JSON.
    expect(JSON.stringify(twice.ratings)).toBe(JSON.stringify(once.ratings))
  })

  it('keeps a value set on the new scale, and whether it was coarse', () => {
    const [chosen, converted] = ratingsOf(
      legacy({ value: 6, coarse: false, rating: 'like' }),
      legacy({ key: 'tv:tt2', tmdbId: 2, value: 8, coarse: true, rating: 'like' }),
    )
    expect(chosen).toMatchObject({ value: 6, coarse: false })
    expect(converted).toMatchObject({ value: 8, coarse: true })
  })

  /**
   * `value` wins whenever it is present, and the string is re-derived from it.
   * An old build builds every rating from scratch, so it can never leave a
   * stale value beside a string it changed; a mismatch can only be damage,
   * and the number is the one this build wrote.
   */
  it('re-derives the legacy string from the value rather than trusting it', () => {
    const [low, high] = ratingsOf(
      legacy({ value: 3, coarse: false, rating: 'like' }),
      legacy({ key: 'tv:tt2', tmdbId: 2, value: 7, coarse: false, rating: 'dislike' }),
    )
    expect(low).toMatchObject({ value: 3, rating: 'dislike' })
    expect(high).toMatchObject({ value: 7, rating: 'like' })
  })

  it('treats a value with no coarse flag as chosen', () => {
    const [record] = ratingsOf(legacy({ value: 9 }))
    expect(record).toMatchObject({ value: 9, coarse: false, rating: 'like' })
  })

  /** An out-of-range or fractional value is not a rating; the string still is. */
  it('falls back to the legacy string when the value is not on the scale', () => {
    const [fraction, zero] = ratingsOf(
      legacy({ value: 7.4 }),
      legacy({ key: 'tv:tt2', tmdbId: 2, value: 0, rating: 'dislike' }),
    )
    expect(fraction).toMatchObject({ value: 8, coarse: true })
    expect(zero).toMatchObject({ value: 4, coarse: true })
  })

  /**
   * Nothing readable, so nothing kept. Guessing would invent an opinion the
   * user never held and feed it to the recommendations.
   */
  it('drops a record that holds neither a value nor a like or dislike', () => {
    const kept = ratingsOf(
      legacy({ rating: 'meh' }),
      legacy({ key: 'tv:tt2', tmdbId: 2, rating: undefined, value: 'ten' }),
      legacy({ key: 'tv:tt3', tmdbId: 3 }),
    )
    expect(kept.map((r) => r.key)).toEqual(['tv:tt3'])
  })

  it('converts a tombstone too, and leaves it deleted', () => {
    const [gone] = ratingsOf(legacy({ deletedAt: 1_700_000_900_000, updatedAt: 1_700_000_900_000 }))
    expect(gone).toMatchObject({ value: 8, coarse: true, deletedAt: 1_700_000_900_000 })
  })

  /**
   * The seam, which is where the last `migrate` bug lived. One device has
   * upgraded and re-rated the title a 9; another is still on 1.7.3 and holds
   * the same key as a plain like. Whichever write is newer must win, and the
   * result must read as a rating after the next load either way.
   */
  describe('composed with the merge', () => {
    const upgraded = (updatedAt: number) =>
      migrate(
        {
          schemaVersion: SCHEMA_VERSION,
          ratings: [legacy({ value: 9, coarse: false, rating: 'like', updatedAt })],
        },
        9_999,
      )
    // What an old build pushes: never migrated by this code, legacy string only.
    const old = (rating: string, updatedAt: number) =>
      ({ schemaVersion: SCHEMA_VERSION, ratings: [legacy({ rating, updatedAt })] }) as never

    it('keeps the newer 9 over an older legacy dislike', () => {
      const merged = migrate(mergeDocuments(upgraded(5_000), migrate(old('dislike', 4_000))))
      expect(merged.ratings[0]).toMatchObject({ value: 9, coarse: false, rating: 'like' })
    })

    it('lets a newer legacy dislike from the old device beat an older 9', () => {
      const merged = migrate(mergeDocuments(upgraded(4_000), migrate(old('dislike', 5_000))))
      expect(merged.ratings[0]).toMatchObject({ value: 4, coarse: true, rating: 'dislike' })
      expect(merged.ratings[0]?.updatedAt).toBe(5_000)
    })

    /**
     * The direction the old device sees. It merges the upgraded record
     * wholesale, and its own migrate knows nothing of `value` — so this build
     * must read the result correctly when the record comes back unchanged.
     */
    it('reads back an upgraded record that round-tripped through an old device', () => {
      const pushed = upgraded(5_000)
      const [record] = migrate(JSON.parse(JSON.stringify(pushed))).ratings
      expect(record).toMatchObject({ value: 9, coarse: false, rating: 'like', updatedAt: 5_000 })
    })
  })
})

describe('stored provider scans', () => {
  const scanned = (scan: Record<string, unknown>) =>
    migrate({ ...emptyStore(), providerScans: [{ titleKey: 'tv:tt1', at: 1_000, ...scan }] })
      .providerScans[0]

  it('keeps the time a streaming provider took to start', () => {
    const scan = scanned({ verdicts: { a: 'stream', b: 'dead' }, timings: { a: 3_800 } })
    expect(scan?.timings).toEqual({ a: 3_800 })
  })

  it('drops a time beside any verdict but stream', () => {
    // A timing next to "dead" describes a moment that did not happen, and
    // would print as "no stream · 3.8 s".
    const scan = scanned({
      verdicts: { a: 'stream', b: 'dead', c: 'unsure' },
      timings: { a: 2_000, b: 3_000, c: 4_000, gone: 5_000 },
    })
    expect(scan?.timings).toEqual({ a: 2_000 })
  })

  it('drops a time that is not a duration', () => {
    const scan = scanned({
      verdicts: { a: 'stream', b: 'stream', c: 'stream', d: 'stream' },
      timings: { a: '3800', b: -1, c: Number.NaN, d: 1_500 },
    })
    expect(scan?.timings).toEqual({ d: 1_500 })
  })

  it('reads a scan saved before times were recorded as having none', () => {
    const scan = scanned({ verdicts: { a: 'stream' } })
    expect(scan?.verdicts).toEqual({ a: 'stream' })
    expect(scan?.timings).toEqual({})
  })
})

describe('the source order setting', () => {
  it('defaults to the user list first, which changes nothing for an existing install', () => {
    expect(migrate({ ...emptyStore(), settings: { skipIntro: false } }).settings.sourceOrder).toEqual([
      'list',
      'speed',
      'quality',
    ])
  })

  it('repairs a stored order rather than trusting it', () => {
    const doc = migrate({ ...emptyStore(), settings: { sourceOrder: ['speed', 'nonsense'] } })
    expect(doc.settings.sourceOrder).toEqual(['speed', 'list', 'quality'])
  })
})

describe('stored scan qualities', () => {
  const scanned = (scan: Record<string, unknown>) =>
    migrate({ ...emptyStore(), providerScans: [{ titleKey: 'movie:tt1', at: 1_000, ...scan }] })
      .providerScans[0]

  it('keeps a quality class beside a streaming verdict', () => {
    expect(scanned({ verdicts: { a: 'stream' }, qualities: { a: 1080 } })?.qualities).toEqual({ a: 1080 })
  })

  it('drops a quality that is not a class a label can show, or sits beside no stream', () => {
    const scan = scanned({
      verdicts: { a: 'stream', b: 'stream', c: 'dead' },
      qualities: { a: 800, b: '1080', c: 1080 },
    })
    expect(scan?.qualities).toEqual({})
  })
})
