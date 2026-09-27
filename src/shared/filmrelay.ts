/**
 * The film relay: how our own player controls reach the source's `<video>`.
 *
 * v2's controls (`PlayerOverlay.svelte`) are drawn in our `/__player` shell,
 * and the film plays one to three cross-origin frames below it. Nothing in
 * the shell can touch those frames' DOM. What does cross is `postMessage`. So
 * a small script sits in every provider frame. It acts on its own videos,
 * passes commands down to its child frames, and passes its children's reports
 * up to its parent. That reaches a film nested at any depth without knowing
 * the nesting.
 *
 * This is the phone's `mobile/src/bridge/mediarelay.ts` protocol, extended.
 * Its messages (`state`, `time`, `play`, `pause` and the guarded `seek`) are
 * unchanged here, so the phone can move to this script in the v2 port without
 * its parsers changing. On the phone, native code installs it into every
 * frame; on the desktop, main does it with `executeJavaScript`
 * (`playerview.ts`).
 *
 * ## Who may command it
 *
 * Only a frame's own parent may, and the outermost provider frame accepts
 * commands only from a parent at the shell's origin. `event.source` is a
 * window object the browser supplies, and a page cannot forge it.
 *
 * ## Which video is the film
 *
 * In each frame, the largest video with a real duration. A frame whose largest
 * video is an advert would also answer to that. So every command that moves
 * a video carries the duration the overlay last saw reported, and only an
 * element of about that length acts on it (`AIM_TOLERANCE`). The overlay picks
 * the film among the reporting frames by length (`chooseFilm`).
 */

/**
 * How near a video's length must be to the one a command was aimed at.
 *
 * Relative, not exact: a stream's reported length settles while it loads.
 * VidRock's episode read 2892.8 s and then 2885.8 s, and a toggle aimed at
 * the first was refused by an exact match, so the first press of Play did
 * nothing. All the match has to do is tell a film from an advert, and
 * against a 30 s advert, 2% of a 48-minute episode is still a very wide gap.
 */
export function withinAim(duration: number, aimed: number): boolean {
  return Math.abs(duration - aimed) <= Math.max(5, aimed * 0.02)
}

/** Marks the relay's messages among everything else providers post. */
export const TAG = 'wtaMedia'

/**
 * A command, as the shell posts it into the provider iframe.
 *
 * Each carries a `seq`, unique per shell, and a relay acts on a given `seq`
 * once. Sources forward messages themselves: VidSrc's outer and inner pages
 * each pass on whatever reaches them to their child frame. So a command
 * arrived twice at the second level and four times at the third, and one
 * press of → moved VidSrc 40 s instead of 10 (measured 2026-09-27). Commands
 * without a `seq`, which are the phone's, are taken as they come.
 */
export type FilmCommand =
  | { command: 'watch' }
  | { command: 'play' }
  | { command: 'pause' }
  | { command: 'toggle'; duration: number }
  /** Play or pause the film itself, aimed; see `FilmLink.setPaused` for why not a toggle. */
  | { command: 'setPaused'; paused: boolean; duration: number }
  | { command: 'seek'; seconds: number; duration: number }
  | { command: 'seekBy'; delta: number; duration: number }
  | { command: 'volume'; level: number; duration: number }
  | { command: 'mute'; muted: boolean; duration: number }
  | { command: 'hide' }
  | { command: 'unhide' }
  | { command: 'track'; index: number; duration: number }

export function filmCommand(command: FilmCommand, seq?: string): Record<string, unknown> {
  return seq === undefined ? { [TAG]: 1, ...command } : { [TAG]: 1, ...command, seq }
}

/** One frame's film, as its relay last read it. */
export interface FilmState {
  /** Which relay (so which frame) sent it. */
  id: string
  seconds: number
  duration: number
  paused: boolean
  ended: boolean
  /** 0..1 */
  volume: number
  muted: boolean
  rate: number
  /** How far ahead of the play head the stream is loaded, in seconds of the film. */
  buffered: number
  /** Stalled, waiting for data. */
  waiting: boolean
}

export interface FilmTrack {
  index: number
  label: string
  language: string
}

