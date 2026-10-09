/**
 * The film relay runs inside provider frames that the gates never see. What
 * can be checked here is its logic, against a small fake of nested windows:
 * commands reach a film nested two frames down, only the right sender is
 * obeyed, only the element of the reported length is moved, and reports climb
 * back to the shell. Whether it reaches real cross-origin frames is checked in
 * the running app.
 *
 * The fake delivers `postMessage` synchronously and names as the sender
 * whichever window's code is running at that moment. The relay's security
 * rests on exactly that property: `event.source` is supplied by the browser.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HIDE_CSS,
  chooseFilm,
  filmCommand,
  filmRelayScript,
  parseCues,
  parseFilmState,
  offeredQuality,
  parseHello,
  parseQuality,
  parseTracks,
  type FilmQuality,
  type FilmState,
} from './filmrelay'

const SHELL = 'http://127.0.0.1:40123'

class FakeTrackList extends Array<FakeTrack> {}

class FakeTrack {
  mode = 'disabled'
  activeCues: Array<{ text: string }> = []
  private listeners: Array<() => void> = []
  constructor(
    public kind: string,
    public label: string,
    public language: string,
  ) {}
  addEventListener(_type: string, listener: () => void): void {
    this.listeners.push(listener)
  }
  removeEventListener(_type: string, listener: () => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener)
  }
  cue(...texts: string[]): void {
    this.activeCues = texts.map((text) => ({ text }))
    this.listeners.forEach((listener) => listener())
  }
}

/** What the relay reads and writes of an element's attributes. */
class Marked {
  readonly attributes = new Set<string>()
  setAttribute(name: string): void {
    this.attributes.add(name)
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }
}

class FakeVideo extends Marked {
  paused = true
  currentTime = 0
  ended = false
  volume = 1
  muted = false
  playbackRate = 1
  buffered = { length: 0, start: () => 0, end: () => 0 }
  textTracks = new FakeTrackList()
  videoWidth = 1280
  videoHeight = 720
  constructor(
    public duration = 2_885,
    private readonly size = { width: 1280, height: 720 },
  ) {
    super()
  }
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
  private readonly listeners = new Map<string, Set<() => void>>()
  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }
  /** An event on the element itself, as a stream loading into it fires. */
  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener()
  }
}

type Message = { data: unknown; source: FakeWindow; origin: string }

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
  /** This frame's own `<iframe>` element, in its parent's document. */
  element: Marked & { contentWindow: FakeWindow }
  videos: FakeVideo[]
  children: Frame[]
  styles: Map<string, { id: string; textContent: string; remove(): void }>
  fire(type: string, target: unknown): void
}

function frame(origin: string, parent?: Frame, created?: (made: Frame) => void): Frame {
  const win = new FakeWindow(origin, parent?.win)
  const capture: Record<string, Array<(event: { target: unknown }) => void>> = {}
  const styles: Frame['styles'] = new Map()
  const self: Frame = {
    win,
    element: Object.assign(new Marked(), { contentWindow: win }),
    videos: [],
    children: [],
    styles,
    fire: (type, target) => as(win, () => capture[type]?.forEach((listener) => listener({ target }))),
  }
  const document = {
    querySelectorAll: (selector: string) =>
      selector === 'video'
        ? self.videos
        : selector === 'iframe'
          ? self.children.map((child) => child.element)
          : [],
    querySelector: (selector: string) =>
      selector === '[data-wta-film]'
        ? ([...self.videos, ...self.children.map((child) => child.element)].find((e) => e.hasAttribute('data-wta-film')) ??
          null)
        : null,
    addEventListener: (type: string, listener: (event: { target: unknown }) => void) =>
      (capture[type] ??= []).push(listener),
    getElementById: (id: string) => styles.get(id) ?? null,
    createElement: () => {
      const style = { id: '', textContent: '', remove: () => styles.delete(style.id) }
      return style
    },
    head: { appendChild: (style: { id: string; textContent: string; remove(): void }) => styles.set(style.id, style) },
  }
  parent?.children.push(self)
  created?.(self)
  as(win, () =>
    new Function('window', 'document', 'HTMLVideoElement', filmRelayScript(SHELL))(win, document, FakeVideo),
  )
  return self
}

