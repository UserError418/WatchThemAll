import { describe, expect, it } from 'vitest'

import { progressIsAbout } from './scanprogress'

describe('progressIsAbout', () => {
  const S1E2 = { season: 1, episode: 2 }

  it('takes a run of the title and episode playing', () => {
    expect(progressIsAbout({ titleKey: 'tv:tt1', episode: S1E2 }, 'tv:tt1', S1E2)).toBe(true)
    expect(progressIsAbout({ titleKey: 'movie:tt2', episode: null }, 'movie:tt2', null)).toBe(true)
  })

  it('refuses another title, and another episode of this one', () => {
    expect(progressIsAbout({ titleKey: 'tv:tt9', episode: S1E2 }, 'tv:tt1', S1E2)).toBe(false)
    expect(progressIsAbout({ titleKey: 'tv:tt1', episode: { season: 1, episode: 1 } }, 'tv:tt1', S1E2)).toBe(false)
  })

  it('takes a run that does not say its episode, by its title alone', () => {
    expect(progressIsAbout({ titleKey: 'tv:tt1' }, 'tv:tt1', S1E2)).toBe(true)
  })
})
