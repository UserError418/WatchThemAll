import { describe, expect, it } from 'vitest'
import type { TitleRef } from '@shared/ipc'
import { liveRunApplies, runIsAbout, type LiveRun } from './liverun'

const SHOW: TitleRef = { type: 'tv', imdbId: 'tt0903747', tmdbId: 1396 }
const FILM: TitleRef = { type: 'movie', imdbId: 'tt0137523', tmdbId: 550 }
const S1E1 = { season: 1, episode: 1 }
const S1E2 = { season: 1, episode: 2 }

/** What a run of the show's S1E2 is about, as its progress names it. */
const ofS1E2 = { titleKey: 'tv:tt0903747', episode: S1E2 }

describe('runIsAbout', () => {
  it('is about the title and the episode it measured', () => {
    expect(runIsAbout(ofS1E2, SHOW, S1E2)).toBe(true)
  })

  it('is not about another episode of the same title', () => {
    // The red dot on a row Automatic put first: a run of S1E2 found it dead,
    // and the list showed S1E1.
    expect(runIsAbout(ofS1E2, SHOW, S1E1)).toBe(false)
    expect(runIsAbout(ofS1E2, SHOW, null)).toBe(false)
  })

  it('is not about another title', () => {
    expect(runIsAbout(ofS1E2, { ...SHOW, imdbId: 'tt0000001' }, S1E2)).toBe(false)
    // A film and a series sharing a TMDB id are two titles.
    expect(runIsAbout({ titleKey: 'movie:tt0903747', episode: null }, SHOW, null)).toBe(false)
  })

  it('compares titles by the key their results are filed under', () => {
    // No IMDB id: the run's results are filed under the TMDB id, and so is the list's read.
    const bare: TitleRef = { type: 'tv', imdbId: null, tmdbId: 1396 }
    expect(runIsAbout({ titleKey: 'tv:tmdb1396', episode: S1E2 }, bare, S1E2)).toBe(true)
    expect(runIsAbout({ titleKey: 'tv:tmdb1396', episode: S1E2 }, SHOW, S1E2)).toBe(false)
  })

  it('treats a film as having no episode', () => {
    expect(runIsAbout({ titleKey: 'movie:tt0137523', episode: null }, FILM, null)).toBe(true)
    // A reading of a film that names S1E1 (Videasy does) is still about the film.
    expect(runIsAbout({ titleKey: 'movie:tt0137523', episode: S1E1 }, FILM, null)).toBe(true)
    expect(runIsAbout({ titleKey: 'movie:tt0137523', episode: null }, FILM, S1E1)).toBe(true)
  })

  it('is about nothing before any run has spoken', () => {
    expect(runIsAbout(null, SHOW, S1E2)).toBe(false)
  })
})

describe('liveRunApplies', () => {
  const running: LiveRun = { subject: ofS1E2, running: true, finished: 1 }
  const over: LiveRun = { subject: ofS1E2, running: false, finished: 2 }

  it('draws a run of this episode while it runs, whatever the list read', () => {
    expect(liveRunApplies(running, SHOW, S1E2, 0)).toBe(true)
    expect(liveRunApplies(running, SHOW, S1E2, 1)).toBe(true)
  })

  it('never draws a run of another episode, running or not', () => {
    expect(liveRunApplies(running, SHOW, S1E1, 0)).toBe(false)
    expect(liveRunApplies(over, SHOW, S1E1, 0)).toBe(false)
  })

  it('keeps the finished run up until the stored results are read again', () => {
    // Asked before the run was over (finished was 1): the answer cannot hold
    // the run's results, so the run's own verdicts stay.
    expect(liveRunApplies(over, SHOW, S1E2, 1)).toBe(true)
  })

  it('hands over to the stored results once they are read after the run', () => {
    // Asked once the run was over: the stored decision, which also orders
    // Automatic, colours the dots from here.
    expect(liveRunApplies(over, SHOW, S1E2, 2)).toBe(false)
  })

  it('treats a cancelled run like a finished one', () => {
    // Cancelling ends a run with whatever settled; the count does not care why it ended.
    const cancelled: LiveRun = { subject: ofS1E2, running: false, finished: 3 }
    expect(liveRunApplies(cancelled, SHOW, S1E2, 2)).toBe(true)
    expect(liveRunApplies(cancelled, SHOW, S1E2, 3)).toBe(false)
  })

  it('draws the next run again from its start', () => {
    const next: LiveRun = { subject: ofS1E2, running: true, finished: 2 }
    expect(liveRunApplies(next, SHOW, S1E2, 2)).toBe(true)
  })
})
