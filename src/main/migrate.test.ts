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
      { ...entry, updatedAt: 1, deletedAt: null },
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
