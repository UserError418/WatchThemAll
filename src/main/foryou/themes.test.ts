import { describe, expect, it, vi } from 'vitest'
import { titleAffinity } from '../taste'
import { THEME_SOURCES, themeCandidates, themeTitle } from './themes'
import { NOW, rated, store } from './testing'

const kw = (id: number, name: string) => ({ id, name })

/** Favourites 1–4 in descending strength, and one title the user disliked. */
const titles = titleAffinity(store({
  ratings: [rated(1, 10), rated(2, 9), rated(3, 9), rated(4, 8), rated(9, 2)],
}), NOW)

function keywords(table: Record<number, Array<{ id: number; name: string }>>) {
  return vi.fn(async (id: number) => table[id] ?? [])
}

describe('themeCandidates', () => {
  it('keeps a keyword two favourites share and drops a coincidence', async () => {
    const themes = await themeCandidates(titles, keywords({
      1: [kw(10, 'time travel'), kw(11, 'chess')],
      2: [kw(10, 'time travel')],
    }))
    expect(themes.map((t) => t.name)).toEqual(['time travel'])
    expect(themes[0]).toMatchObject({ keyword: 10, titles: 2 })
  })

  it('ranks themes by how much the user likes the titles carrying them', async () => {
    const themes = await themeCandidates(titles, keywords({
      1: [kw(20, 'isekai')],
      2: [kw(20, 'isekai')],
      3: [kw(10, 'heist')],
      4: [kw(10, 'heist')],
    }))
    // Isekai is carried by the 10 and a 9, heist by a 9 and the 8.
    expect(themes.map((t) => t.keyword)).toEqual([20, 10])
    expect(themes[0]!.weight).toBeGreaterThan(themes[1]!.weight)
  })

  it('passes over keywords about how a title was made rather than what it is about', async () => {
    const generic = [
      kw(1, 'based on manga'), kw(2, 'anime'), kw(3, 'duringcreditsstinger'), kw(4, 'male protagonist'),
      kw(5, 'friendship'), kw(6, 'sibling relationship'), kw(7, 'Seinen'), kw(8, 'sequel'), kw(9, 'woman director'),
    ]
    const themes = await themeCandidates(titles, keywords({ 1: generic, 2: generic }))
    expect(themes).toEqual([])
  })

  it('counts a keyword a title lists twice once', async () => {
    const themes = await themeCandidates(titles, keywords({ 1: [kw(10, 'heist'), kw(10, 'heist')] }))
    expect(themes).toEqual([])
  })

  it(`reads only the ${THEME_SOURCES} strongest favourites, never a dislike`, async () => {
    const many = titleAffinity(store({
      ratings: [...Array.from({ length: 12 }, (_, i) => rated(i + 1, i < 6 ? 10 : 9)), rated(99, 2)],
    }), NOW)
    const fetch = keywords({})
    await themeCandidates(many, fetch)
    expect(fetch).toHaveBeenCalledTimes(THEME_SOURCES)
    expect(fetch.mock.calls.map((c) => c[0])).not.toContain(99)
  })
})

describe('themeTitle', () => {
  it('names the theme, then the lane', () => {
    expect(themeTitle('isekai', 'anime')).toBe('Isekai anime')
    expect(themeTitle(' time travel ', 'series')).toBe('Time travel TV shows')
    expect(themeTitle('heist', 'films')).toBe('Heist movies')
  })
})