/** The shell, the provider page inside it, and the player the provider nests. */
function world(shellOrigin = SHELL): { shell: Frame; provider: Frame; player: Frame; heard: unknown[] } {
  const shell = frame(shellOrigin)
  const heard: unknown[] = []
  // Listening before the frames exist: each relay says hello as it installs.
  const holder: { provider: Frame | null } = { provider: null }
  shell.win.addEventListener('message', (event) => {
    if (holder.provider !== null && event.source === holder.provider.win) heard.push(event.data)
  })
  // The frame object exists before its script runs, as a real iframe does.
  const provider = frame('https://vidsrcme.ru', shell, (made) => (holder.provider = made))
  const player = frame('https://cloudorchestranova.com', provider)
  return { shell, provider, player, heard }
}

const command = (w: ReturnType<typeof world>, data: Parameters<typeof filmCommand>[0]): void =>
  as(w.shell.win, () => w.provider.win.postMessage(filmCommand(data)))

afterEach(() => {
  vi.useRealTimers()
})

describe('commands down the frames', () => {
  it('toggles, seeks and sets the volume of a film two frames down', () => {
    const w = world()
    const film = new FakeVideo(2_885)
    w.player.videos.push(film)

    command(w, { command: 'toggle', duration: 2_885 })
    expect(film.paused).toBe(false)
    command(w, { command: 'seek', seconds: 600, duration: 2_885 })
    expect(film.currentTime).toBe(600)
    command(w, { command: 'seekBy', delta: -10, duration: 2_885 })
    expect(film.currentTime).toBe(590)
    command(w, { command: 'volume', level: 0.4, duration: 2_885 })
    expect(film.volume).toBe(0.4)
    command(w, { command: 'mute', muted: true, duration: 2_885 })
    expect(film.muted).toBe(true)
  })

  it('plays or pauses the film on an aimed request, whatever state it is in', () => {
    const w = world()
    const film = new FakeVideo(2_885)
    w.player.videos.push(film)
    command(w, { command: 'setPaused', paused: false, duration: 2_885 })
    command(w, { command: 'setPaused', paused: false, duration: 2_885 })
    expect(film.paused).toBe(false)
    command(w, { command: 'setPaused', paused: true, duration: 2_885 })
    expect(film.paused).toBe(true)
  })

  /** A stream's length settles while it loads; the command must still land. */
  it('still reaches the film when its length has moved a few seconds since the report', () => {
    const w = world()
    const film = new FakeVideo(2_885.758)
    w.player.videos.push(film)
    command(w, { command: 'toggle', duration: 2_892.848 })
    expect(film.paused).toBe(false)
  })

  it('never seeks past the start or into the last half second', () => {
    const w = world()
    const film = new FakeVideo(2_885)
    w.player.videos.push(film)
    film.currentTime = 4
    command(w, { command: 'seekBy', delta: -10, duration: 2_885 })
    expect(film.currentTime).toBe(0)
    film.currentTime = 2_880
    command(w, { command: 'seekBy', delta: 10, duration: 2_885 })
    expect(film.currentTime).toBe(2_884.5)
  })

  /**
   * VidSrc's pages forward every message to their child frame themselves, so
   * each level gets our copy and the page's. A command with a seq is acted on
   * once, however many copies arrive.
   */
  it('acts on each numbered command once, however many copies the pages forward', () => {
    const w = world()
    const film = new FakeVideo(2_885)
    film.currentTime = 600
    w.player.videos.push(film)
    const once = filmCommand({ command: 'seekBy', delta: 10, duration: 2_885 }, 'shell-1')
    as(w.shell.win, () => w.provider.win.postMessage(once))
    // The provider's own page passing the same message on again.
    as(w.provider.win, () => w.player.win.postMessage(once))
    expect(film.currentTime).toBe(610)
    as(w.shell.win, () => w.provider.win.postMessage(filmCommand({ command: 'seekBy', delta: 10, duration: 2_885 }, 'shell-2')))
    expect(film.currentTime).toBe(620)
  })

  /** A frame whose largest video is an advert must not have it moved. */
  it('moves only the element of the length the command was aimed at', () => {
    const w = world()
    const advert = new FakeVideo(30)
    const film = new FakeVideo(2_885)
    w.provider.videos.push(advert)
    w.player.videos.push(film)

    command(w, { command: 'seek', seconds: 600, duration: 2_885 })
    command(w, { command: 'volume', level: 0.2, duration: 2_885 })
    expect([advert.currentTime, advert.volume]).toEqual([0, 1])
    expect([film.currentTime, film.volume]).toEqual([600, 0.2])
  })

  it('marks the way to the film and hides every other frame and video', () => {
    const w = world()
    const film = new FakeVideo(2_885)
    const advert = frame('https://ads.example', w.provider)
    w.player.videos.push(film)
    // The film's frame is known by the id in its reports.
    command(w, { command: 'watch' })
    const id = (w.heard.map(parseFilmState).find(Boolean) as FilmState).id
    command(w, { command: 'hide', film: id })

    expect(film.hasAttribute('data-wta-film')).toBe(true)
    expect(w.player.element.hasAttribute('data-wta-film')).toBe(true)
    expect(advert.element.hasAttribute('data-wta-film')).toBe(false)
    expect(w.provider.styles.has('wta-hide-strict')).toBe(true)
    expect(w.player.styles.has('wta-hide-strict')).toBe(true)
    // The advert's own frame never learns a way to the film: its parent hides it.
    expect(advert.styles.has('wta-hide-strict')).toBe(false)
  })

  it('hides the source interface in every frame, and shows it again', () => {
    const w = world()
    command(w, { command: 'hide' })
    expect(w.provider.styles.get('wta-hide-source-ui')?.textContent).toBe(HIDE_CSS)
    expect(w.player.styles.has('wta-hide-source-ui')).toBe(true)
    command(w, { command: 'unhide' })
    expect(w.provider.styles.size + w.player.styles.size).toBe(0)
  })
})

