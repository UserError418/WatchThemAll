import { describe, expect, it } from 'vitest'
import {
  creditsTailSeconds,
  isWatchedEnough,
  lengthToStore,
  resumeAction,
  resumeKey,
  ResumeSeek,
  shouldSeek,
  shouldStorePosition,
  WrittenPositions,
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
  /** The owner, 2026-09-29: watching counts however briefly it happened. */
  it('keeps the first minute too, but not the very start', () => {
    expect(shouldStorePosition(42, 3600)).toBe(true)
    expect(shouldStorePosition(0, 3600)).toBe(false)
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

  /**
   * A new stream's first seconds, before its resume seek has taken, are kept
   * out by `ResumeSeek.pending` now, not by a floor here: a few seconds of
   * the film really watched are stored.
   */
  it('stores the first seconds of the film, but not its very start', () => {
    expect(resumeAction({ seconds: 3, duration: 3600 }, 60)).toBe('store')
    expect(resumeAction({ seconds: 0, duration: 3600 }, 60)).toBe('keep')
  })

  /** What the minute's floor did by accident until 2.0.6. */
  it('believes nothing an advert says, not even that it ended', () => {
    expect(resumeAction({ seconds: 12, duration: 30 }, 45)).toBe('keep')
    expect(resumeAction({ seconds: 30, duration: 30, ended: true }, 45)).toBe('keep')
    // A short title TMDB calls short is not an advert.
    expect(resumeAction({ seconds: 60, duration: 170 }, 3)).toBe('store')
  })

  /** A long finale against the show's usual runtime is still the film. */
  it('stores a stream longer than TMDB says', () => {
    expect(resumeAction({ seconds: 900, duration: 4200 }, 45)).toBe('store')
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
    // Seeking on top of that would be a jump for nothing.
    expect(shouldSeek(900, 880, 3600)).toBe(false)
  })

  /** The provider's own memory is per device; ours is synced within seconds. */
  it('moves a provider that resumed somewhere older forward to ours', () => {
    expect(shouldSeek(1500, 600, 3600)).toBe(true)
  })

  it('keeps a provider that is further along than ours', () => {
    expect(shouldSeek(900, 1200, 3600)).toBe(false)
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

describe('WrittenPositions', () => {
  it('lets the first reading through and stops the same one repeating', () => {
    const written = new WrittenPositions()
    expect(written.isChange('tv:1:1:1', 600, 3600)).toBe(true)
    // A paused video: the same reading, thirty seconds later.
    expect(written.isChange('tv:1:1:1', 600, 3600)).toBe(false)
  })

  it('lets a moved position through', () => {
    const written = new WrittenPositions()
    written.isChange('tv:1:1:1', 600, 3600)
    expect(written.isChange('tv:1:1:1', 630, 3600)).toBe(true)
    expect(written.isChange('tv:1:1:1', 630, 3500)).toBe(true)
  })

  it('keeps each title to itself', () => {
    const written = new WrittenPositions()
    written.isChange('tv:1:1:1', 600, 3600)
    expect(written.isChange('tv:1:1:2', 600, 3600)).toBe(true)
  })

  it('treats a reading after a removal as new', () => {
    const written = new WrittenPositions()
    written.isChange('movie:9', 600, 3600)
    written.forget('movie:9')
    expect(written.isChange('movie:9', 600, 3600)).toBe(true)
  })
})

/**
 * The phone's seek through the relay, fed one report of the film's time at a
 * time. A 48-minute episode left at 25 minutes.
 */
describe('shouldSeek from the very start', () => {
  /** Since 2.0.6 a place in the first half minute is saved, so it has to be gone back to. */
  it('seeks to a place saved early when the stream starts from zero', () => {
    expect(shouldSeek(25, 0.9, 2885)).toBe(true)
  })

  it('leaves a provider that has already moved itself close by', () => {
    expect(shouldSeek(625, 610, 2885)).toBe(false)
  })

  it('does not jump for a second or two', () => {
    expect(shouldSeek(2.5, 1, 2885)).toBe(false)
  })
})

describe('ResumeSeek', () => {
  const EPISODE = 2885
  const at = (seconds: number, duration = EPISODE) => ({ seconds, duration })

  it('seeks at the first report from the beginning, and stops once it took', () => {
    const seek = new ResumeSeek(1500, 48, 0)
    expect(seek.pending(0)).toBe(true)
    expect(seek.next(at(2), 0)).toBe(1500)
    expect(seek.pending(1_000)).toBe(true)
    expect(seek.next(at(1502), 2_000)).toBeNull()
    expect(seek.done).toBe(true)
    expect(seek.pending(2_000)).toBe(false)
  })

  /** Positions are held back while it is pending; a source whose film cannot be reached must not hold them for good. */
  it('stops holding positions back after a while, even unsettled', () => {
    const seek = new ResumeSeek(1500, 48, 0)
    expect(seek.pending(ResumeSeek.WAIT_MS - 1)).toBe(true)
    expect(seek.pending(ResumeSeek.WAIT_MS)).toBe(false)
    expect(new ResumeSeek(0, 48, 0).pending(0)).toBe(false)
  })

  it('waits for a length before seeking, since a seek before one is ignored', () => {
    const seek = new ResumeSeek(1500, 48, 0)
    expect(seek.next({ seconds: 0, duration: 0 }, 0)).toBeNull()
    expect(seek.done).toBe(false)
  })

  it('does nothing when the URL already put the video there', () => {
    const seek = new ResumeSeek(1500, 48)
    expect(seek.next(at(1503), 0)).toBeNull()
    expect(seek.done).toBe(true)
  })

  /** A player that attaches its stream late puts itself back at its own start. */
  it('seeks again when the first did not take, but not before a report could show it', () => {
    const seek = new ResumeSeek(1500, 48)
    expect(seek.next(at(1), 0)).toBe(1500)
    expect(seek.next(at(2), 1_000)).toBeNull()
    expect(seek.next(at(4), ResumeSeek.RETRY_MS)).toBe(1500)
    expect(seek.next(at(1501), ResumeSeek.RETRY_MS + 2_000)).toBeNull()
    expect(seek.done).toBe(true)
  })

  it('gives up after its attempts, and does not fight the player after that', () => {
    const seek = new ResumeSeek(1500, 48)
    let now = 0
    for (let i = 0; i < ResumeSeek.ATTEMPTS; i++) {
      expect(seek.next(at(0), now)).toBe(1500)
      now += ResumeSeek.RETRY_MS
    }
    expect(seek.next(at(0), now)).toBeNull()
    expect(seek.done).toBe(true)
    expect(seek.next(at(0), now + 60_000)).toBeNull()
  })

  /** Seeking a pre-roll to 25 minutes would end the advert, then the film starts at zero. */
  it('waits out an advert rather than seeking it', () => {
    const seek = new ResumeSeek(1500, 48)
    expect(seek.next(at(3, 30), 0)).toBeNull()
    expect(seek.done).toBe(false)
    expect(seek.next(at(0), 30_000)).toBe(1500)
  })

  it('never resumes into the credits', () => {
    const seek = new ResumeSeek(EPISODE - 20, 48)
    expect(seek.next(at(0), 0)).toBeNull()
    expect(seek.done).toBe(true)
  })

  it('is done from the start with nothing to resume', () => {
    expect(new ResumeSeek(0, 48).done).toBe(true)
  })
})

/**
 * Measured 2026-10-04: a source served a 272 s clip in a 139-minute film's
 * place, and the film's place (40:21) became the clip's 2:26.
 */
describe('a video far shorter than the title', () => {
  const FILM_MINUTES = 139

  it('is not saved over the place, nor allowed to forget it at its end', () => {
    expect(resumeAction({ seconds: 146, duration: 272 }, FILM_MINUTES)).toBe('keep')
    expect(resumeAction({ seconds: 272, duration: 272, ended: true }, FILM_MINUTES)).toBe('keep')
  })

  it('does not count as having watched the title', () => {
    const clip = { seconds: 270, duration: 272, playedMs: 270_000, runtimeMinutes: FILM_MINUTES, fallbackMs: 60_000 }
    expect(isWatchedEnough({ ...clip, ended: true })).toBe(false)
    expect(isWatchedEnough(clip)).toBe(false)
  })

  it('still lets a short real episode, or a longer cut, through', () => {
    // A 20-minute special of a 45-minute show, and a finale longer than usual.
    expect(resumeAction({ seconds: 600, duration: 20 * 60 }, 45)).toBe('store')
    expect(resumeAction({ seconds: 600, duration: 70 * 60 }, 45)).toBe('store')
    // Nothing known about the title: only the advert floor applies.
    expect(resumeAction({ seconds: 146, duration: 272 }, null)).toBe('store')
  })
})

describe('lengthToStore', () => {
  it("keeps the stored length when a reading does not know it (the preview's kept copy)", () => {
    expect(lengthToStore(0, 8348)).toBe(8348)
    expect(lengthToStore(Number.NaN, 8348)).toBe(8348)
  })

  it("takes the reading's length when it has one, and 0 when nothing is known", () => {
    expect(lengthToStore(2417, 8348)).toBe(2417)
    expect(lengthToStore(0, undefined)).toBe(0)
    expect(lengthToStore(0, null)).toBe(0)
  })
})
