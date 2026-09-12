import { describe, expect, it } from 'vitest'
import {
  creditsTailSeconds,
  isWatchedEnough,
  resumeAction,
  resumeKey,
  shouldSeek,
  shouldStorePosition,
} from './resume'

describe('resumeKey', () => {
  it('separates episodes of the same title', () => {
    expect(resumeKey({ tmdbId: 5, season: 1, episode: 2 })).not.toBe(
      resumeKey({ tmdbId: 5, season: 1, episode: 3 }),
    )
  })

  it('gives a film a stable key without season or episode', () => {
    expect(resumeKey({ tmdbId: 7, season: null, episode: null })).toBe('7:m:m')
  })
})

describe('shouldStorePosition', () => {
  it('ignores the first minute as a false start', () => {
    expect(shouldStorePosition(42, 3600)).toBe(false)
  })

  it('keeps a real position', () => {
    expect(shouldStorePosition(900, 3600)).toBe(true)
  })

  it('treats a position past the watched line as finished', () => {
    // Resuming into the credits is worse than starting over, and it would offer
    // to resume something the app has already ticked off.
    expect(shouldStorePosition(3500, 3600)).toBe(false)
  })

  it('keeps a position when the duration is unknown', () => {
    expect(shouldStorePosition(900, 0)).toBe(true)
  })

  it('rejects a nonsense position', () => {
    expect(shouldStorePosition(Number.NaN, 3600)).toBe(false)
  })
})

describe('resumeAction', () => {
  it('keeps the stored position when nothing could be read', () => {
    // The bug this function exists for. A provider whose player is nested too
    // deep to reach produces no reading, and that used to be treated as "this
    // title has no position" — so switching to such a provider mid-episode
    // deleted the place a working one had saved, and switching back started
    // from zero.
    expect(resumeAction(null)).toBe('keep')
  })

  it('keeps the stored position through the first minute of a new stream', () => {
    // The normal state two seconds after a switch. Nothing has been learned,
    // so nothing should be thrown away.
    expect(resumeAction({ seconds: 3, duration: 3600 })).toBe('keep')
  })

  it('stores a real position', () => {
    expect(resumeAction({ seconds: 900, duration: 3600 })).toBe('store')
  })

  it('stores a real position when the duration is not yet known', () => {
    expect(resumeAction({ seconds: 900, duration: 0 })).toBe('store')
  })

  it('forgets a position past the watched line', () => {
    // 3600s has a 216s tail, so the line is at 3384s.
    expect(resumeAction({ seconds: 3500, duration: 3600 })).toBe('forget')
  })

  it('forgets when the element says it ended, wherever the position sits', () => {
    // Some players seek back to zero on ending, at which point `seconds` alone
    // claims the title was barely started.
    expect(resumeAction({ seconds: 0, duration: 3600, ended: true })).toBe('forget')
    expect(resumeAction({ seconds: 3599, duration: 3600, ended: true })).toBe('forget')
  })

  it('keeps the stored position for a nonsense reading', () => {
    expect(resumeAction({ seconds: Number.NaN, duration: 3600 })).toBe('keep')
    expect(resumeAction({ seconds: -5, duration: 3600 })).toBe('keep')
  })

  it('never forgets on the strength of an implausible duration alone', () => {
    // Providers report a few seconds of duration while the stream resolves.
    // Reading that as "watched to the end" is how a title got ticked off two
    // seconds after it opened.
    expect(resumeAction({ seconds: 5, duration: 8 })).toBe('keep')
  })
})

describe('shouldSeek', () => {
  it('seeks when the provider started from the beginning', () => {
    expect(shouldSeek(900, 0, 3600)).toBe(true)
  })

  it('leaves a provider that restored the position itself alone', () => {
    // Seeking on top of that fights a feature the site already has.
    expect(shouldSeek(900, 880, 3600)).toBe(false)
  })

  it('tolerates a few seconds of start-up drift', () => {
    expect(shouldSeek(900, 4, 3600)).toBe(true)
  })

  it('never seeks backwards', () => {
    expect(shouldSeek(300, 20, 3600)).toBe(true)
    expect(shouldSeek(10, 20, 3600)).toBe(false)
  })

  it('does not resume something already finished', () => {
    expect(shouldSeek(3500, 0, 3600)).toBe(false)
  })
})

describe('isWatchedEnough', () => {
  const base = { playedMs: 0, runtimeMinutes: null, fallbackMs: 15 * 60_000 }

  it('measures from the end, not from the middle', () => {
    // A 60-minute title has a 216s tail, so the line is at 3384s. Halfway is
    // emphatically not watched — that was the old rule and it marked an
    // abandoned film as finished.
    expect(isWatchedEnough({ ...base, seconds: 1800, duration: 3600 })).toBe(false)
    expect(isWatchedEnough({ ...base, seconds: 3400, duration: 3600 })).toBe(true)
  })

  it('lets the credits go unwatched', () => {
    // Stopping four minutes before the end of a 90-minute film is how people
    // finish things; the tail there is 324s.
    expect(isWatchedEnough({ ...base, seconds: 5160, duration: 5400 })).toBe(true)
  })

  it('does not let the tail run away on a very long title', () => {
    // Six minutes is the cap. Without it, 6% of a four-hour cut would hand back
    // the last quarter of an hour as "seen".
    expect(creditsTailSeconds(4 * 3600)).toBe(6 * 60)
  })

  it('keeps a floor under the tail on a short one', () => {
    // 6% of ten minutes is 36s, which would demand the very last frame.
    expect(creditsTailSeconds(600)).toBe(45)
  })

  it('trusts the video reaching its own end over any threshold', () => {
    expect(isWatchedEnough({ ...base, seconds: 12, duration: 3600, ended: true })).toBe(true)
  })

  it('refuses an implausible duration rather than marking it watched instantly', () => {
    // Providers report a few seconds while the stream is still resolving. The
    // arithmetic without a floor gives a negative threshold, which every
    // position clears.
    expect(isWatchedEnough({ ...base, seconds: 3, duration: 4 })).toBe(false)
  })

  it('prefers position over elapsed time when they disagree', () => {
    // Skipping forward advances the position and not the elapsed time. The
    // position is the honest answer to "how far through is this".
    expect(
      isWatchedEnough({
        seconds: 3400,
        duration: 3600,
        playedMs: 5_000,
        runtimeMinutes: 60,
        fallbackMs: 1,
      }),
    ).toBe(true)
  })

  it('falls back to elapsed time against the runtime, on the same end-relative rule', () => {
    // A 40-minute runtime is 2400s with a 144s tail, so the line is at 2256s.
    const args = { seconds: null, duration: null, runtimeMinutes: 40, fallbackMs: 15 * 60_000 }
    expect(isWatchedEnough({ ...args, playedMs: 38 * 60_000 })).toBe(true)
    expect(isWatchedEnough({ ...args, playedMs: 30 * 60_000 })).toBe(false)
  })

  it('falls back to a floor when nothing is known', () => {
    const args = { seconds: null, duration: null, runtimeMinutes: null, fallbackMs: 15 * 60_000 }
    expect(isWatchedEnough({ ...args, playedMs: 16 * 60_000 })).toBe(true)
    expect(isWatchedEnough({ ...args, playedMs: 60_000 })).toBe(false)
  })

  it('does not count a duration of zero as a completed title', () => {
    // A live or unseekable stream reports 0; treating that as "past half of
    // nothing" would mark everything watched on sight, which is the bug the
    // threshold exists to prevent.
    expect(isWatchedEnough({ ...base, seconds: 5, duration: 0 })).toBe(false)
  })
})
