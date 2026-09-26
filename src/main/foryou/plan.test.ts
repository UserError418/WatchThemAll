import { describe, expect, it, vi } from 'vitest'
import type { MediaSummary, MediaType } from '@shared/types'
import type { ForYouRow } from '@shared/ipc'
import type { DiscoverQuery } from '../tmdb'
import { titleId, type TasteStore } from '../taste'
import { forYouPlan, forYouRow } from './index'
import { LANES, type Lane } from './lanes'
import {
  BODY_BASE,
  BODY_EXTRA,
  BODY_EXTRA_CAP,
  extraRows,
  isForYouRow,
  laneOrder,
  planRows,
  type PlanInputs,
} from './plan'
import { buildProfile, type Profile } from './profile'
import { becauseCandidates } from './seeds'
import type { Theme } from './themes'
import { anime, genreName, library, media, network, NOW, page, saved, store, wideLibrary } from './testing'

/** Plan inputs as if every "Because you" seed and theme had been found viable. */
function inputs(s: TasteStore, seed = 7, themes: Partial<Record<Lane, Theme[]>> = {}): PlanInputs {
  const profile = buildProfile(s, NOW)
  const perLane = <T>(fn: (lane: Lane) => T[]) =>
    Object.fromEntries(LANES.map((l) => [l, fn(l)])) as Record<Lane, T[]>
  return {
    profile,
    genreName,
    because: perLane((l) => becauseCandidates(profile.lanes[l].titles, profile.names, seed, NOW)),
    themes: perLane((l) => themes[l] ?? []),
  }
}

const theme = (keyword: number, name: string): Theme => ({ keyword, name, weight: 1, titles: 2 })
const laneOfRow = (r: ForYouRow): Lane | null => ('lane' in r && r.kind !== 'topPicks' ? r.lane : null)

/** The body: every row after the Top picks. */
const body = (rows: ForYouRow[]) => rows.filter((r) => r.kind !== 'topPicks')

