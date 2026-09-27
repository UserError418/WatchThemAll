/**
 * The relay runs inside provider frames on a WebView the gates never see.
 * What can be checked here is its logic: that a command reaches a video
 * nested two frames down, that only the right sender is obeyed, and that the
 * video's state climbs back up to the app. It is checked against a small
 * fake of nested windows. Whether the script reaches cross-origin frames at
 * all is a device question, answered on the emulator.
 *
 * The fake delivers `postMessage` synchronously, and names as the sender
 * whichever window's code is running at that moment. That is the one property
 * the relay's security rests on: `event.source` is supplied by the browser.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { mediaRelayScript, parseRelayState, parseRelayTime, relayCommand } from './mediarelay'

const APP = 'https://localhost'

class FakeVideo {
  paused = true
  currentTime = 0
  ended = false
  constructor(
    public duration = 3_600,
    private readonly size = { width: 640, height: 360 },
  ) {}
  play(): Promise<void> {
    this.paused = false
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
  }
  getBoundingClientRect(): { width: number; height: number } {
    return this.size
  }
}

type Message = { data: unknown; source: FakeWindow; origin: string }

/** Whose code is running, and so who a `postMessage` is from. */
let running: FakeWindow | null = null

function as<T>(win: FakeWindow, act: () => T): T {
  const previous = running
  running = win
  try {
    return act()
  } finally {
    running = previous
  }
}

class FakeWindow {
  readonly listeners: Array<(event: Message) => void> = []
  readonly parent: FakeWindow
  readonly top: FakeWindow
  constructor(
    readonly origin: string,
    parent?: FakeWindow,
  ) {
    this.parent = parent ?? this
    this.top = parent ? parent.top : this
  }
  addEventListener(type: string, listener: (event: Message) => void): void {
    if (type === 'message') this.listeners.push(listener)
  }
  postMessage(data: unknown): void {
    const source = running
    if (source === null) throw new Error('postMessage with nobody running')
    as(this, () => {
      for (const listener of this.listeners) listener({ data, source, origin: source.origin })
    })
  }
}

interface Frame {
  win: FakeWindow
  videos: FakeVideo[]
  children: Frame[]
  /** A media event in this frame's document, as the page would fire it. */
  fire(type: 'playing' | 'pause' | 'timeupdate' | 'ended', target: unknown): void
}

function frame(origin: string, parent?: Frame): Frame {
  const win = new FakeWindow(origin, parent?.win)
  const capture: Record<string, Array<(event: { target: unknown }) => void>> = {}
  const self: Frame = {
    win,
    videos: [],
    children: [],
    fire: (type, target) => as(win, () => capture[type]?.forEach((listener) => listener({ target }))),
  }
  const document = {
    querySelectorAll: (selector: string) =>
      selector === 'video'
        ? self.videos
        : selector === 'iframe'
          ? self.children.map((child) => ({ contentWindow: child.win }))
          : [],
    addEventListener: (type: string, listener: (event: { target: unknown }) => void) =>
      (capture[type] ??= []).push(listener),
  }
  parent?.children.push(self)
  // Run the script as this frame's own document would: its free `window`,
  // `document` and `HTMLVideoElement` are this frame's.
  new Function('window', 'document', 'HTMLVideoElement', mediaRelayScript(APP))(win, document, FakeVideo)
  return self
}

/** The app, a provider page inside it, and the player the provider nests. */
function world(appOrigin = APP): { app: Frame; provider: Frame; player: Frame; heard: unknown[] } {
  const app = frame(appOrigin)
  const provider = frame('https://vidrock.net', app)
  const player = frame('https://s.vdrk.site', provider)
  const heard: unknown[] = []
  app.win.addEventListener('message', (event) => {
    if (event.source === provider.win) heard.push(event.data)
  })
  return { app, provider, player, heard }
}

describe('commands from the app', () => {
  it('pause reaches a video nested two frames down', () => {
    const { app, provider, player } = world()
    const film = new FakeVideo()
    film.paused = false
    player.videos.push(film)

    as(app.win, () => provider.win.postMessage(relayCommand(true)))
    expect(film.paused).toBe(true)
  })

  it("play resumes the film and not an advert's clip beside it", () => {
    const { app, provider, player } = world()
    const film = new FakeVideo(3_600, { width: 1280, height: 720 })
    const advert = new FakeVideo(15, { width: 300, height: 170 })
    player.videos.push(advert, film)

    as(app.win, () => provider.win.postMessage(relayCommand(false)))
    expect(film.paused).toBe(false)
    expect(advert.paused).toBe(true)
  })

  it('pauses every video, adverts included', () => {
    const { app, provider, player } = world()
    const film = new FakeVideo()
    const advert = new FakeVideo(15)
    film.paused = advert.paused = false
    player.videos.push(film, advert)

    as(app.win, () => provider.win.postMessage(relayCommand(true)))
    expect([film.paused, advert.paused]).toEqual([true, true])
  })
})

