/**
 * The choices `tmdb.ts` makes among what TMDB offers. The requests themselves
 * are not tested here; these are the rules that decide what the user sees.
 */

import { describe, expect, it } from 'vitest'
import { pickLogo, type TmdbLogo } from './tmdb'

const logo = (file_path: string, iso_639_1: string | null, vote_average: number): TmdbLogo => ({
  file_path,
  iso_639_1,
  vote_average,
})

describe('pickLogo', () => {
  it('takes the best-voted English logo', () => {
    expect(
      pickLogo([logo('/fan.png', 'en', 2.1), logo('/official.png', 'en', 5.4), logo('/alt.png', 'en', 3.3)]),
    ).toBe('/official.png')
  })

  it('never takes a logo the user may not be able to read, however well voted', () => {
    expect(pickLogo([logo('/ja.png', 'ja', 9.9), logo('/en.png', 'en', 1)])).toBe('/en.png')
    expect(pickLogo([logo('/ja.png', 'ja', 9.9), logo('/none.png', null, 5)])).toBeNull()
  })

  it('says null rather than guessing when there is nothing', () => {
    expect(pickLogo([])).toBeNull()
    expect(pickLogo(undefined)).toBeNull()
  })
})