describe('who is obeyed', () => {
  it('ignores a command from anything but the frame parent', () => {
    const w = world()
    const film = new FakeVideo()
    w.player.videos.push(film)
    const stranger = new FakeWindow('https://ads.example')
    as(stranger, () => w.player.win.postMessage(filmCommand({ command: 'toggle', duration: 2_885 })))
    expect(film.paused).toBe(true)
  })

  it('ignores a top-level parent that is not the shell', () => {
    const w = world('https://evil.example')
    const film = new FakeVideo()
    w.player.videos.push(film)
    command(w, { command: 'toggle', duration: 2_885 })
    expect(film.paused).toBe(true)
  })
})

describe('reports up the frames', () => {
  it('says hello from each frame as it is installed', () => {
    const { heard } = world()
    // The provider's own, and the nested player's, relayed by the provider.
    expect(heard.map(parseHello).filter(Boolean)).toHaveLength(2)
  })

  it("reports the film's state once watched, at most four times a second", () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const w = world()
    const film = new FakeVideo(2_885)
    film.paused = false
    w.player.videos.push(film)
    w.heard.length = 0

    film.currentTime = 100
    w.player.fire('timeupdate', film)
    expect(w.heard.map(parseFilmState).filter(Boolean)).toHaveLength(0)

    command(w, { command: 'watch' })
    film.currentTime = 101
    w.player.fire('timeupdate', film)
    vi.advanceTimersByTime(300)
    film.currentTime = 101.3
    w.player.fire('timeupdate', film)

    const states = w.heard.map(parseFilmState).filter((s): s is FilmState => s !== null)
    expect(states.map((s) => s.seconds)).toEqual([100, 101.3])
    expect(states[0]).toMatchObject({ duration: 2_885, paused: false, volume: 1, muted: false })
  })

  it('reports waiting and clears it when the film moves again', () => {
    const w = world()
    const film = new FakeVideo()
    w.player.videos.push(film)
    command(w, { command: 'watch' })
    w.player.fire('waiting', film)
    w.player.fire('playing', film)
    const states = w.heard.map(parseFilmState).filter((s): s is FilmState => s !== null)
    expect(states.map((s) => s.waiting)).toEqual([false, true, false])
  })

  it("lists the film's subtitle tracks and forwards the chosen one's cues", () => {
    const w = world()
    const film = new FakeVideo()
    const english = new FakeTrack('subtitles', 'English', 'en')
    film.textTracks.push(new FakeTrack('metadata', '', ''), english)
    w.player.videos.push(film)

    command(w, { command: 'watch' })
    expect(w.heard.map(parseTracks).find(Boolean)?.tracks).toEqual([{ index: 1, label: 'English', language: 'en' }])

    command(w, { command: 'track', index: 1, duration: 2_885 })
    expect(english.mode).toBe('hidden')
    as(w.player.win, () => english.cue('<i>Say my name.</i>'))
    expect(w.heard.map(parseCues).filter(Boolean).at(-1)?.lines).toEqual(['Say my name.'])

    command(w, { command: 'track', index: -1, duration: 2_885 })
    expect(english.mode).toBe('disabled')
  })

  it('keeps the phone relay reports: state and the two-second time', () => {
    const w = world()
    const film = new FakeVideo(2_700)
    w.player.videos.push(film)
    film.currentTime = 1_234
    w.player.fire('pause', film)
    const tagged = w.heard as Array<Record<string, unknown>>
    expect(tagged.some((m) => m.state === 'paused')).toBe(true)
    expect(tagged.find((m) => m.time)?.time).toMatchObject({ seconds: 1_234, duration: 2_700 })
  })
})

