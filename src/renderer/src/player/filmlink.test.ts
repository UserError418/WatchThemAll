import { describe, expect, it } from 'vitest'

import { TAG } from '@shared/filmrelay'
import { FilmLink, INTENT_MS, INTENT_RETRY_MS, STALE_MS } from './filmlink'

const film = (id: string, duration: number, seconds = 0, extra: Record<string, unknown> = {}) => ({
  [TAG]: 1,
  film: { id, seconds, duration, paused: false, ended: false, volume: 1, muted: false, rate: 1, buffered: 0, waiting: false, ...extra },
})

function setup(): { link: FilmLink; sent: Array<Record<string, unknown>>; clock: { now: number } } {
  const sent: Array<Record<string, unknown>> = []
  const clock = { now: 1_000 }
  const link = new FilmLink((message) => sent.push(message), () => clock.now)
  return { link, sent, clock }
}

describe('FilmLink', () => {
  it('takes the longest reporting frame for the film, never an advert', () => {
    const { link } = setup()
    link.receive(film('ad', 30, 5))
    expect(link.view().film).toBeNull()
    link.receive(film('movie', 2_885, 600))
    expect(link.view().film?.id).toBe('movie')
  })

  it('aims every command that moves a video at the film by its length', () => {
    const { link, sent } = setup()
    link.receive(film('movie', 2_885))
    link.seekBy(10)
    link.setVolume(0.5)
    expect(sent.map((m) => [m.command, m.duration])).toEqual([
      ['seekBy', 2_885],
      ['volume', 2_885],
    ])
  })

  it('sends nothing that moves a video before there is a film', () => {
    const { link, sent } = setup()
    link.setPaused(false)
    link.seekTo(100)
    expect(sent).toEqual([])
  })

  /**
   * VidRock, measured: the first play starts its real stream, which aborts that
   * play, and the film sits paused. The request is made again, until it holds.
   */
  it('asks again while the film contradicts a play, then lets go', () => {
    const { link, sent, clock } = setup()
    link.receive(film('movie', 2_892.8, 0, { paused: true }))
    link.setPaused(false)
    // The 'play' event, then the new load: paused again, and a settled length.
    link.receive(film('movie', 2_892.8, 0, { paused: false }))
    clock.now += INTENT_RETRY_MS + 1
    link.receive(film('movie', 2_885.8, 0, { paused: true }))
    expect(sent.filter((m) => m.command === 'setPaused').map((m) => m.paused)).toEqual([false, false])
    expect(link.wanted()).toBe(false)

    clock.now += INTENT_MS
    link.receive(film('movie', 2_885.8, 0, { paused: true }))
    expect(sent.filter((m) => m.command === 'setPaused')).toHaveLength(2)
    expect(link.wanted()).toBeNull()
  })

  it('does not repeat itself faster than the retry interval', () => {
    const { link, sent, clock } = setup()
    link.receive(film('movie', 2_885, 0, { paused: true }))
    link.setPaused(false)
    clock.now += 100
    link.receive(film('movie', 2_885, 0, { paused: true }))
    expect(sent.filter((m) => m.command === 'setPaused')).toHaveLength(1)
  })

  /** A frame that loads after the source's interface was hidden is hidden too. */
  it('restates watch, hide and the chosen track when a relay says hello', () => {
    const { link, sent } = setup()
    link.receive(film('movie', 2_885))
    link.setHidden(true)
    link.chooseTrack(2)
    sent.length = 0
    link.receive({ [TAG]: 1, hello: 'new-frame' })
    expect(sent.map((m) => m.command)).toEqual(['watch', 'hide', 'track'])
  })

  it('hides and unhides once per change', () => {
    const { link, sent } = setup()
    link.setHidden(true)
    link.setHidden(true)
    link.setHidden(false)
    expect(sent.map((m) => m.command)).toEqual(['hide', 'unhide'])
  })

  it('forgets a frame that has stopped reporting', () => {
    const { link, clock } = setup()
    link.receive(film('movie', 2_885))
    clock.now += STALE_MS + 1
    expect(link.view().film).toBeNull()
  })

  it("keeps the film's tracks and cues, and not an advert's", () => {
    const { link } = setup()
    link.receive(film('movie', 2_885))
    link.receive({ [TAG]: 1, id: 'movie', tracks: [{ index: 0, label: 'English', language: 'en' }] })
    link.receive({ [TAG]: 1, id: 'ad', cues: ['Buy now'] })
    link.receive({ [TAG]: 1, id: 'movie', cues: ['Say my name.'] })
    expect(link.view().tracks.map((t) => t.label)).toEqual(['English'])
    expect(link.view().cues).toEqual(['Say my name.'])
  })
})
