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
  parseHello,
  parseTracks,
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

class FakeVideo {
  paused = true
  currentTime = 0
  ended = false
  volume = 1
  muted = false
  playbackRate = 1
  buffered = { length: 0, start: () => 0, end: () => 0 }
  textTracks = new FakeTrackList()
  constructor(
    public duration = 2_885,
    private readonly size = { width: 1280, height: 720 },
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
  styles: Map<string, { id: string; textContent: string; remove(): void }>
  fire(type: string, target: unknown): void
}

function frame(origin: string, parent?: Frame, created?: (made: Frame) => void): Frame {
  const win = new FakeWindow(origin, parent?.win)
  const capture: Record<string, Array<(event: { target: unknown }) => void>> = {}
  const styles: Frame['styles'] = new Map()
  const self: Frame = {
    win,
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
          ? self.children.map((child) => ({ contentWindow: child.win }))
          : [],
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
