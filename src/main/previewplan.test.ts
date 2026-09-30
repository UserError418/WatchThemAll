/**
 * Which source a detail view previews from, if any.
 */

import { describe, expect, it } from 'vitest'
import type { Provider, ProviderScan } from '@shared/types'
import { PREVIEW_MAX_START_MS, choosePreview, planPreview } from './previewplan'

const provider = (id: string, extra: Partial<Provider> = {}): Provider => ({
  id,
  name: id,
  rootUrl: `https://${id}.test/`,
  tv: { urlTemplate: '{rootUrl}tv/{imdb}/{season}/{episode}' },
  movie: { urlTemplate: '{rootUrl}movie/{imdb}' },
  ...extra,
})

const slow = provider('slow')
const fast = provider('fast')
const faster = provider('faster', { resumeParam: 'startAt' })
const providers = [slow, fast, faster]

const scan = (verdicts: ProviderScan['verdicts'], timings: Record<string, number>): ProviderScan => ({
  titleKey: 'tv:tt0903747',
  at: 0,
  verdicts,
  timings,
})

const episode = { imdbId: 'tt0903747', tmdbId: 1396, type: 'tv' as const, season: 2, episode: 3, providerId: null }

describe('choosePreview', () => {
  it('takes the fastest qualifying source when the usual pick does not qualify', () => {
    const choice = choosePreview({
      providers,
      scan: scan({ slow: 'stream', fast: 'stream', faster: 'stream' }, { slow: 9_000, fast: 3_100, faster: 2_400 }),
      req: episode,
      resume: null,
    })
    expect(choice?.provider.id).toBe('faster')
    expect(choice?.streamMs).toBe(2_400)
    expect(choice?.startSeconds).toBe(0)
  })

  /** The owner, 2026-09-28: preview and Resume show one source, and the usual one when it can. */
  it('keeps the usual pick when it qualifies, even if another is faster', () => {
    const choice = choosePreview({
      providers,
      scan: scan({ slow: 'stream', faster: 'stream' }, { slow: 7_500, faster: 1_000 }),
      req: episode,
      resume: null,
    })
    expect(choice?.provider.id).toBe('slow')
  })

  it('previews a source picked by hand when it qualifies', () => {
    const choice = choosePreview({
      providers,
      scan: scan({ fast: 'stream', faster: 'stream' }, { fast: 3_000, faster: 1_000 }),
      req: { ...episode, providerId: 'fast' },
      resume: null,
    })
    expect(choice?.provider.id).toBe('fast')
  })

  it('never overrules a pick by hand: no preview when it does not qualify', () => {
    const choice = choosePreview({
      providers,
      scan: scan({ slow: 'stream', faster: 'stream' }, { slow: 9_000, faster: 1_000 }),
      req: { ...episode, providerId: 'slow' },
      resume: null,
    })
    expect(choice).toBeNull()
  })

  it('counts exactly the limit as fast enough, and a millisecond over as not', () => {
    const at = choosePreview({ providers, scan: scan({ fast: 'stream' }, { fast: PREVIEW_MAX_START_MS }), req: episode, resume: null })
    const over = choosePreview({ providers, scan: scan({ fast: 'stream' }, { fast: PREVIEW_MAX_START_MS + 1 }), req: episode, resume: null })
    expect(at?.provider.id).toBe('fast')
    expect(over).toBeNull()
  })

  it('ignores a fast timing whose verdict was not a stream', () => {
    const choice = choosePreview({
      providers,
      scan: scan({ faster: 'unsure', fast: 'stream' }, { faster: 1_000, fast: 3_000 }),
      req: episode,
      resume: null,
    })
    expect(choice?.provider.id).toBe('fast')
  })

  it('breaks a tie by the user’s order', () => {
    const choice = choosePreview({
      providers,
      scan: scan({ slow: 'dead', fast: 'stream', faster: 'stream' }, { fast: 2_000, faster: 2_000 }),
      req: episode,
      resume: null,
    })
    expect(choice?.provider.id).toBe('fast')
  })

  it('previews nothing without a test, or with nothing fast enough', () => {
    expect(choosePreview({ providers, scan: null, req: episode, resume: null })).toBeNull()
    expect(choosePreview({ providers, scan: scan({ slow: 'stream' }, { slow: 9_000 }), req: episode, resume: null })).toBeNull()
    expect(choosePreview({ providers, scan: scan({ slow: 'stream' }, { slow: 8_001 }), req: episode, resume: null })).toBeNull()
    expect(choosePreview({ providers, scan: scan({ fast: 'stream' }, {}), req: episode, resume: null })).toBeNull()
  })

  /** A source that was disabled since the test is not in `providers`. */
  it('only previews from enabled sources', () => {
    const choice = choosePreview({ providers: [slow], scan: scan({ fast: 'stream' }, { fast: 1_000 }), req: episode, resume: null })
    expect(choice).toBeNull()
  })

  it('starts at the saved position, in the URL where the source takes one', () => {
    const choice = choosePreview({
      providers,
      scan: scan({ faster: 'stream' }, { faster: 2_000 }),
      req: episode,
      resume: { seconds: 754, duration: 2_700 },
    })
    expect(choice?.startSeconds).toBe(754)
    expect(choice?.url).toContain('startAt=754')
  })

  it('previews a film too', () => {
    const choice = choosePreview({
      providers,
      scan: scan({ fast: 'stream' }, { fast: 2_000 }),
      req: { imdbId: 'tt0137523', tmdbId: 550, type: 'movie', season: null, episode: null, providerId: null },
      resume: null,
    })
    expect(choice?.url).toBe('https://fast.test/movie/tt0137523')
  })
})

/** 2026-09-30: a phone whose titles were tested on the PC kept windows it never showed. */
describe('planPreview', () => {
  it('with a kept copy and no test here, previews from the source Resume uses', () => {
    const choice = planPreview({ providers, scan: null, req: episode, resume: { seconds: 600, duration: 2700 }, keptSource: 'faster' })
    // `slow` is first in Automatic's order: Resume plays it, and the copy covers its start.
    expect(choice?.provider.id).toBe('slow')
    expect(choice?.startSeconds).toBe(600)
    expect(choice?.streamMs).toBeNull()
  })

  /** The owner, 2026-09-30: the copy plays whatever source was chosen. */
  it('takes a source picked by hand over the kept copy\'s own', () => {
    expect(planPreview({ providers, scan: null, req: { ...episode, providerId: 'fast' }, resume: null, keptSource: 'slow' })?.provider.id).toBe('fast')
  })

  it('keeps a tested source that qualifies ahead of anything else', () => {
    const tested = scan({ fast: 'stream' }, { fast: 2_000 })
    expect(planPreview({ providers, scan: tested, req: episode, resume: null, keptSource: 'slow' })?.provider.id).toBe('fast')
  })

  it('has nothing without a qualifying test or a kept copy', () => {
    expect(planPreview({ providers, scan: null, req: episode, resume: null, keptSource: null })).toBeNull()
  })
})
