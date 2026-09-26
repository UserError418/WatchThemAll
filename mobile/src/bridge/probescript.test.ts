/**
 * The probe's page script runs inside provider frames nobody can watch, on a
 * WebView the four gates never see. What can be checked here is its logic —
 * that media is muted before it plays, that play is pressed on schedule and
 * that pressing stops once something plays — against a minimal fake of the
 * handful of DOM features it touches. Whether it reaches cross-origin frames
 * at all is a device question, answered by the spike's emulator runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PRESS_AT_MS, probePageScript } from './probescript'

/** A media element that records whether it was muted each time `play()` ran. */
function mediaClass() {
  return class FakeMedia {
    muted = false
    paused = true
    currentTime = 0
    mutedAtPlay: boolean[] = []
    play(): Promise<void> {
      this.mutedAtPlay.push(this.muted)
      this.paused = false
      return Promise.resolve()
    }
  }
}

type Media = InstanceType<ReturnType<typeof mediaClass>>
type Listener = (event: { target: unknown }) => void

interface Page {
  Media: ReturnType<typeof mediaClass>
  video: Media | null
  control: { click: () => void } | null
  firstButton: { click: () => void } | null
  dispatch(type: string, target: unknown): void
}

/** Stub the globals the script reads, then run it the way the WebView would. */
function load(page: Omit<Page, 'dispatch'>, options?: { pressPlay?: boolean }): Page {
  const listeners: Record<string, Listener[]> = {}
  vi.stubGlobal('HTMLMediaElement', page.Media)
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('location', { host: 'player.example' })
  vi.stubGlobal('document', {
    addEventListener: (type: string, listener: Listener) => (listeners[type] ??= []).push(listener),
    querySelector: (selector: string) => {
      if (selector === 'video') return page.video
      if (selector === 'button') return page.firstButton
      return page.control
    },
  })
  new Function(probePageScript(options))()
  return {
    ...page,
    dispatch: (type, target) => {
      for (const listener of listeners[type] ?? []) listener({ target })
    },
  }
}

function page(overrides: Partial<Omit<Page, 'dispatch' | 'Media'>> = {}): Omit<Page, 'dispatch'> {
  const Media = mediaClass()
  return {
    Media,
    video: new Media(),
    control: { click: vi.fn() },
    firstButton: { click: vi.fn() },
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('silence', () => {
  it('mutes an element before it plays, whoever calls play()', async () => {
    const { video } = load(page())
    await video!.play()
    expect(video!.mutedAtPlay).toEqual([true])
  })

  it('re-mutes an element that starts by itself or unmutes itself later', () => {
    const loaded = load(page())
    const element = new loaded.Media()
    loaded.dispatch('play', element)
    expect(element.muted).toBe(true)

    element.muted = false
    loaded.dispatch('volumechange', element)
    expect(element.muted).toBe(true)
  })

  it('stays on when pressing is switched off', async () => {
    const { video, control } = load(page(), { pressPlay: false })
    await vi.runAllTimersAsync()
    expect(control!.click).not.toHaveBeenCalled()
    await video!.play()
    expect(video!.mutedAtPlay).toEqual([true])
  })
})

describe('pressing play', () => {
  it('presses the play control and starts a paused video on the first scheduled press', async () => {
    const { video, control } = load(page())
    await vi.advanceTimersByTimeAsync(PRESS_AT_MS[0]! - 1)
    expect(control!.click).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(control!.click).toHaveBeenCalledTimes(1)
    expect(video!.mutedAtPlay).toEqual([true])
  })

  it('falls back to the first button when nothing is labelled play, as the desktop does', async () => {
    const { firstButton } = load(page({ control: null }))
    await vi.advanceTimersByTimeAsync(PRESS_AT_MS[0]!)
    expect(firstButton!.click).toHaveBeenCalledTimes(1)
  })

  it('presses once per scheduled time while nothing plays', async () => {
    const { control } = load(page({ video: null }))
    await vi.runAllTimersAsync()
    expect(control!.click).toHaveBeenCalledTimes(PRESS_AT_MS.length)
  })

  it('stops pressing once media in the frame is playing, so a pause control is never hit', async () => {
    const loaded = load(page({ video: null }))
    await vi.advanceTimersByTimeAsync(PRESS_AT_MS[0]!)
    loaded.dispatch('playing', new loaded.Media())
    await vi.runAllTimersAsync()
    expect(loaded.control!.click).toHaveBeenCalledTimes(1)
  })
})