describe('planRows', () => {
  it('plans nothing for an empty library', () => {
    expect(planRows(inputs(store()))).toEqual([])
  })

  it('leads with one Top picks row per lane, the lane the user likes most first', () => {
    const rows = planRows(inputs(wideLibrary()))
    expect(rows.slice(0, 3).map((r) => r.title)).toEqual([
      'Top anime picks for you',
      'Top TV show picks for you',
      'Top movie picks for you',
    ])
    expect(rows.slice(3).some((r) => r.kind === 'topPicks')).toBe(false)
  })

  it('gives no lane a Top picks row it has no taste for', () => {
    // No anime at all: the page is series and films.
    const s = store({ ratings: wideLibrary().ratings.filter((r) => r.tmdbId > 10) })
    expect(planRows(inputs(s)).filter((r) => r.kind === 'topPicks').map((r) => r.title)).toEqual([
      'Top TV show picks for you',
      'Top movie picks for you',
    ])
  })

  it('never builds Top picks from a favourite that heads a Because row, in any lane', () => {
    for (let seed = 0; seed < 30; seed += 1) {
      const rows = planRows(inputs(wideLibrary(), seed))
      const heads = new Set(rows.flatMap((r) => (r.kind === 'because' ? [titleId(r.seed.type, r.seed.tmdbId)] : [])))
      const seeds = rows.flatMap((r) => (r.kind === 'topPicks' ? r.seeds : []))
      expect(heads.size).toBeGreaterThan(0)
      expect(seeds.some((s) => heads.has(titleId(s.type, s.tmdbId)))).toBe(false)
    }
  })

  it('keeps every lane to its base rows plus at most its share of the extra ones', () => {
    for (let seed = 0; seed < 10; seed += 1) {
      const themes = { anime: [theme(1, 'isekai'), theme(2, 'time travel'), theme(3, 'heist')] }
      const rows = body(planRows(inputs(wideLibrary(), seed, themes)))
      const count = (lane: Lane) => rows.filter((r) => laneOfRow(r) === lane).length
      for (const lane of LANES) expect(count(lane)).toBeLessThanOrEqual(BODY_BASE + BODY_EXTRA_CAP)
      expect(LANES.reduce((sum, l) => sum + count(l), 0)).toBeLessThanOrEqual(LANES.length * BODY_BASE + BODY_EXTRA)
      // Three-quarters of the library is anime; it gets the most, not nearly all.
      expect(count('anime')).toBe(BODY_BASE + BODY_EXTRA_CAP)
      expect(count('series')).toBeGreaterThanOrEqual(BODY_BASE)
    }
  })

  it('never puts two rows of one lane together while another lane still has rows', () => {
    const noAnime = store({ ratings: wideLibrary().ratings.filter((r) => r.tmdbId > 10) })
    const withWatchlist = { ...wideLibrary(), watchlist: [saved(90)] }
    const libraries = [wideLibrary(), noAnime, withWatchlist, library()]
    for (const s of libraries) {
      for (let seed = 0; seed < 10; seed += 1) {
        const lanes = body(planRows(inputs(s, seed))).map(laneOfRow)
        lanes.forEach((lane, i) => {
          if (i === 0 || lane === null || lane !== lanes[i - 1]) return
          // Allowed only once every other lane has run out.
          expect(lanes.slice(i).every((l) => l === null || l === lane)).toBe(true)
        })
      }
    }
  })

  it('closes each round with one discovery row, while they last', () => {
    const rows = body(planRows(inputs(wideLibrary(), 3)))
    const kinds = rows.map((r) => (laneOfRow(r) === null ? 'discovery' : 'lane'))
    // Three lanes, so the first three rounds are three lane rows and a discovery row each.
    expect(kinds.slice(0, 12)).toEqual(Array(3).fill(['lane', 'lane', 'lane', 'discovery']).flat())
  })

  it('rotates which lane leads each round', () => {
    const rows = body(planRows(inputs(wideLibrary(), 3)))
    const leads: Array<Lane | null> = []
    let fresh = true
    for (const r of rows) {
      const lane = laneOfRow(r)
      if (lane === null) fresh = true
      else if (fresh) {
        leads.push(lane)
        fresh = false
      }
    }
    expect(leads.slice(0, 3)).toEqual(['anime', 'series', 'films'])
  })

  it('heads no two shelves with one genre, and no two micro-genres with one keyword, across lanes', () => {
    const shared = [theme(42, 'heist'), theme(43, 'time loop')]
    const rows = planRows(inputs(wideLibrary(), 7, { anime: shared, series: shared, films: shared }))
    const concepts = rows.flatMap((r) => (r.kind === 'genre' ? r.concepts : []))
    expect(new Set(concepts).size).toBe(concepts.length)
    const keywords = rows.flatMap((r) => (r.kind === 'theme' ? [r.keyword] : []))
    expect(keywords.sort()).toEqual([42, 43])
  })

  it('names the lane in the heading of every lane row', () => {
    const rows = planRows(inputs(wideLibrary(), 7, { anime: [theme(42, 'isekai')], films: [theme(43, 'heist')] }))
    const titles = rows.map((r) => r.title)
    expect(titles).toContain('Isekai anime')
    expect(titles).toContain('Heist movies')
    for (const r of rows.filter((r) => r.kind === 'genre')) {
      expect(r.title).toMatch(/ (TV shows|movies|anime)$/)
    }
    for (const r of rows.filter((r) => r.kind === 'because')) {
      expect(r.title).toMatch(/^Because you (loved|liked|watched) Show \d+$/)
    }
  })

  it('drops a shelf it cannot name rather than heading it with a number', () => {
    const rows = planRows({ ...inputs(wideLibrary()), genreName: () => undefined })
    expect(rows.some((r) => r.kind === 'genre')).toBe(false)
  })

  it('adds "More like your watchlist" only for a user with a watchlist', () => {
    expect(planRows(inputs(wideLibrary())).some((r) => r.kind === 'watchlist')).toBe(false)
    const s = { ...wideLibrary(), watchlist: [saved(90), saved(91, [18], 5, 'movie')] }
    const row = planRows(inputs(s)).find((r) => r.kind === 'watchlist')
    expect(row?.kind === 'watchlist' && row.seeds).toEqual([{ tmdbId: 91, type: 'movie' }, { tmdbId: 90, type: 'tv' }])
  })

  it('plans only rows it would accept back, each under its own key', () => {
    for (let seed = 0; seed < 10; seed += 1) {
      const s = { ...wideLibrary(), watchlist: [saved(90)] }
      const rows = planRows(inputs(s, seed, { anime: [theme(42, 'isekai')] }))
      for (const row of rows) expect(isForYouRow(row)).toBe(true)
      expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
    }
  })
})

