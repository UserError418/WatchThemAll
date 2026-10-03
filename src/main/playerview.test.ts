/**
 * The inline player, against stand-in Electron objects (`playerview.fixture.ts`).
 *
 * What these cover is the player's state across time: requests counted while
 * another feature watches the same session, readings that arrive after the
 * page or the player they were asked of has gone. Each was a bug that every
 * gate passed, because each path is right on its own and wrong only in what
 * happens between them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlayerSuggestion } from '@shared/ipc'

vi.mock('electron', async () => (await import('./playerview.fixture')).fakeElectron)
// What reaches real sessions and frames; not what these tests are about.
vi.mock('./providerguard', () => ({
  blockAdverts: () => {},
  installFilmRelay: () => {},
  keepProviderInPlace: () => {},
  refusePopupsAndDownloads: () => {},
}))
vi.mock('./identity', () => ({ applyProviderReferer: () => {} }))
vi.mock('./pressplay', () => ({ clickPlayInFrames: async () => {}, pressPlay: async () => {} }))
vi.mock('./skiplookup', () => ({ findSegments: async () => [] }))

import { createCastCapture } from './castcapture'
import { createInlinePlayer, type InlinePlayerOptions } from './playerview'
import { candidate, emptyFrame, episodeRequest, fakeWindow, filmFrame, hangingFrame, lastContents } from './playerview.fixture'

function options(overrides: Partial<InlinePlayerOptions> = {}): InlinePlayerOptions {
  return {
    window: fakeWindow() as InlinePlayerOptions['window'],
    dirname: '/app/out/main',
    url: 'https://a.example/play',
    context: episodeRequest(3),
    candidates: [candidate('a'), candidate('b')],
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-03T12:00:00Z') })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('a page still waiting on its backend at the silence deadline', () => {
  it('is offered a switch while casting watches the same session', async () => {
    const offers: Array<PlayerSuggestion | null> = []
    const player = createInlinePlayer(options({ onSuggest: (offer) => void offers.push(offer) }))
    const contents = lastContents()
    // What `openPlayer` does next: casting watches the player's session for the stream.
    createCastCapture().watch(player.session)
    contents.commit()

    // The page asks its backend for the stream and hears nothing back
    // (CinemaOS on "Fetching Prism"): no request finishes for the whole grace period.
    contents.session.webRequest.emit('sendHeaders', {
      id: 1,
      url: 'https://a.example/api/scrape',
      method: 'GET',
      resourceType: 'xhr',
      requestHeaders: {},
    })
    await vi.advanceTimersByTimeAsync(25_000)

    // Loading, not idle: an unanswered request is a page still working.
    expect(offers.filter((offer) => offer !== null)).toHaveLength(1)
    player.destroy()
  })
})

describe('a reading that arrives after its page has gone', () => {
  it('is never filed under the episode stepped to, nor settles its resume', async () => {
    const filed: Array<{ episode: number | null; seconds: number }> = []
    const player = createInlinePlayer(
      options({
        // S1E2 was left at 10:00; everything else starts from the top.
        onNavigate: () => (player.context.episode === 2 ? 600 : 0),
        onPosition: (position) => void filed.push({ episode: player.context.episode, seconds: position.seconds }),
      }),
    )
    const contents = lastContents()
    contents.commit()
    let e3 = 1800
    // An advert frame that never answers makes every poll wait out its 1.5 s timeout.
    contents.frames = [filmFrame(() => ({ seconds: (e3 += 2.5), duration: 2700 })), hangingFrame()]
    await vi.advanceTimersByTimeAsync(12_600) // the poll asked at 12.5 s is still out

    // The viewer picks S1E2, as `navigatePlayer` does it; its shell commits at once.
    player.context = episodeRequest(2)
    player.load('https://a.example/tv/1/1/2')
    contents.frames = [emptyFrame()]
    contents.commit()
    await vi.advanceTimersByTimeAsync(1_500) // the old poll's timeout: S1E3's reading arrives now

    expect(filed.filter((entry) => entry.episode === 2)).toEqual([])
    expect(player.position()).toBeNull()

    // S1E2's own film, on a source that starts at zero: sent to 10:00.
    const e2 = filmFrame(() => ({ seconds: 3, duration: 2650 }))
    contents.frames = [e2]
    await vi.advanceTimersByTimeAsync(5_000)
    expect(e2.seeks).toContain(600)
    player.destroy()
  })

  it('reports nothing once the player has closed', async () => {
    const reports: string[] = []
    let closed = false
    const player = createInlinePlayer(
      options({
        onPosition: () => void reports.push(closed ? 'saved after close' : 'saved'),
        onPositionRead: () => void reports.push(closed ? 'read after close' : 'read'),
      }),
    )
    const contents = lastContents()
    contents.commit()
    let seconds = 4000
    contents.frames = [filmFrame(() => ({ seconds: (seconds += 2.5), duration: 7200 })), hangingFrame()]
    await vi.advanceTimersByTimeAsync(12_600) // a poll is out

    player.destroy()
    closed = true
    await vi.advanceTimersByTimeAsync(2_000)

    // The host files these under the player current when they arrive: after a
    // replace, that is the next title.
    expect(reports.filter((report) => report.includes('after close'))).toEqual([])
  })

  it('leaves no timer running once a player held behind the preview has closed', async () => {
    const player = createInlinePlayer(options({ held: true }))
    const contents = lastContents()
    contents.commit()
    contents.frames = [filmFrame(() => ({ seconds: 30, duration: 2700 }))]
    await vi.advanceTimersByTimeAsync(1_000) // the held poll has run

    player.destroy()
    // Past every per-frame answer timeout a poll left behind.
    await vi.advanceTimersByTimeAsync(1_600)
    expect(vi.getTimerCount()).toBe(0)
  })
})
