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
  /** `film` is the relay id of the frame that holds the film; see `STRICT_CSS`. */
  | { command: 'hide'; film?: string }
  | { command: 'unhide' }
  | { command: 'track'; index: number; duration: number }
  /** Report the film's qualities; see `FilmQuality`. */
  | { command: 'levels'; duration: number }
  /** A quality by its index in the engine's levels, or -1 for automatic. */
  | { command: 'level'; index: number; duration: number }

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

/**
 * The film's qualities, as the source's streaming engine has them.
 *
 * `levels` is empty when no engine could be found: then `height` is all there
 * is to say. Found by shape rather than by source (`findEngine` in the
 * script), so any hls.js a page keeps where a script can reach it counts:
 * VidSrc's in a global, VidLux's in React state.
 */
export interface FilmQuality {
  levels: Array<{ index: number; height: number; bitrate: number }>
  /** The engine's own choice: the level playing, or -1. */
  current: number
  auto: boolean
  /** The picture's height as decoded, 0 before the first frame. */
  height: number
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

export function parseQuality(data: unknown): { id: string; quality: FilmQuality } | null {
  const message = tagged(data)
  const q = message?.quality
  if (!message || typeof message.id !== 'string' || typeof q !== 'object' || q === null) return null
  const raw = q as Record<string, unknown>
  const levels: FilmQuality['levels'] = []
  for (const level of Array.isArray(raw.levels) ? (raw.levels as unknown[]) : []) {
    const l = level as Record<string, unknown>
    const index = finite(l?.index)
    const height = finite(l?.height)
    if (index === null || height === null || height <= 0) continue
    levels.push({ index, height, bitrate: finite(l.bitrate) ?? 0 })
  }
  return {
    id: message.id,
    quality: { levels, current: finite(raw.current) ?? -1, auto: raw.auto !== false, height: finite(raw.height) ?? 0 },
  }
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
 * The stricter half, for the frames on the way to the film: every frame and
 * every video *not* on that way is hidden too. That catches advert frames,
 * advert videos, and whatever else a source lays over or beside the film.
 *
 * The way is marked from the film up. The frame that holds the film marks its
 * video (`data-wta-film`) and says so to its parent (`path`). Each parent
 * marks the frame that said it and passes it on. A frame adds this style only
 * once it knows its own way to the film, so the film is never hidden while the
 * marks are still on their way up.
 */
export const STRICT_CSS =
  'video:not([data-wta-film]),iframe:not([data-wta-film]){visibility:hidden!important}' +
  'video[data-wta-film],iframe[data-wta-film]{visibility:visible!important}'

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
  const STRICT_ID = 'wta-hide-strict'
  const STRICT_CSS = ${JSON.stringify(STRICT_CSS)}
  const MARK = 'data-wta-film'

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
  const COMMANDS = ['watch', 'play', 'pause', 'toggle', 'setPaused', 'seek', 'seekBy', 'volume', 'mute', 'hide', 'unhide', 'track', 'levels', 'level']

  // ── Quality: the page's streaming engine, found by its shape ──────────────
  // An hls.js-like engine: a list of levels, the one playing, and an
  // automatic mode. Found wherever a script can reach it, and only if it is
  // attached to this very video.
  const isEngine = (value) => {
    try {
      return Array.isArray(value.levels) && value.levels.length > 0 &&
        typeof value.currentLevel === 'number' && 'autoLevelEnabled' in value
    } catch (error) { return false }
  }
  let engine = null
  const findEngine = (video) => {
    if (engine && (engine.media === video || !engine.media)) return engine
    engine = null
    const seen = new Set()
    let budget = 0
    const look = (value, depth) => {
      if (!value || typeof value !== 'object' || seen.has(value) || budget-- <= 0) return null
      seen.add(value)
      if (value === window || (typeof Node === 'function' && value instanceof Node)) return null
      if (isEngine(value) && (!value.media || value.media === video)) return value
      if (depth === 0) return null
      let keys = []
      try { keys = Object.keys(value).slice(0, 80) } catch (error) { return null }
      for (const key of keys) {
        let child
        try { child = value[key] } catch (error) { continue }
        const found = look(child, depth - 1)
        if (found) return found
      }
      return null
    }
    // The page's own globals (VidSrc: window.__JW.state.hls).
    budget = 8000
    for (const key of Object.keys(window)) {
      let value
      try { value = window[key] } catch (error) { continue }
      const found = look(value, 3)
      if (found) return (engine = found)
    }
    // React state along the video element's own fiber (VidLux: a useRef).
    budget = 8000
    const fiberKey = Object.keys(video).find((key) => key.startsWith('__reactFiber') || key.startsWith('__reactInternalInstance'))
    let fiber = fiberKey ? video[fiberKey] : null
    for (let hops = 0; fiber && hops < 60; hops++, fiber = fiber.return) {
      let hook = fiber.memoizedState
      for (let n = 0; hook && typeof hook === 'object' && n < 40; n++, hook = hook.next) {
        const found = look(hook.memoizedState, 2)
        if (found) return (engine = found)
      }
      const found = look(fiber.stateNode !== video ? fiber.stateNode : null, 2)
      if (found) return (engine = found)
    }
    return null
  }
  const reportQuality = (video) => {
    if (!watching || video !== film()) return
    const found = findEngine(video)
    const levels = []
    if (found) {
      found.levels.forEach((level, index) => {
        const height = Number(level && level.height)
        if (height > 0) levels.push({ index, height, bitrate: Number(level.bitrate) || 0 })
      })
    }
    send({ [TAG]: 1, id: ID, quality: {
      levels,
      current: found ? Number(found.currentLevel) : -1,
      auto: found ? found.autoLevelEnabled !== false : true,
      height: Number(video.videoHeight) || 0,
    } })
  }

  // Hiding the source's interface, and with the way to the film known, the rest.
  let hiding = false
  const style = (id, css) => {
    if (document.getElementById(id)) return
    const element = document.createElement('style')
    element.id = id
    element.textContent = css
    ;(document.head || document.documentElement).appendChild(element)
  }
  const unstyle = (id) => document.getElementById(id)?.remove()
  // This frame is on the film's way: mark what leads there, hide the rest.
  const onWay = (element) => {
    if (element) element.setAttribute(MARK, '')
    if (hiding) style(STRICT_ID, STRICT_CSS)
    send({ [TAG]: 1, path: ID })
  }

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
          hiding = true
          style(HIDE_ID, HIDE_CSS)
          if (data.film === ID) onWay(video)
          else if (document.querySelector('[' + MARK + ']')) style(STRICT_ID, STRICT_CSS)
          break
        case 'unhide':
          hiding = false
          unstyle(HIDE_ID)
          unstyle(STRICT_ID)
          break
        case 'track': {
          const target = aimed(data)
          if (target) chooseTrack(target, Number(data.index))
          break
        }
        case 'levels': {
          const target = aimed(data)
          if (target) reportQuality(target)
          break
        }
        case 'level': {
          const target = aimed(data)
          const found = target && findEngine(target)
          const index = Number(data.index)
          if (found && Number.isInteger(index) && index >= -1 && index < found.levels.length) {
            // currentLevel switches now, flushing what was buffered at the old
            // level; -1 hands the choice back to the engine.
            try { found.currentLevel = index } catch (error) {}
            setTimeout(() => reportQuality(target), 300)
          }
          break
        }
      }
      down(data)
      return
    }

    // A child is on the film's way: mark its frame, and say so upwards.
    if (typeof data.path === 'string') {
      const child = children().find((frame) => frame.contentWindow === event.source)
      if (child) onWay(child)
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
  // A new picture size: a quality change, by us or by the engine.
  on('resize', (video) => reportQuality(video))

  send({ [TAG]: 1, hello: ID })
})()`
}