describe('laneOrder', () => {
  it('orders the lanes the user has a taste in by their share', () => {
    expect(laneOrder(buildProfile(wideLibrary(), NOW))).toEqual(['anime', 'series', 'films'])
    expect(laneOrder(buildProfile(store(), NOW))).toEqual([])
  })
})

describe('extraRows', () => {
  const shares = (anime: number, series: number, films: number) =>
    ({ lanes: { anime: { share: anime }, series: { share: series }, films: { share: films } } }) as unknown as Profile
  const plenty = { series: 9, films: 9, anime: 9 }

  it('hands the extra rows out by share, capped per lane', () => {
    // D'Hondt: anime, anime (now capped), series, then films' 0.10 beats series' 0.15 / 2.
    expect(extraRows(shares(0.75, 0.15, 0.1), ['anime', 'series', 'films'], plenty)).toEqual({ anime: 2, series: 1, films: 1 })
  })

  it('skips a lane that has no rows left to give', () => {
    const scarce = { ...plenty, anime: BODY_BASE }
    expect(extraRows(shares(0.75, 0.15, 0.1), ['anime', 'series', 'films'], scarce)).toEqual({ anime: 0, series: 2, films: 2 })
  })

  it('gives nothing to a lane nobody likes', () => {
    expect(extraRows(shares(1, 0, 0), ['anime', 'series', 'films'], plenty)).toEqual({ anime: 2, series: 0, films: 0 })
  })
})

describe('isForYouRow', () => {
  const seed = { tmdbId: 1, type: 'tv' }
  const base = { key: 'k', title: 't' }

  it('accepts every kind main plans', () => {
    expect(isForYouRow({ ...base, kind: 'topPicks', lane: 'films', seeds: [seed] })).toBe(true)
    expect(isForYouRow({ ...base, kind: 'topPicks', lane: 'films', seeds: [] })).toBe(true)
    expect(isForYouRow({ ...base, kind: 'because', lane: 'anime', seed })).toBe(true)
    expect(isForYouRow({ ...base, kind: 'genre', lane: 'series', concepts: [18, 80] })).toBe(true)
    expect(isForYouRow({ ...base, kind: 'theme', lane: 'anime', keyword: 42 })).toBe(true)
    expect(isForYouRow({ ...base, kind: 'mixed', flavour: 'gems' })).toBe(true)
    expect(isForYouRow({ ...base, kind: 'watchlist', seeds: [seed] })).toBe(true)
  })

  it('refuses rows main could not have planned', () => {
    expect(isForYouRow({ ...base, kind: 'topPicks', seeds: [seed] })).toBe(false)
    expect(isForYouRow({ ...base, kind: 'topPicks', lane: 'music', seeds: [seed] })).toBe(false)
    expect(isForYouRow({ ...base, kind: 'topPicks', lane: 'films', seeds: Array(7).fill(seed) })).toBe(false)
    expect(isForYouRow({ ...base, kind: 'topPicks', lane: 'films' })).toBe(false)
    expect(isForYouRow({ ...base, kind: 'because', lane: 'anime', seed: { tmdbId: -1, type: 'tv' } })).toBe(false)
    expect(isForYouRow({ ...base, kind: 'because', lane: 'anime', seed: { tmdbId: 1, type: 'person' } })).toBe(false)
    expect(isForYouRow({ ...base, kind: 'genre', lane: 'series', concepts: [1, 2, 3] })).toBe(false)
    expect(isForYouRow({ ...base, kind: 'genre', lane: 'series', concepts: [] })).toBe(false)
    expect(isForYouRow({ ...base, kind: 'theme', lane: 'anime', keyword: '42' })).toBe(false)
    expect(isForYouRow({ ...base, kind: 'mixed', flavour: 'trending' })).toBe(false)
    expect(isForYouRow({ ...base, kind: 'watchlist', seeds: [] })).toBe(false)
    expect(isForYouRow({ kind: 'mixed', flavour: 'new', title: 't' })).toBe(false)
    expect(isForYouRow({ ...base, kind: 'url' })).toBe(false)
    expect(isForYouRow(null)).toBe(false)
  })
})

/* ── The plan, against a fake network ────────────────────────────────────── */