/** An hls.js as far as the relay can tell: levels, the one playing, and an automatic mode. */
function engineFor(video: FakeVideo): {
  levels: Array<{ width: number; height: number; bitrate: number }>
  currentLevel: number
  autoLevelEnabled: boolean
  media: FakeVideo
} {
  return {
    levels: [
      { width: 640, height: 360, bitrate: 800_000 },
      { width: 1280, height: 720, bitrate: 2_500_000 },
    ],
    currentLevel: 1,
    autoLevelEnabled: true,
    media: video,
  }
}

describe('quality', () => {
  const qualityOf = (heard: unknown[]) => heard.map(parseQuality).filter(Boolean).at(-1)?.quality

  /** VidSrc keeps its hls.js at window.__JW.state.hls. */
  it("finds an engine in the page's globals, and switches it", () => {
    const w = world()
    const film = new FakeVideo(2_885)
    w.player.videos.push(film)
    const engine = engineFor(film)
    ;(w.player.win as unknown as Record<string, unknown>).__JW = { state: { hls: engine } }
    command(w, { command: 'watch' })
    command(w, { command: 'levels', duration: 2_885 })
    expect(qualityOf(w.heard)).toEqual({
      levels: [
        { index: 0, width: 640, height: 360, bitrate: 800_000 },
        { index: 1, width: 1280, height: 720, bitrate: 2_500_000 },
      ],
      current: 1,
      auto: true,
      canAuto: true,
      width: 1280,
      height: 720,
    })
    command(w, { command: 'level', index: 0, duration: 2_885 })
    expect(engine.currentLevel).toBe(0)
    command(w, { command: 'level', index: -1, duration: 2_885 })
    expect(engine.currentLevel).toBe(-1)
  })

  /** VidLux keeps its hls.js in React state, reached from the video element. */
  it('finds an engine in React state along the video element', () => {
    const w = world()
    const film = new FakeVideo(2_885)
    const engine = engineFor(film)
    const hook = { memoizedState: { current: engine }, next: null }
    ;(film as unknown as Record<string, unknown>)['__reactFiber$x1'] = { memoizedState: null, return: { memoizedState: hook, return: null } }
    w.player.videos.push(film)
    command(w, { command: 'watch' })
    command(w, { command: 'levels', duration: 2_885 })
    expect(qualityOf(w.heard)?.levels).toHaveLength(2)
  })

  /**
   * Videasy creates its hls.js in a component beside the video that renders
   * nothing, and keeps it in that component's useRef: not above the video.
   */
  it('finds an engine in a ref of a component beside the video', () => {
    const w = world()
    const film = new FakeVideo(2_885)
    const engine = engineFor(film)
    const root: Record<string, unknown> = { memoizedState: null, return: null }
    const playerBox: Record<string, unknown> = { memoizedState: null, return: root }
    const videoFiber: Record<string, unknown> = { memoizedState: null, return: playerBox }
    const qualityComponent = { memoizedState: { memoizedState: { current: engine }, next: null }, return: root, child: null, sibling: null }
    root.child = playerBox
    playerBox.child = videoFiber
    playerBox.sibling = qualityComponent
    ;(film as unknown as Record<string, unknown>)['__reactFiber$x1'] = videoFiber
    w.player.videos.push(film)
    command(w, { command: 'watch' })
    command(w, { command: 'levels', duration: 2_885 })
    expect(qualityOf(w.heard)?.levels).toHaveLength(2)
  })

  /**
   * Videasy's hls.js holds one rendition with no size; its qualities are whole
   * streams in React state, switched by the function its own menu calls.
   */
  it('offers a list of whole streams, switches to one, and puts the time back', () => {
    vi.useFakeTimers()
    try {
      const w = world()
      const film = new FakeVideo(3_619)
      const oneRendition = { levels: [{ height: 0 }], currentLevel: 0, autoLevelEnabled: true, media: film }
      const sources = [
        { quality: '1440p', url: 'https://cdn.example/1440.m3u8', type: 'm3u8' },
        { quality: '1080p', url: 'https://cdn.example/1080.m3u8', type: 'm3u8' },
      ]
      const chosen: unknown[] = []
      const hooks = (...states: unknown[]): Record<string, unknown> | null =>
        states.reduceRight<Record<string, unknown> | null>((next, memoizedState) => ({ memoizedState, next }), null)
      const root: Record<string, unknown> = { memoizedState: null, return: null }
      const videoFiber: Record<string, unknown> = { memoizedState: null, return: root }
      const player = {
        memoizedState: hooks({ current: oneRendition }, { sources }, { currentSource: sources[1] }),
        return: root,
        child: null,
        sibling: null as unknown,
      }
      const menu = {
        memoizedState: hooks({ handleChangeQuality: (source: unknown) => chosen.push(source) }),
        return: root,
        child: null,
        sibling: null,
      }
      root.child = videoFiber
      videoFiber.sibling = player
      player.sibling = menu
      ;(film as unknown as Record<string, unknown>)['__reactFiber$x1'] = videoFiber
      w.player.videos.push(film)
      command(w, { command: 'watch' })
      command(w, { command: 'levels', duration: 3_619 })
      expect(qualityOf(w.heard)).toMatchObject({
        levels: [
          { index: 0, height: 1440 },
          { index: 1, height: 1080 },
        ],
        current: 1,
        canAuto: false,
      })

      film.currentTime = 1_234
      command(w, { command: 'level', index: 0, duration: 3_619 })
      expect(chosen).toEqual([sources[0]])
      // The new stream starts from nothing, and the relay puts the time back.
      film.currentTime = 0
      film.emit('loadedmetadata')
      vi.advanceTimersByTime(400)
      expect(film.currentTime).toBe(1_234)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still reports the picture size when no engine can be found', () => {
    const w = world()
    const film = new FakeVideo(2_885)
    w.player.videos.push(film)
    command(w, { command: 'watch' })
    command(w, { command: 'levels', duration: 2_885 })
    expect(qualityOf(w.heard)).toEqual({ levels: [], current: -1, auto: true, canAuto: false, width: 1280, height: 720 })
  })

  it("ignores an engine attached to another video", () => {
    const w = world()
    const film = new FakeVideo(2_885)
    w.player.videos.push(film)
    ;(w.player.win as unknown as Record<string, unknown>).hls = engineFor(new FakeVideo(30))
    command(w, { command: 'watch' })
    command(w, { command: 'levels', duration: 2_885 })
    expect(qualityOf(w.heard)?.levels).toEqual([])
  })
})

describe('offeredQuality', () => {
  const report = (levels: FilmQuality['levels']): FilmQuality => ({
    levels,
    current: 0,
    auto: true,
    canAuto: true,
    width: 1280,
    height: 720,
  })

  it("is the top of the engine's ladder, named as the source lists name it", () => {
    const ladder = [
      { index: 0, width: 640, height: 360, bitrate: 800_000 },
      { index: 1, width: 1920, height: 800, bitrate: 5_000_000 },
      { index: 2, width: 1280, height: 536, bitrate: 2_500_000 },
    ]
    // Whatever rung is playing: the list is what the source offers.
    expect(offeredQuality(report(ladder))).toBe(1080)
  })

  it("is the top of a list of whole streams, which gives heights only", () => {
    // Videasy's streams, as the relay reads their labels.
    const streams = [1080, 720, 480].map((height, index) => ({ index, width: 0, height, bitrate: 0 }))
    expect(offeredQuality(report(streams))).toBe(1080)
  })

  it('is nothing when the engine lists nothing: the picture alone is only a floor', () => {
    expect(offeredQuality(report([]))).toBeNull()
  })
})

describe('chooseFilm', () => {
  const state = (id: string, duration: number): FilmState => ({
    id,
    duration,
    seconds: 0,
    paused: false,
    ended: false,
    volume: 1,
    muted: false,
    rate: 1,
    buffered: 0,
    waiting: false,
  })

  it('picks the longest, and nothing under two minutes', () => {
    expect(chooseFilm([state('ad', 30)])).toBeNull()
    expect(chooseFilm([state('ad', 30), state('film', 2_885), state('trailer', 150)])?.id).toBe('film')
  })
})
