/**
 * The overlay's end of the film relay (`@shared/filmrelay`).
 *
 * Holds what the provider's frames have reported, decides which of them is the
 * film, and turns the overlay's intentions into relay commands aimed at it.
 * Plain TypeScript with the posting and the clock passed in, so the rules can
 * be tested without a frame (`filmlink.test.ts`). The component copies
 * `view()` into its own state after each change.
 */

import {
  chooseFilm,
  filmCommand,
  parseCues,
  parseFilmState,
  parseHello,
  parseQuality,
  parseTracks,
  type FilmCommand,
  type FilmQuality,
  type FilmState,
  type FilmTrack,
} from '@shared/filmrelay'

/**
 * How long one frame's report counts as current. The overlay asks for a
 * report every two seconds (`watch`), so a frame silent for longer than this
 * has gone: its document was replaced, or its video removed.
 */
export const STALE_MS = 6_000

/**
 * How long a play or pause the viewer asked for is held against the source.
 *
 * Sources do not always let the first `play()` stand. VidRock attaches its
 * real stream on the first play, and that load aborts the play that started
 * it (`AbortError: interrupted by a new load request`). Measured under test:
 * sometimes VidRock plays again by itself, sometimes it sits paused. So the
 * viewer's intent is kept for a few seconds, and every report that
 * contradicts it gets the request again (`INTENT_RETRY_MS` apart).
 */
export const INTENT_MS = 8_000
export const INTENT_RETRY_MS = 900

export interface FilmView {
  film: FilmState | null
  /** When the film's report arrived, by the clock the link was given. */
  at: number
  tracks: FilmTrack[]
  cues: string[]
  /** When any film report last arrived; 0 before the first. */
  lastReportAt: number
  /** Paused or playing, as the viewer last asked, while that is being held; see `wanted`. */
  wanted: boolean | null
  /** The film's qualities, once asked for (`askQuality`); null before. */
  quality: FilmQuality | null
}

export class FilmLink {
  private readonly states = new Map<string, { state: FilmState; at: number }>()
  private readonly tracks = new Map<string, FilmTrack[]>()
  private readonly cues = new Map<string, string[]>()
  private readonly qualities = new Map<string, FilmQuality>()
  private hidden = false
  /** The film's frame the last `hide` named, so a new one is named again. */
  private hiddenFor: string | null = null
  private track = -1
  private lastReportAt = 0
  private intent: { paused: boolean; until: number; sentAt: number } | null = null
  /** Numbers each command, so a relay acts on it once; see `FilmCommand`. */
  private readonly nonce = Math.random().toString(36).slice(2, 8)
  private seq = 0

  constructor(
    private readonly post: (message: Record<string, unknown>) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** A message from the provider frame. True when the view changed. */
  receive(data: unknown): boolean {
    if (parseHello(data) !== null) {
      // A relay came up in some frame, possibly a new one. Whatever should hold
      // in every frame is sent again: the commands travel down from the top,
      // so the new frame gets them too, and the others ignore the repeats.
      this.restate()
      return false
    }
    const state = parseFilmState(data)
    if (state !== null) {
      const at = this.now()
      this.states.set(state.id, { state, at })
      this.lastReportAt = at
      this.holdIntent()
      // The film moved to another frame, or its frame got a new document:
      // the way to it has to be marked afresh.
      if (this.hidden && this.view().film?.id !== this.hiddenFor) this.sendHide()
      return true
    }
    const tracks = parseTracks(data)
    if (tracks !== null) {
      this.tracks.set(tracks.id, tracks.tracks)
      return true
    }
    const cues = parseCues(data)
    if (cues !== null) {
      this.cues.set(cues.id, cues.lines)
      return true
    }
    const quality = parseQuality(data)
    if (quality !== null) {
      this.qualities.set(quality.id, quality.quality)
      return true
    }
    return false
  }

  view(): FilmView {
    const now = this.now()
    const fresh = [...this.states.values()].filter((entry) => now - entry.at < STALE_MS)
    const film = chooseFilm(fresh.map((entry) => entry.state))
    return {
      film,
      at: film === null ? 0 : (this.states.get(film.id)?.at ?? 0),
      tracks: film === null ? [] : (this.tracks.get(film.id) ?? []),
      cues: film === null ? [] : (this.cues.get(film.id) ?? []),
      lastReportAt: this.lastReportAt,
      wanted: this.wanted(),
      quality: film === null ? null : (this.qualities.get(film.id) ?? null),
    }
  }

  /** Ask every frame for a report now; also the heartbeat. */
  watch(): void {
    this.send({ command: 'watch' })
  }

  /**
   * Play or pause, and keep at it for `INTENT_MS` if the source undoes it.
   * An aimed `setPaused` rather than a toggle: a toggle repeated while a
   * report is in flight flips the film back the way it came.
   */
  setPaused(paused: boolean): void {
    const now = this.now()
    this.intent = { paused, until: now + INTENT_MS, sentAt: now }
    this.aimed((duration) => this.send({ command: 'setPaused', paused, duration }))
  }

  /** What the viewer last asked for, while it is still being held; null otherwise. */
  wanted(): boolean | null {
    const intent = this.intent
    return intent !== null && this.now() <= intent.until ? intent.paused : null
  }

  seekTo(seconds: number): void {
    this.aimed((duration) => this.send({ command: 'seek', seconds, duration }))
  }

  seekBy(delta: number): void {
    this.aimed((duration) => this.send({ command: 'seekBy', delta, duration }))
  }

  setVolume(level: number): void {
    this.aimed((duration) => this.send({ command: 'volume', level, duration }))
  }

  setMuted(muted: boolean): void {
    this.aimed((duration) => this.send({ command: 'mute', muted, duration }))
  }

  /** The source's own interface: hidden while our controls are in charge. */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return
    this.hidden = hidden
    if (hidden) this.sendHide()
    else {
      this.hiddenFor = null
      this.send({ command: 'unhide' })
    }
  }

  /** Hide, naming the film's frame so the relays can mark the way to it. */
  private sendHide(): void {
    const film = this.view().film
    this.hiddenFor = film?.id ?? null
    this.send(film === null ? { command: 'hide' } : { command: 'hide', film: film.id })
  }

  /** Ask the film's frame what qualities its engine has. */
  askQuality(): void {
    this.aimed((duration) => this.send({ command: 'levels', duration }))
  }

  /** A quality by its index in the engine's levels, or -1 for automatic. */
  setLevel(index: number): void {
    this.aimed((duration) => this.send({ command: 'level', index, duration }))
  }

  /** A subtitle track by its index in the film's `textTracks`, or -1 for none. */
  chooseTrack(index: number): void {
    this.track = index
    this.aimed((duration) => this.send({ command: 'track', index, duration }))
  }

  private holdIntent(): void {
    const intent = this.intent
    if (intent === null) return
    const now = this.now()
    if (now > intent.until) {
      this.intent = null
      return
    }
    const film = this.view().film
    if (film === null || film.paused === intent.paused || now - intent.sentAt < INTENT_RETRY_MS) return
    intent.sentAt = now
    this.send({ command: 'setPaused', paused: intent.paused, duration: film.duration })
  }

  private restate(): void {
    this.watch()
    if (this.hidden) this.sendHide()
    if (this.track >= 0) this.chooseTrack(this.track)
  }

  /** Commands that move a video carry its length, so only the film acts. */
  private aimed(act: (duration: number) => void): void {
    const film = this.view().film
    if (film !== null) act(film.duration)
  }

  private send(command: FilmCommand): void {
    this.post(filmCommand(command, `${this.nonce}-${++this.seq}`))
  }
}
