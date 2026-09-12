import { describe, expect, it } from 'vitest'
import {
  automaticOrder,
  defaultProviderOrder,
  lastWorkingForTitle,
  MAX_OUTCOMES,
  mediaKey,
  outcomesForTitle,
  record,
  spreadAcrossGroups,
  type StreamOutcome,
  type TitleOutcome,
} from './outcomes'
import type { Provider } from '@shared/types'

/**
 * The order that decides what "Automatic" picks.
 *
 * Every case here is one where getting it wrong is silent — the user just sees
 * a provider that does not work chosen ahead of one that does, and has no way
 * to know why. That is what retired the previous scored ranking: it was right
 * more often and impossible to predict, so a favourite losing to a
 * more-recently-used source read as the favourite setting being broken.
 */

function provider(id: string, group?: string): Provider {
  return {
    id,
    name: id,
    rootUrl: `https://${id}.example/`,
    tv: { urlTemplate: '{rootUrl}tv/{imdb}/{season}/{episode}' },
    movie: { urlTemplate: '{rootUrl}movie/{imdb}' },
    ...(group ? { group } : {}),
  }
}

const NOW = 1_800_000_000_000
const recently = NOW - 60_000

function outcome(providerId: string, key: string, result: 'stream' | 'failed', at = recently): StreamOutcome {
  return { providerId, mediaKey: key, outcome: result, at }
}

describe('identifying what was played', () => {
  it('keys an episode down to the episode', () => {
    // Title-level keying would recommend a provider for season 4 because it
    // once served season 1, and coverage gaps are per-season in practice.
    expect(mediaKey({ type: 'tv', imdbId: 'tt0903747', tmdbId: 1396, season: 2, episode: 5 })).toBe(
      'tv:tt0903747:2:5',
    )
  })

  it('keys a film without a position', () => {
    expect(mediaKey({ type: 'movie', imdbId: 'tt0137523', tmdbId: 550 })).toBe('movie:tt0137523')
  })

  it('prefers the IMDB id, which is what providers themselves key on', () => {
    const withImdb = mediaKey({ type: 'movie', imdbId: 'tt1', tmdbId: 550 })
    const withoutImdb = mediaKey({ type: 'movie', imdbId: null, tmdbId: 550 })

    expect(withImdb).toBe('movie:tt1')
    // Two records for the same film must not land under different keys just
    // because one play started from a TMDB-sourced summary.
    expect(withoutImdb).toBe('movie:tmdb550')
  })

  it('defaults a series with no stored position to S01E01', () => {
    expect(mediaKey({ type: 'tv', imdbId: 'tt1', tmdbId: 1, season: null, episode: null })).toBe('tv:tt1:1:1')
  })
})

describe('the outcome log', () => {
  it('drops the oldest entries once full rather than growing without limit', () => {
    let log: StreamOutcome[] = []
    for (let i = 0; i < MAX_OUTCOMES + 50; i += 1) {
      log = record(log, { providerId: 'p', mediaKey: `movie:tt${i}`, outcome: 'stream' })
    }

    expect(log).toHaveLength(MAX_OUTCOMES)
    expect(log[0]!.mediaKey).toBe('movie:tt50')
  })
})