const finite = (value: unknown): number | null => {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function tagged(data: unknown): Record<string, unknown> | null {
  if (typeof data !== 'object' || data === null) return null
  const message = data as Record<string, unknown>
  return message[TAG] === 1 ? message : null
}

/** A relay announcing itself: a new frame has one, so re-send what should hold there. */
export function parseHello(data: unknown): string | null {
  const message = tagged(data)
  return message && typeof message.hello === 'string' ? message.hello : null
}

export function parseFilmState(data: unknown): FilmState | null {
  const message = tagged(data)
  const film = message?.film
  if (typeof film !== 'object' || film === null) return null
  const f = film as Record<string, unknown>
  const seconds = finite(f.seconds)
  const duration = finite(f.duration)
  if (typeof f.id !== 'string' || seconds === null || duration === null || duration <= 0 || seconds < 0) return null
  return {
    id: f.id,
    seconds,
    duration,
    paused: f.paused === true,
    ended: f.ended === true,
    volume: Math.min(1, Math.max(0, finite(f.volume) ?? 1)),
    muted: f.muted === true,
    rate: finite(f.rate) ?? 1,
    buffered: Math.max(0, finite(f.buffered) ?? 0),
    waiting: f.waiting === true,
  }
}

export function parseTracks(data: unknown): { id: string; tracks: FilmTrack[] } | null {
  const message = tagged(data)
  if (!message || typeof message.id !== 'string' || !Array.isArray(message.tracks)) return null
  const tracks: FilmTrack[] = []
  for (const raw of message.tracks as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue
    const t = raw as Record<string, unknown>
    const index = finite(t.index)
    if (index === null) continue
    tracks.push({ index, label: String(t.label ?? ''), language: String(t.language ?? '') })
  }
  return { id: message.id, tracks }
}

/** The subtitle lines showing now, as plain text: cue markup such as `<i>` is removed. */
export function parseCues(data: unknown): { id: string; lines: string[] } | null {
  const message = tagged(data)
  if (!message || typeof message.id !== 'string' || !Array.isArray(message.cues)) return null
  const lines = (message.cues as unknown[])
    .map((cue) => String(cue).replace(/<[^>]*>/g, '').trim())
    .filter((line) => line.length > 0)
  return { id: message.id, lines }
}

/**
 * Which reporting frame holds the film: the longest one that is at least two
 * minutes long. An advert rarely runs past one minute, and a film always runs
 * past two. Null while nothing qualifies, as during a pre-roll.
 */
export function chooseFilm(states: Iterable<FilmState>): FilmState | null {
  let best: FilmState | null = null
  for (const state of states) {
    if (state.duration < 120) continue
    if (best === null || state.duration > best.duration) best = state
  }
  return best
}

/**
 * The style that hides a source's own interface in one frame: everything but
 * video and frames. Frames are exempt because hiding one hides the film inside
 * it: the study measured a black picture with the video still running. The
 * native control bar goes too, for players that use it.
 */
export const HIDE_CSS =
  'body *:not(video):not(iframe){visibility:hidden!important}' +
  'video,iframe{visibility:visible!important}' +
  'video::-webkit-media-controls,video::-webkit-media-controls-enclosure{display:none!important}'

/**
 * The script for every provider frame, as source text.
 *
 * `appOrigin` is the shell's origin, which the outermost frame requires of
 * whoever commands it. Idempotent: installing it twice in one document does
 * nothing the second time, so main can install on every load event without
 * keeping track.
 */
export function filmRelayScript(appOrigin: string): string {
  return `(() => {
  if (window.top === window) return
  if (window.__wtaFilmRelay) return
  window.__wtaFilmRelay = true

  const TAG = ${JSON.stringify(TAG)}
  const APP = ${JSON.stringify(appOrigin)}
  const ID = Math.random().toString(36).slice(2, 10)
  const HIDE_ID = 'wta-hide-source-ui'
  const HIDE_CSS = ${JSON.stringify(HIDE_CSS)}

  const send = (message) => {
    try { window.parent.postMessage(message, '*') } catch (error) {}
  }
  const children = () => Array.from(document.querySelectorAll('iframe'))
  const down = (data) => {
    for (const child of children()) {
      try { child.contentWindow.postMessage(data, '*') } catch (error) {}
    }
  }
  const fromParent = (event) =>
    event.source === window.parent && (window.parent !== window.top || event.origin === APP)
  const fromChild = (event) => children().some((child) => child.contentWindow === event.source)

  const film = () => {
    let best = null
    let bestArea = 0
    for (const video of document.querySelectorAll('video')) {
      const duration = Number(video.duration)
      if (!Number.isFinite(duration) || duration <= 0) continue
      const rect = video.getBoundingClientRect()
      const area = rect.width * rect.height
      if (area > bestArea) {
        best = video
        bestArea = area
      }
    }
    return best
  }
  // The film, but only if it is about the length the command was aimed at.
  // withinAim's own source, so the rule has one definition: the one above,
  // which is tested. It uses nothing but Math, so it runs anywhere as it is.
  const withinAim = ${withinAim.toString()}
  const aimed = (data) => {
    const video = film()
    return video && withinAim(Number(video.duration), Number(data.duration)) ? video : null
  }

  // ── What this frame reports ────────────────────────────────────────────
  let watching = false
  let reportedAt = 0
  let timeAt = 0
  const waiting = new WeakSet()
  const bufferedAhead = (video) => {
    const ranges = video.buffered
    const now = Number(video.currentTime)
    for (let i = 0; ranges && i < ranges.length; i++) {
      if (ranges.start(i) <= now + 0.5 && ranges.end(i) >= now) return ranges.end(i)
    }
    return now
  }
  const report = (video, force) => {
    if (!watching || video !== film()) return
    const now = Date.now()
    if (!force && now - reportedAt < 250) return
    reportedAt = now
    send({ [TAG]: 1, film: {
      id: ID,
      seconds: Number(video.currentTime),
      duration: Number(video.duration),
      paused: !!video.paused,
      ended: !!video.ended,
      volume: Number(video.volume),
      muted: !!video.muted,
      rate: Number(video.playbackRate),
      buffered: bufferedAhead(video),
      waiting: waiting.has(video),
    } })
  }
  // The phone's two-second time report, unchanged (mediarelay v1).
  const reportTime = (video, force) => {
    if (video !== film()) return
    const now = Date.now()
    if (!force && now - timeAt < 2000) return
    timeAt = now
    send({ [TAG]: 1, time: {
      seconds: Number(video.currentTime),
      duration: Number(video.duration),
      ended: !!video.ended,
      playing: !video.paused && !video.ended,
    } })
  }

  const trackList = (video) => {
    const tracks = []
    const list = video.textTracks || []
    for (let i = 0; i < list.length; i++) {
      const track = list[i]
      if (track.kind === 'subtitles' || track.kind === 'captions') {
        tracks.push({ index: i, label: track.label || '', language: track.language || '' })
      }
    }
    return tracks
  }
  const reportTracks = () => {
    const video = film()
    if (watching && video) send({ [TAG]: 1, id: ID, tracks: trackList(video) })
  }
  let cueTrack = null
  const onCues = () => {
    const cues = []
    const active = cueTrack && cueTrack.activeCues
    for (let i = 0; active && i < active.length; i++) cues.push(String(active[i].text || ''))
    send({ [TAG]: 1, id: ID, cues })
  }
  // Ours draws the chosen track, so the browser draws none: every track is
  // 'hidden' (cues still fire) or 'disabled'.
  const chooseTrack = (video, index) => {
    const list = video.textTracks || []
    if (cueTrack) cueTrack.removeEventListener('cuechange', onCues)
    cueTrack = null
    for (let i = 0; i < list.length; i++) {
      list[i].mode = i === index ? 'hidden' : 'disabled'
      if (i === index) cueTrack = list[i]
    }
    if (cueTrack) {
      cueTrack.addEventListener('cuechange', onCues)
      onCues()
    } else {
      send({ [TAG]: 1, id: ID, cues: [] })
    }
  }

  // ── Commands, from the parent only ─────────────────────────────────────
  const COMMANDS = ['watch', 'play', 'pause', 'toggle', 'setPaused', 'seek', 'seekBy', 'volume', 'mute', 'hide', 'unhide', 'track']

  // The commands already acted on, by seq; see FilmCommand. A few hundred is
  // minutes of them, and the oldest go first.
  const seen = new Set()
  const firstTime = (seq) => {
    if (typeof seq !== 'string') return true
    if (seen.has(seq)) return false
    seen.add(seq)
    if (seen.size > 400) seen.delete(seen.values().next().value)
    return true
  }

  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || typeof data !== 'object' || data[TAG] !== 1) return

    if (COMMANDS.includes(data.command)) {
      if (!fromParent(event) || !firstTime(data.seq)) return
      const video = film()
      switch (data.command) {
        case 'watch':
          watching = true
          if (video) {
            report(video, true)
            reportTracks()
          }
          break
        case 'pause':
          for (const each of document.querySelectorAll('video')) each.pause()
          break
        case 'play':
          if (video) video.play().catch(() => {})
          break
        case 'toggle': {
          const target = aimed(data)
          if (target) target.paused ? target.play().catch(() => {}) : target.pause()
          break
        }
        case 'setPaused': {
          const target = aimed(data)
          if (target && data.paused === true) target.pause()
          else if (target && target.paused) target.play().catch(() => {})
          break
        }
        case 'seek': {
          const target = aimed(data)
          const seconds = Number(data.seconds)
          if (target && Number.isFinite(seconds) && seconds >= 0) {
            try { target.currentTime = seconds } catch (error) {}
          }
          break
        }
        case 'seekBy': {
          const target = aimed(data)
          const delta = Number(data.delta)
          if (target && Number.isFinite(delta)) {
            const to = Math.min(Math.max(0, Number(target.currentTime) + delta), Number(target.duration) - 0.5)
            try { target.currentTime = to } catch (error) {}
          }
          break
        }
        case 'volume': {
          const target = aimed(data)
          const level = Number(data.level)
          if (target && Number.isFinite(level)) {
            target.volume = Math.min(1, Math.max(0, level))
            if (level > 0) target.muted = false
          }
          break
        }
        case 'mute': {
          const target = aimed(data)
          if (target) target.muted = data.muted === true
          break
        }
        case 'hide':
          if (!document.getElementById(HIDE_ID)) {
            const style = document.createElement('style')
            style.id = HIDE_ID
            style.textContent = HIDE_CSS
            ;(document.head || document.documentElement).appendChild(style)
          }
          break
        case 'unhide':
          document.getElementById(HIDE_ID)?.remove()
          break
        case 'track': {
          const target = aimed(data)
          if (target) chooseTrack(target, Number(data.index))
          break
        }
      }
      down(data)
      return
    }

    // Everything else tagged is a report, and climbs only from a child.
    if (fromChild(event)) send(data)
  })

  // ── The film's events ──────────────────────────────────────────────────
  // Media events do not bubble; the capture phase still sees them.
  const on = (type, handler) =>
    document.addEventListener(type, (event) => {
      if (event.target instanceof HTMLVideoElement) handler(event.target)
    }, true)

  on('timeupdate', (video) => {
    waiting.delete(video)
    report(video, false)
    reportTime(video, false)
  })
  on('waiting', (video) => {
    waiting.add(video)
    report(video, true)
  })
  on('playing', (video) => {
    waiting.delete(video)
    report(video, true)
    // Again here as well as on metadata: some players add their subtitle
    // tracks after the metadata has loaded.
    reportTracks()
    send({ [TAG]: 1, state: 'playing' })
  })
  on('pause', (video) => {
    // The exact place first: the phone saves the moment it hears "paused".
    reportTime(video, true)
    report(video, true)
    send({ [TAG]: 1, state: 'paused' })
  })
  on('ended', (video) => {
    reportTime(video, true)
    report(video, true)
  })
  for (const type of ['play', 'seeking', 'seeked', 'volumechange', 'ratechange', 'durationchange']) {
    on(type, (video) => report(video, true))
  }
  on('loadedmetadata', () => reportTracks())

  send({ [TAG]: 1, hello: ID })
})()`
}
