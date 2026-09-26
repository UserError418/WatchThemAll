import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import {
  DEFAULT_SELECTED,
  DEFAULT_TARGETS,
  findBestMatch,
  mediaTypeFor,
  parseMalExport,
  pickBestMatch,
  type RankableMatch,
  ratingFromScore,
  searchVariants,
} from './malimport'

/** One `<anime>` block, with only the fields the parser reads. */
function entry(fields: Record<string, string | number>): string {
  const body = Object.entries(fields)
    .map(([tag, value]) =>
      typeof value === 'string' && /[&<>]/.test(value)
        ? `<${tag}><![CDATA[${value}]]></${tag}>`
        : `<${tag}>${value}</${tag}>`,
    )
    .join('\n')
  return `<anime>\n${body}\n</anime>`
}

function doc(...blocks: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<myanimelist>
  <myinfo><user_name>PredixBeats</user_name></myinfo>
  ${blocks.join('\n')}
</myanimelist>`
}

describe('parseMalExport', () => {
  it('reads the account name and the entries', () => {
    const xml = doc(
      entry({
        series_animedb_id: 38735,
        series_title: '7 Seeds',
        series_type: 'ONA',
        series_episodes: 12,
        my_watched_episodes: 12,
        my_score: 7,
        my_status: 'Completed',
      }),
    )

    const result = parseMalExport(xml)

    expect(result.userName).toBe('PredixBeats')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({
      malId: 38735,
      title: '7 Seeds',
      status: 'completed',
      score: 7,
      watchedEpisodes: 12,
      totalEpisodes: 12,
      seriesType: 'ONA',
    })
  })

  it('unwraps CDATA, which MAL uses for any title containing punctuation', () => {
    const xml = doc(
      entry({
        series_title: 'Fate/stay night: Heaven’s Feel — I. presage flower & more',
        my_status: 'Completed',
      }),
    )

    expect(parseMalExport(xml).entries[0]?.title).toBe(
      'Fate/stay night: Heaven’s Feel — I. presage flower & more',
    )
  })

  it('accepts every spelling of the statuses', () => {
    const xml = doc(
      entry({ series_title: 'a', my_status: 'Watching' }),
      entry({ series_title: 'b', my_status: 'Completed' }),
      entry({ series_title: 'c', my_status: 'On-Hold' }),
      entry({ series_title: 'd', my_status: 'On Hold' }),
      entry({ series_title: 'e', my_status: 'Dropped' }),
      entry({ series_title: 'f', my_status: 'Plan to Watch' }),
      entry({ series_title: 'g', my_status: 'plantowatch' }),
    )

    expect(parseMalExport(xml).entries.map((e) => e.status)).toEqual([
      'watching',
      'completed',
      'onHold',
      'onHold',
      'dropped',
      'planToWatch',
      'planToWatch',
    ])
  })

  it('skips an unreadable entry and keeps the rest', () => {
    // An import that silently drops part of someone's library is worse than one
    // that says it did, so the count is reported rather than swallowed.
    const xml = doc(
      entry({ series_title: 'fine', my_status: 'Completed' }),
      entry({ series_title: 'no status' }),
      entry({ my_status: 'Completed' }),
      entry({ series_title: 'also fine', my_status: 'Watching' }),
    )

    const result = parseMalExport(xml)

    expect(result.entries.map((e) => e.title)).toEqual(['fine', 'also fine'])
    expect(result.skipped).toBe(2)
  })

  it('rejects a file that is not a MAL export', () => {
    // The user picked the wrong file. Telling them beats importing nothing and
    // reporting success.
    expect(() => parseMalExport('<opml><body/></opml>')).toThrow(/not a MyAnimeList export/)
  })

  it('treats a missing numeric field as zero rather than NaN', () => {
    const xml = doc(entry({ series_title: 'a', my_status: 'Completed' }))
    const parsed = parseMalExport(xml).entries[0]!

    expect(parsed.score).toBe(0)
    expect(parsed.totalEpisodes).toBe(0)
    expect(parsed.malId).toBe(0)
  })

  /**
   * The real 311-entry export, when it is present.
   *
   * Not committed: it is one person's actual anime list, and this repository is
   * expected to become public. Point `WTA_MAL_FIXTURE` at an export to run it.
   * The synthetic cases above cover every parsing rule; this one adds the thing
   * they cannot — that the parser survives a real file, at real size, with real
   * titles.
   */
  const fixture = process.env.WTA_MAL_FIXTURE
  it.skipIf(!fixture || !existsSync(fixture))('reads a real export end to end', () => {
    const result = parseMalExport(readFileSync(fixture!, 'utf8'))

    /**
     * Checked against the file's *own* accounting, not against numbers pasted
     * from a run. `<myinfo>` declares the totals MAL believes it exported, so
     * this asserts the parser agrees with the source rather than with itself.
     */
    const declared = (tag: string): number =>
      Number(new RegExp(`<${tag}>(\\d+)</${tag}>`).exec(readFileSync(fixture!, 'utf8'))?.[1])

    expect(result.skipped).toBe(0)
    expect(result.entries).toHaveLength(declared('user_total_anime'))

    const byStatus = (status: string): number =>
      result.entries.filter((e) => e.status === status).length
    expect(byStatus('watching')).toBe(declared('user_total_watching'))
    expect(byStatus('completed')).toBe(declared('user_total_completed'))
    expect(byStatus('onHold')).toBe(declared('user_total_onhold'))
    expect(byStatus('dropped')).toBe(declared('user_total_dropped'))
    expect(byStatus('planToWatch')).toBe(declared('user_total_plantowatch'))
  })
})

describe('ratingFromScore', () => {
  /** The same 1–10 in the same hands; remapping would second-guess the user. */
  it('maps every MAL score one to one', () => {
    for (let score = 1; score <= 10; score += 1) expect(ratingFromScore(score)).toBe(score)
  })

  /**
   * Kept now, where they used to be dropped as a shrug. With ratings centred
   * on the user's own mean, a 6 or a 7 is exactly the calibration the taste
   * model reads.
   */
  it('keeps the middle of the scale', () => {
    expect(ratingFromScore(6)).toBe(6)
    expect(ratingFromScore(7)).toBe(7)
  })

  it("reads MAL's 0 as not scored, and anything off the scale as nothing", () => {
    for (const score of [0, -1, 11, 7.5, NaN]) expect(ratingFromScore(score)).toBeNull()
  })
})

describe('defaults', () => {
  it('routes each status somewhere sensible', () => {
    expect(DEFAULT_TARGETS.watching).toBe('watchlist')
    expect(DEFAULT_TARGETS.completed).toBe('watched')
    expect(DEFAULT_TARGETS.planToWatch).toBe('releases')
    // A paused show is one the user still intends to finish, and the watchlist
    // is what keeps the resume position that makes finishing possible.
    expect(DEFAULT_TARGETS.onHold).toBe('watchlist')
  })

  it('leaves dropped titles deselected', () => {
    // They are a real signal for the recommendation, but filing 57 abandoned
    // shows as "watched" would misrepresent the library at a glance.
    expect(DEFAULT_SELECTED.dropped).toBe(false)
    expect(DEFAULT_SELECTED.completed).toBe(true)
  })
})

describe('mediaTypeFor', () => {
  it('maps only Movie to a film', () => {
    expect(mediaTypeFor('Movie')).toBe('movie')
    expect(mediaTypeFor('movie')).toBe('movie')
  })

  it('maps every episodic MAL type to tv', () => {
    for (const type of ['TV', 'ONA', 'OVA', 'Special', 'Music']) {
      expect(mediaTypeFor(type)).toBe('tv')
    }
  })
})

describe('searchVariants', () => {
  it('always tries the full title first', () => {
    // "Sword Art Online Alternative: Gun Gale Online" is a distinct series that
    // matches verbatim; stripping the subtitle first would resolve it to the
    // wrong show.
    const variants = searchVariants('Sword Art Online Alternative: Gun Gale Online')

    expect(variants[0]).toBe('Sword Art Online Alternative: Gun Gale Online')
  })

  it('strips the season and part suffixes MAL adds', () => {
    for (const [title, base] of [
      ['Vinland Saga Season 2', 'Vinland Saga'],
      ['Hataraku Maou-sama!! 2nd Season', 'Hataraku Maou-sama!!'],
      ['Re:Zero kara Hajimeru Isekai Seikatsu 3rd Season', 'Re:Zero kara Hajimeru Isekai Seikatsu'],
      ['Dead Mount Death Play Part 2', 'Dead Mount Death Play'],
      ['Tensei shitara Ken deshita II', 'Tensei shitara Ken deshita'],
      ['Overlord 2', 'Overlord'],
      // MAL drops the word "Season" often enough to need its own rule.
      ['Shirokuma Cafe 2nd', 'Shirokuma Cafe'],
    ] as const) {
      expect(searchVariants(title)).toContain(base)
    }
  })

  it('does not strip a leading or interior "Season"', () => {
    // Unanchored, this would turn "Season of the Witch" into "of the Witch".
    expect(searchVariants('Season of the Witch')).toEqual(['Season of the Witch'])
  })

  it('never strips a trailing bare I', () => {
    // Far too many titles legitimately end in one.
    expect(searchVariants('Kimi no Na wa I')).not.toContain('Kimi no Na wa')
  })

  it('falls back to the part before a colon, but last', () => {
    const variants = searchVariants('Bleach: Sennen Kessen-hen')

    expect(variants).toContain('Bleach')
    expect(variants.indexOf('Bleach')).toBe(variants.length - 1)
  })

  it('truncates a light-novel title at its first comma', () => {
    // These are a sentence — hook, comma, premise — and TMDB indexes them
    // under a far shorter name.
    expect(searchVariants('Shin no Nakama ja Nai to Iwarete, Henkyou de Slow Life')).toContain(
      'Shin no Nakama ja Nai to Iwarete',
    )
  })

  it('cuts at whichever of colon or comma comes first', () => {
    expect(searchVariants('One, Two: Three')).toContain('One')
  })

  it('strips a trailing disambiguator', () => {
    expect(searchVariants('JoJo no Kimyou na Bouken (TV)')).toContain('JoJo no Kimyou na Bouken')
  })

  it('combines a subtitle cut with a part number', () => {
    // Neither alone finds anything: "Part 3" is not at the end until the
    // subtitle is dropped, and the subtitle cut leaves the part number behind.
    expect(searchVariants('JoJo no Kimyou na Bouken Part 3: Stardust Crusaders')).toContain(
      'JoJo no Kimyou na Bouken',
    )
  })

  it('produces no duplicates and nothing too short to search', () => {
    const variants = searchVariants('A: B')

    expect(new Set(variants).size).toBe(variants.length)
    expect(variants.every((v) => v.length >= 2)).toBe(true)
  })
})

describe('pickBestMatch', () => {
  const tv = (title: string, voteCount: number): RankableMatch =>
    ({ type: 'tv', title, voteCount })

  it('returns null when nothing was found', () => {
    expect(pickBestMatch('anything', 'tv', [])).toBeNull()
  })

  it('prefers the most-voted-on result over the first', () => {
    // Searching "Boku no Hero Academia" really does return the Vigilantes
    // spin-off first; taking result zero files the wrong show.
    const best = pickBestMatch('Boku no Hero Academia', 'tv', [
      tv('My Hero Academia: Vigilantes', 12),
      tv('My Hero Academia', 480),
    ])

    expect(best?.title).toBe('My Hero Academia')
  })

  it('lets an exact title beat a better-known one', () => {
    // Gun Gale Online is a distinct series far less popular than its parent.
    const best = pickBestMatch('Sword Art Online Alternative: Gun Gale Online', 'tv', [
      tv('Sword Art Online', 900),
      tv('Sword Art Online Alternative: Gun Gale Online', 40),
    ])

    expect(best?.title).toBe('Sword Art Online Alternative: Gun Gale Online')
  })

  it('matches a title across punctuation and case differences', () => {
    const best = pickBestMatch('dandadan', 'tv', [tv('Popular Other', 900), tv('Dan Da Dan', 50)])

    expect(best?.title).toBe('Dan Da Dan')
  })

  it('prefers the requested media type', () => {
    const best = pickBestMatch('Some Title', 'movie', [
      tv('A Series', 900),
      { type: 'movie', title: 'A Film', voteCount: 10 },
    ])

    expect(best?.title).toBe('A Film')
  })

  it('falls back to the wrong type rather than returning nothing', () => {
    // An anime film and the series it was cut from often share a name, and
    // TMDB does not always agree with MAL about which is which.
    const best = pickBestMatch('Some Title', 'movie', [tv('A Series', 900)])

    expect(best?.title).toBe('A Series')
  })

  it('still picks something when no result reports a vote count', () => {
    const best = pickBestMatch('x', 'tv', [
      { type: 'tv', title: 'A' },
      { type: 'tv', title: 'B' },
    ])

    expect(best).not.toBeNull()
  })
  /** Measured on a real export: an American crime drama shares the anime's exact title. */
  it('considers only animated results when there are any', () => {
    const best = pickBestMatch('Golden Boy', 'tv', [
      { type: 'tv', title: 'Golden Boy', voteCount: 34, genreIds: [80, 18] },
      { type: 'tv', title: 'Golden Boy', voteCount: 538, genreIds: [16, 35] },
    ])

    expect(best?.voteCount).toBe(538)
  })

  /** A 0-vote stub filed under the romanised title used to win rule 1 outright. */
  it('lets an animated series beat an exact title that is not animated', () => {
    const best = pickBestMatch('Tate no Yuusha no Nariagari', 'tv', [
      { type: 'movie', title: 'Tate no Yuusha no Nariagari', voteCount: 0 },
      { type: 'tv', title: 'The Rising of the Shield Hero', voteCount: 1593, genreIds: [16] },
    ])

    expect(best?.title).toBe('The Rising of the Shield Hero')
  })

  it('considers everything when nothing is animated', () => {
    const best = pickBestMatch('Innocence', 'movie', [
      { type: 'tv', title: 'Innocence', voteCount: 5 },
      { type: 'movie', title: 'Innocence', voteCount: 110 },
    ])

    expect(best).toMatchObject({ type: 'movie', title: 'Innocence' })
  })

  it('prefers the requested type among several exact titles', () => {
    // "Mob Psycho 100" is both the series and a film, and TMDB may list either first.
    const best = pickBestMatch('Mob Psycho 100', 'tv', [
      { type: 'movie', title: 'Mob Psycho 100', voteCount: 30 },
      tv('Mob Psycho 100', 2000),
    ])

    expect(best?.type).toBe('tv')
  })
})

describe('findBestMatch', () => {
  type Result = RankableMatch & { id: number }
  const ANIME = [16]
  /** A TMDB search that answers from a table, recording what it was asked. */
  function searchFrom(table: Record<string, Result[]>) {
    const asked: string[] = []
    const search = async (term: string): Promise<Result[]> => {
      asked.push(term)
      return table[term] ?? []
    }
    return { search, asked }
  }

  /**
   * Measured on a real library: the full title finds only a recap film, and
   * the shorter term finds the series. Stopping at the first term that found
   * anything filed the film as the anime.
   */
  it('passes over a wrong-typed pick when a shorter term finds the right type', async () => {
    const { search } = searchFrom({
      'Shingeki no Kyojin Season 3': [
        { id: 492999, type: 'movie', title: 'Attack on Titan: The Roar of Awakening', voteCount: 300, genreIds: ANIME },
      ],
      'Shingeki no Kyojin': [
        { id: 295830, type: 'movie', title: 'Attack on Titan', voteCount: 500 },
        { id: 1429, type: 'tv', title: 'Attack on Titan', voteCount: 7000, genreIds: ANIME },
      ],
    })

    const best = await findBestMatch('Shingeki no Kyojin Season 3', 'tv', search)

    expect(best?.id).toBe(1429)
  })

  it('still settles for the wrong type when no term finds the right one', async () => {
    const { search } = searchFrom({
      'Some Special Season 2': [{ id: 7, type: 'movie', title: 'Some Special: The Movie', voteCount: 10, genreIds: ANIME }],
    })

    const best = await findBestMatch('Some Special Season 2', 'tv', search)

    expect(best?.id).toBe(7)
  })

  it('takes the first wrong-typed pick as the fallback, not a later one', async () => {
    const { search } = searchFrom({
      'Some Special Season 2': [{ id: 7, type: 'movie', title: 'First Film', voteCount: 10, genreIds: ANIME }],
      'Some Special': [{ id: 8, type: 'movie', title: 'Second Film', voteCount: 900, genreIds: ANIME }],
    })

    expect((await findBestMatch('Some Special Season 2', 'tv', search))?.id).toBe(7)
  })

  /** An exact title still wins outright, whatever its type (`pickBestMatch` rule 1). */
  it('stops at an exact title even when it is the other type', async () => {
    const { search, asked } = searchFrom({
      'Kimi no Na wa Season 2': [{ id: 372058, type: 'movie', title: 'Kimi no Na wa Season 2', voteCount: 9000, genreIds: ANIME }],
      'Kimi no Na wa': [{ id: 1, type: 'tv', title: 'Something Else', voteCount: 10, genreIds: ANIME }],
    })

    expect((await findBestMatch('Kimi no Na wa Season 2', 'tv', search))?.id).toBe(372058)
    expect(asked).toEqual(['Kimi no Na wa Season 2'])
  })

  it('stops searching at the first right-typed pick', async () => {
    const { search, asked } = searchFrom({
      'Mob Psycho 100 II': [{ id: 67075, type: 'tv', title: 'Mob Psycho 100', voteCount: 2000, genreIds: ANIME }],
    })

    expect((await findBestMatch('Mob Psycho 100 II', 'tv', search))?.id).toBe(67075)
    expect(asked).toHaveLength(1)
  })

  /**
   * A term that finds only a live-action namesake is no better than one that
   * finds the wrong type: the anime may still turn up under a shorter term.
   */
  it('passes over a pick that is not animated when a shorter term finds one', async () => {
    const { search } = searchFrom({
      'Grand Blue Season 2': [{ id: 677602, type: 'tv', title: 'Grand Blue Live', voteCount: 24 }],
      'Grand Blue': [{ id: 79166, type: 'tv', title: 'Grand Blue Dreaming', voteCount: 200, genreIds: ANIME }],
    })

    expect((await findBestMatch('Grand Blue Season 2', 'tv', search))?.id).toBe(79166)
  })

  it('returns null when no term finds anything', async () => {
    const { search } = searchFrom({})

    expect(await findBestMatch('Nothing Here', 'tv', search)).toBeNull()
  })
})
