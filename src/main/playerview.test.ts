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
import { candidate, episodeRequest, fakeWindow, lastContents } from './playerview.fixture'

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
