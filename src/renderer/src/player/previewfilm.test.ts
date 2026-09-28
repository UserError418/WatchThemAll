import { describe, expect, it } from 'vitest'
import type { FilmState } from '@shared/filmrelay'
import type { FilmLink } from './filmlink'
import { MIN_FILM_SECONDS, PRESS_AT_MS, PreviewFilm } from './previewfilm'

/** A FilmLink that reports what the test says and records what it is told. */
function fakeLink() {
  const sent: string[] = []
  let film: FilmState | null = null
  const link = {
    view: () => ({ film, at: 0, tracks: [], cues: [], lastReportAt: 0, wanted: null, quality: null }),
    wanted: () => null,
    setHidden: (hidden: boolean) => sent.push(`hide:${hidden}`),
    setMuted: (muted: boolean) => sent.push(`mute:${muted}`),
    seekTo: (seconds: number) => sent.push(`seek:${seconds}`),
    setPaused: (paused: boolean) => sent.push(`paused:${paused}`),
    pressPlay: () => sent.push('press'),
  } as unknown as FilmLink
  const report = (patch: Partial<FilmState>): void => {
    film = {
      id: 'f1', seconds: 0, duration: 2_700, paused: false, ended: false,
      volume: 1, muted: true, rate: 1, buffered: 0, waiting: false,
      ...(film ?? {}), ...patch,
    }
  }
  return { link, sent, report, clear: () => (film = null) }
}

describe('PreviewFilm', () => {
  it('hides the source from the start and starts only once the time moves', () => {
    const { link, sent, report } = fakeLink()
    const preview = new PreviewFilm(link, 0, true, () => 0)
    expect(sent).toContain('hide:true')
    report({ seconds: 1, paused: false })
    expect(preview.step().started).toBe(false)
    report({ seconds: 1.8 })
    expect(preview.step().started).toBe(true)
  })

  it('does not take an advert for the film', () => {
    const { link, report } = fakeLink()
    const preview = new PreviewFilm(link, 0, true, () => 0)
    report({ duration: MIN_FILM_SECONDS - 1, seconds: 1 })
    preview.step()
    report({ seconds: 3 })
    expect(preview.step().started).toBe(false)
  })

  it('goes to the saved place, and is not shown until it is there', () => {
    const { link, sent, report } = fakeLink()
    let now = 0
    const preview = new PreviewFilm(link, 754, true, () => now)
    report({ seconds: 2 })
    preview.step()
    report({ seconds: 3 })
    expect(preview.step().started).toBe(false)
    expect(sent.filter((s) => s === 'seek:754')).toHaveLength(1)
    now = 3_000
    report({ seconds: 754.5 })
    preview.step()
    report({ seconds: 755.4 })
    expect(preview.step()).toMatchObject({ started: true, seconds: 755.4 })
  })

  it('leaves a source that resumed further on by itself where it is', () => {
    const { link, sent, report } = fakeLink()
    const preview = new PreviewFilm(link, 600, true, () => 0)
    report({ seconds: 1_200 })
    preview.step()
    expect(sent.some((s) => s.startsWith('seek:'))).toBe(false)
  })

  it('keeps the film as muted as the sound button says', () => {
    const { link, sent, report } = fakeLink()
    const preview = new PreviewFilm(link, 0, false, () => 0)
    report({ muted: true })
    preview.step()
    expect(sent).toContain('mute:false')
    preview.setMuted(true)
    expect(preview.state().muted).toBe(true)
  })

  it('starts a paused film, and presses play while there is none', () => {
    const { link, sent, report, clear } = fakeLink()
    let now = 0
    const preview = new PreviewFilm(link, 0, true, () => now)
    clear()
    now = PRESS_AT_MS[0]!
    preview.step()
    preview.step()
    expect(sent.filter((s) => s === 'press')).toHaveLength(1)
    report({ paused: true })
    preview.step()
    expect(sent).toContain('paused:false')
  })
})