describe('who is obeyed', () => {
  it('ignores a command from anything but the frame parent', () => {
    const { player } = world()
    const film = new FakeVideo()
    film.paused = false
    player.videos.push(film)
    const stranger = new FakeWindow('https://ads.example')

    as(stranger, () => player.win.postMessage(relayCommand(true)))
    expect(film.paused).toBe(false)
  })

  it('ignores a top-level parent that is not the app', () => {
    const { app, provider, player } = world('https://evil.example')
    const film = new FakeVideo()
    film.paused = false
    player.videos.push(film)

    as(app.win, () => provider.win.postMessage(relayCommand(true)))
    expect(film.paused).toBe(false)
  })

  it('does nothing in the app document itself', () => {
    const { app } = world()
    // The app's own copy of the script returned before listening; only the
    // test's listener is there.
    expect(app.win.listeners).toHaveLength(1)
  })
})

describe('state going up', () => {
  it('reports the video starting and stopping to the app, through every frame', () => {
    const { player, heard } = world()
    const film = new FakeVideo()
    player.videos.push(film)

    player.fire('playing', film)
    player.fire('pause', film)
    expect(heard.map(parseRelayState).filter((state) => state !== null)).toEqual([true, false])
  })

  it('ignores media that is not video', () => {
    const { player, heard } = world()
    player.fire('playing', { tagName: 'AUDIO' })
    expect(heard).toEqual([])
  })
})

describe('parseRelayState', () => {
  it("reads the relay's own reports and nothing else", () => {
    expect(parseRelayState({ wtaMedia: 1, state: 'playing' })).toBe(true)
    expect(parseRelayState({ wtaMedia: 1, state: 'paused' })).toBe(false)
    expect(parseRelayState({ wtaMedia: 1, command: 'pause' })).toBeNull()
    expect(parseRelayState({ event: 'timeupdate', time: 12 })).toBeNull()
    expect(parseRelayState('{"wtaMedia":1,"state":"playing"}')).toBeNull()
    expect(parseRelayState(null)).toBeNull()
  })
})

describe('time going up', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("reports the film's time to the app, at most every two seconds", () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const { player, heard } = world()
    const film = new FakeVideo(2_700)
    film.paused = false
    player.videos.push(film)

    film.currentTime = 600
    player.fire('timeupdate', film)
    film.currentTime = 600.25
    player.fire('timeupdate', film)
    vi.advanceTimersByTime(2_000)
    film.currentTime = 602
    player.fire('timeupdate', film)

    expect(heard.map(parseRelayTime)).toEqual([
      { seconds: 600, duration: 2_700, ended: false, playing: true },
      { seconds: 602, duration: 2_700, ended: false, playing: true },
    ])
  })

  /** The end starts the next-episode countdown, so it cannot wait two seconds. */
  it('reports the end at once', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const { player, heard } = world()
    const film = new FakeVideo(2_700)
    player.videos.push(film)

    film.currentTime = 2_699
    player.fire('timeupdate', film)
    film.currentTime = 2_700
    film.ended = true
    player.fire('ended', film)

    expect(heard.map(parseRelayTime).at(-1)).toEqual({ seconds: 2_700, duration: 2_700, ended: true, playing: false })
  })

  it("sends the pause's exact place before the pause itself", () => {
    const { player, heard } = world()
    const film = new FakeVideo(2_700)
    player.videos.push(film)
    film.currentTime = 1_234

    player.fire('pause', film)
    expect(parseRelayTime(heard[0])?.seconds).toBe(1_234)
    expect(parseRelayState(heard[1])).toBe(false)
  })

  it("ignores an advert's clip beside the film", () => {
    const { player, heard } = world()
    const film = new FakeVideo(2_700, { width: 1280, height: 720 })
    const advert = new FakeVideo(30, { width: 300, height: 250 })
    player.videos.push(advert, film)

    advert.currentTime = 29
    player.fire('timeupdate', advert)
    expect(heard).toEqual([])
  })
})

describe('parseRelayTime', () => {
  it("reads the relay's own time reports and nothing else", () => {
    expect(parseRelayTime({ wtaMedia: 1, time: { seconds: 5, duration: 60, ended: false, playing: true } })).toEqual({
      seconds: 5,
      duration: 60,
      ended: false,
      playing: true,
    })
    expect(parseRelayTime({ wtaMedia: 1, state: 'playing' })).toBeNull()
    expect(parseRelayTime({ wtaMedia: 1, time: { seconds: 5, duration: Infinity } })).toBeNull()
    expect(parseRelayTime({ wtaMedia: 1, time: { seconds: -1, duration: 60 } })).toBeNull()
    expect(parseRelayTime({ time: { seconds: 5, duration: 60 } })).toBeNull()
  })
})