const plenty = (base: number, make: (id: number) => MediaSummary = media) =>
  Array.from({ length: 10 }, (_, i) => make(base + i))

describe('forYouPlan', () => {
  const names = async (type: MediaType) =>
    Object.entries({ 18: 'Drama', 35: 'Comedy', 80: 'Crime', 10759: 'Action & Adventure', 10765: 'Sci-Fi & Fantasy' })
      .filter(([id]) => type === 'tv' || id !== '10759')
      .map(([id, name]) => ({ id: Number(id), name }))

  it("passes over a favourite whose recommendations are another lane's", async () => {
    // Title 1 is anime, but TMDB recommends live action for it: as an anime
    // row it would be a heading over nothing.
    const recs = { 1: plenty(100), 2: plenty(200, anime), 5: plenty(500, anime), 3: plenty(300), 4: plenty(400) }
    for (let seed = 0; seed < 20; seed += 1) {
      const plan = await forYouPlan(library(), seed, network(recs, { genres: names }), NOW)
      const because = plan.rows.flatMap((r) => (r.kind === 'because' ? [`${r.lane}:${r.seed.tmdbId}`] : []))
      expect(because.sort()).toEqual(['anime:2', 'anime:5', 'series:3', 'series:4'])
    }
  })

  it('keeps a micro-genre only when TMDB has enough of it in the lane', async () => {
    const keywords = vi.fn(async (id: number) =>
      id === 3 || id === 4 ? [{ id: 42, name: 'heist' }, { id: 43, name: 'time loop' }] : [],
    )
    const discover = vi.fn(async (type: MediaType, q: DiscoverQuery) => {
      if (type !== 'tv' || q.language) return page([])
      if (q.withKeywords === '42') return page(plenty(600))
      if (q.withKeywords === '43') return page(plenty(700).slice(0, 3))
      return page([])
    })
    const plan = await forYouPlan(library(), 1, network({}, { keywords, discover, genres: names }), NOW)
    expect(plan.rows.filter((r) => r.kind === 'theme').map((r) => r.title)).toEqual(['Heist TV shows'])
    // The anime lane is too thin to have themes of its own, and is not asked.
    expect(keywords.mock.calls.map((c) => c[0]).filter((id) => [1, 2, 5].includes(id))).toEqual([])
  })

  it('still plans every other row when genre names fail to load', async () => {
    const recs = Object.fromEntries([1, 2, 5].map((id) => [id, plenty(id * 100, anime)]))
    Object.assign(recs, { 3: plenty(300), 4: plenty(400) })
    const genres = async () => {
      throw new Error('offline')
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const plan = await forYouPlan(library(), 3, network(recs, { genres }), NOW)
    spy.mockRestore()
    const kinds = plan.rows.map((r) => r.kind)
    expect(kinds.filter((k) => k === 'topPicks')).toHaveLength(3)
    expect(kinds).toContain('because')
    expect(kinds).toContain('mixed')
    expect(kinds).not.toContain('genre')
  })

  it("places hand-added animation by asking TMDB for its language", async () => {
    const s = store({
      ...wideLibrary(),
      watched: wideLibrary().watched.map((w) => (w.tmdbId === 1 ? { ...w, source: 'user' as const } : w)),
    })
    const originalLanguage = vi.fn(async () => 'ja')
    await forYouPlan(s, 1, network({}, { originalLanguage, genres: names }), NOW)
    expect(originalLanguage).toHaveBeenCalledWith(1, 'tv')
  })
})

describe('forYouRow', () => {
  it('serves an empty page for a row main did not plan', async () => {
    const net = network({ 1: [media(100)] })
    const bogus = { kind: 'because', key: 'k', title: 't', seed: { tmdbId: 1, type: 'tv' } } as unknown as ForYouRow
    const result = await forYouRow(library(), { row: bogus, page: 1 }, net, NOW)
    expect(result.items).toEqual([])
    expect(net.recommendations).not.toHaveBeenCalled()
  })

  it('reads a nonsense page number as the first', async () => {
    const row: ForYouRow = { kind: 'because', key: 'k', title: 't', lane: 'series', seed: { tmdbId: 1, type: 'tv' } }
    const result = await forYouRow(library(), { row, page: -3 }, network({ 1: [media(100)] }), NOW)
    expect(result.page).toBe(1)
    expect(result.items.map((m) => m.tmdbId)).toEqual([100])
  })
})