describe('spreading the fallback chain across backends', () => {
  it('tries a different backend before another door onto the same one', () => {
    const chain = [
      { provider: provider('m1', 'vidsrc') },
      { provider: provider('m2', 'vidsrc') },
      { provider: provider('m3', 'vidsrc') },
      { provider: provider('solo') },
    ]

    expect(spreadAcrossGroups(chain).map((c) => c.provider.id)).toEqual(['m1', 'solo', 'm2', 'm3'])
  })

  it('treats an ungrouped provider as its own backend', () => {
    const chain = [{ provider: provider('a') }, { provider: provider('b') }, { provider: provider('c') }]
    expect(spreadAcrossGroups(chain).map((c) => c.provider.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps every candidate, only reordering them', () => {
    const chain = [
      { provider: provider('m1', 'g') },
      { provider: provider('m2', 'g') },
      { provider: provider('x') },
    ]
    expect(spreadAcrossGroups(chain)).toHaveLength(3)
  })

  it('preserves the ranking order within a group', () => {
    // The ranking already decided which mirror best represents its backend;
    // spreading must not undo that.
    const chain = [
      { provider: provider('best', 'g') },
      { provider: provider('worse', 'g') },
      { provider: provider('solo') },
    ]
    const spread = spreadAcrossGroups(chain).map((c) => c.provider.id)
    expect(spread.indexOf('best')).toBeLessThan(spread.indexOf('worse'))
  })
})

describe('outcomesForTitle', () => {
  const at = Date.now()

  it('reports nothing for a provider that has never been tried', () => {
    const result = outcomesForTitle([], 'tv:tt0903747')

    expect(result['vidlux']).toBeUndefined()
  })

  it('marks a provider that streamed any episode as worked', () => {
    const log: StreamOutcome[] = [
      { providerId: 'vidlux', mediaKey: 'tv:tt0903747:2:5', outcome: 'stream', at },
    ]

    expect(outcomesForTitle(log, 'tv:tt0903747')['vidlux']).toBe('worked')
  })

  it('marks a provider that only ever failed as failed', () => {
    const log: StreamOutcome[] = [
      { providerId: 'moviesapi', mediaKey: 'tv:tt0903747:1:1', outcome: 'failed', at },
      { providerId: 'moviesapi', mediaKey: 'tv:tt0903747:1:2', outcome: 'failed', at },
    ]

    expect(outcomesForTitle(log, 'tv:tt0903747')['moviesapi']).toBe('failed')
  })

  it('keeps worked even when a later episode failed', () => {
    // A provider that has ever streamed this show demonstrably can. A later
    // failure is far more likely one missing episode than a lost catalogue,
    // and going red would steer the user off the only source known to carry it.
    const log: StreamOutcome[] = [
      { providerId: 'vidfast', mediaKey: 'tv:tt0903747:1:1', outcome: 'stream', at },
      { providerId: 'vidfast', mediaKey: 'tv:tt0903747:4:9', outcome: 'failed', at: at + 1 },
    ]

    expect(outcomesForTitle(log, 'tv:tt0903747')['vidfast']).toBe('worked')
  })

  it('does not leak between titles with a shared id prefix', () => {
    const log: StreamOutcome[] = [
      { providerId: 'vidlux', mediaKey: 'tv:tt0903747:1:1', outcome: 'stream', at },
    ]

    // `tt09037` is a prefix of `tt0903747` as a string but a different title.
    expect(outcomesForTitle(log, 'tv:tt09037')['vidlux']).toBeUndefined()
  })

  it('matches a film, whose key has no episode suffix', () => {
    const log: StreamOutcome[] = [
      { providerId: 'vidlux', mediaKey: 'movie:tt0137523', outcome: 'stream', at },
    ]

    expect(outcomesForTitle(log, 'movie:tt0137523')['vidlux']).toBe('worked')
  })

  it('does not confuse a film with a series of the same id', () => {
    const log: StreamOutcome[] = [
      { providerId: 'vidlux', mediaKey: 'movie:tt0137523', outcome: 'stream', at },
    ]

    expect(outcomesForTitle(log, 'tv:tt0137523')['vidlux']).toBeUndefined()
  })
})

describe('lastWorkingForTitle', () => {
  const title = 'tv:tt0903747'

  it('finds the most recent provider that streamed any episode of it', () => {
    const log = [
      outcome('alpha', `${title}:1:1`, 'stream', 100),
      outcome('bravo', `${title}:1:2`, 'stream', 200),
    ]

    expect(lastWorkingForTitle(log, title)).toBe('bravo')
  })

  it('ignores providers that only failed', () => {
    // Being opened proves nothing; the point is that it played.
    const log = [
      outcome('alpha', `${title}:1:1`, 'stream', 100),
      outcome('bravo', `${title}:1:2`, 'failed', 200),
    ]

    expect(lastWorkingForTitle(log, title)).toBe('alpha')
  })

  it('ignores other titles', () => {
    const log = [outcome('alpha', 'tv:tt9999999:1:1', 'stream', 500)]

    expect(lastWorkingForTitle(log, title)).toBeNull()
  })

  it('does not confuse an id that is a prefix of another', () => {
    // `tt09037` must not match `tt0903747`; the separator is what stops it.
    const log = [outcome('alpha', 'tv:tt09037:1:1', 'stream', 500)]

    expect(lastWorkingForTitle(log, title)).toBeNull()
  })

  it('matches a film, whose title key and media key are the same string', () => {
    expect(lastWorkingForTitle([outcome('alpha', 'movie:tt1', 'stream')], 'movie:tt1')).toBe('alpha')
  })

  it('is null when nothing has ever played', () => {
    expect(lastWorkingForTitle([], title)).toBeNull()
  })
})

describe('the order Automatic tries providers in', () => {
  const providers = [provider('alpha'), provider('bravo'), provider('charlie'), provider('delta')]
  const order = ['delta', 'charlie', 'bravo', 'alpha']

  /** Shorthand: what the user's provider list says about one title. */
  function seen(entries: Record<string, TitleOutcome>): Record<string, TitleOutcome> {
    return entries
  }

  it('follows the user order when nothing is known about the title', () => {
    expect(automaticOrder(providers, {}, { order }).map((p) => p.id)).toEqual(order)
  })

  it('puts favourites first, in the user order', () => {
    const ranked = automaticOrder(providers, {}, { order, favouriteIds: ['alpha', 'charlie'] })

    // Charlie ahead of alpha because that is the order the user dragged them
    // into — favouriting does not create a second, hidden ordering.
    expect(ranked.map((p) => p.id)).toEqual(['charlie', 'alpha', 'delta', 'bravo'])
  })

  it('narrows to sources known to have played this title', () => {
    const ranked = automaticOrder(providers, seen({ bravo: 'worked' }), { order })

    expect(ranked[0]!.id).toBe('bravo')
  })

  it('keeps a favourite first when it is one of the known-working sources', () => {
    // The reported bug, exactly: one favourite, known to work for this title,
    // and Automatic opened something else because that something else had
    // streamed the title more recently. Recency is no longer an input.
    const ranked = automaticOrder(
      providers,
      seen({ alpha: 'worked', delta: 'worked' }),
      { order, favouriteIds: ['alpha'] },
    )

    expect(ranked[0]!.id).toBe('alpha')
  })

  it('does not promote a favourite that has never worked for this title', () => {
    // Favourites lead the *narrowed* list. A favourite that is not in it has
    // no evidence behind it for this title, and jumping it over a source that
    // demonstrably works would be the old bug with the sign flipped.
    const ranked = automaticOrder(providers, seen({ bravo: 'worked' }), {
      order,
      favouriteIds: ['alpha'],
    })

    expect(ranked[0]!.id).toBe('bravo')
    // Still ahead of the other unknowns, though — it is the user's preference
    // among sources that are all equally unproven here.
    expect(ranked[1]!.id).toBe('alpha')
  })

  it('keeps the failures reachable behind everything else', () => {
    // Demoted, not dropped. If the one known-working source is down right now,
    // a chain that stops there leaves the user with nothing to try while three
    // untried providers sit unused.
    const ranked = automaticOrder(providers, seen({ delta: 'worked', charlie: 'failed' }), {
      order,
    })

    expect(ranked.map((p) => p.id)).toEqual(['delta', 'charlie', 'bravo', 'alpha'])
  })

  it('puts a provider missing from the saved order last, not first', () => {
    // A catalogue refresh adds providers after the user last dragged anything.
    // Appending is the only safe guess; anywhere else silently moves a source
    // the user deliberately placed.
    const ranked = automaticOrder(providers, {}, { order: ['charlie', 'alpha'] })

    expect(ranked.map((p) => p.id)).toEqual(['charlie', 'alpha', 'bravo', 'delta'])
  })

  it('ignores ids in the order that no longer exist', () => {
    // A provider the user deleted, or one dropped by a catalogue refresh. It
    // must not consume a position and push everything after it down one.
    const ranked = automaticOrder(providers, {}, {
      order: ['deleted', 'bravo', 'charlie', 'alpha', 'delta'],
    })

    expect(ranked.map((p) => p.id)).toEqual(['bravo', 'charlie', 'alpha', 'delta'])
  })

  it('falls back to catalogue order with no saved order at all', () => {
    expect(automaticOrder(providers, {}, {}).map((p) => p.id)).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'delta',
    ])
  })

  it('returns every provider it was given, whatever the outcomes', () => {
    const ranked = automaticOrder(providers, seen({ alpha: 'failed', bravo: 'worked' }), {
      order,
      favouriteIds: ['charlie'],
    })

    expect(ranked).toHaveLength(providers.length)
    expect(new Set(ranked.map((p) => p.id))).toEqual(new Set(providers.map((p) => p.id)))
  })
})

describe('the order a fresh install starts with', () => {
  it('spreads mirrors apart rather than handing the user four dead ends in a row', () => {
    const catalogue = [
      provider('m1', 'mirror'),
      provider('m2', 'mirror'),
      provider('m3', 'mirror'),
      provider('solo'),
    ]

    expect(defaultProviderOrder(catalogue)).toEqual(['m1', 'solo', 'm2', 'm3'])
  })
})
