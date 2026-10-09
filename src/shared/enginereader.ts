/**
 * Reading a page's streaming engine: what qualities and sounds the source
 * offers, as its own player holds them.
 *
 * The film relay (`filmrelay.ts`) has done this for plays since 2.0.0, to
 * fill our quality menu and, since 2.0.18, to file the source's offer with a
 * play. A test loads the same pages and could only read their playlists, so a
 * source whose ladder never crosses the network in the clear (an engine fed
 * from a bundle, a playlist bound to the client that fetched it) read at best
 * a floor in a test and an offer when played. This module is the reading
 * itself, once, as source text: the relay builds its commands around it, and
 * a test runs it in every frame of the probe's page (the desktop through
 * `WebFrameMain.executeJavaScript`, the phone in its page script).
 *
 * ## Side-effect free
 *
 * The readers only look: no globals are set, no listeners added, nothing in
 * the page is called. A probe runs it in frames it knows nothing about, as
 * often as it likes, and the page cannot tell.
 *
 * ## Found by shape, not by source
 *
 * An hls.js-like engine is a list of `levels`, a `currentLevel` and an
 * automatic mode. It is looked for in the page's globals (VidSrc keeps its
 * hls.js at `window.__JW.state.hls`) and in the React tree the video is part
 * of (VidLux above the video, Videasy in a component beside it). Videasy's
 * engine holds one rendition with no size; its qualities are whole streams in
 * React state (`sources: [{ quality, url }]`), read as a second kind.
 *
 * Source text inside a template literal: no backslashes anywhere in the
 * readers, since the template would drop the one before a `d` (the relay was
 * caught by exactly that once).
 */

import { languageList, trackLanguages } from './audiotracks'
import { lengthVerdict } from './runtimecheck'
import { qualityClass } from './streamquality'

/**
 * The readers, as declarations to paste into a script: `searchEngine(video)`,
 * `findStreams(video)`, `engineLevels(engine)`, `audioTracksOf(engine, video)`
 * and the helpers they use. Each takes a `<video>` element, or the engine it
 * found for one.
 */
export const ENGINE_READERS = `
  // An hls.js-like engine: a list of levels, the one playing, and an
  // automatic mode.
  const isEngine = (value) => {
    try {
      return Array.isArray(value.levels) && value.levels.length > 0 &&
        typeof value.currentLevel === 'number' && 'autoLevelEnabled' in value
    } catch (error) { return false }
  }
  // Every fiber of the React tree the video is in: first the ones above it,
  // cheaply (VidLux keeps its hls.js there), then the rest from the root down
  // (Videasy keeps its own in a component beside the video that renders
  // nothing).
  const reactFibers = function* (video) {
    const key = Object.keys(video).find((name) => name.startsWith('__reactFiber') || name.startsWith('__reactInternalInstance'))
    let fiber = key ? video[key] : null
    const above = new Set()
    for (let hops = 0; fiber && hops < 60; hops++) {
      above.add(fiber)
      yield fiber
      if (!fiber.return) break
      fiber = fiber.return
    }
    for (let hops = 0; fiber && fiber.return && hops < 400; hops++) fiber = fiber.return
    const stack = fiber ? [fiber] : []
    for (let n = 0; stack.length > 0 && n < 4000; n++) {
      const next = stack.pop()
      if (!above.has(next)) yield next
      if (next.sibling) stack.push(next.sibling)
      if (next.child) stack.push(next.child)
    }
  }
  const hookStates = function* (fiber) {
    let hook = fiber.memoizedState
    for (let n = 0; hook && typeof hook === 'object' && n < 40; n++, hook = hook.next) yield hook.memoizedState
  }
  // The engine playing this very video, wherever a script can reach it; null
  // when there is none. A search, every time: the relay keeps what it found.
  const searchEngine = (video) => {
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
      if (found) return found
    }
    // React state: a component's hooks, and a class component's instance.
    budget = 38000
    for (const fiber of reactFibers(video)) {
      for (const state of hookStates(fiber)) {
        const found = look(state, 2)
        if (found) return found
      }
      const found = look(fiber.stateNode !== video ? fiber.stateNode : null, 2)
      if (found) return found
    }
    return null
  }
  // The levels an engine offers that state a height, by their index in its list.
  const engineLevels = (engine) => {
    const levels = []
    if (!engine) return levels
    engine.levels.forEach((level, index) => {
      const height = Number(level && level.height)
      if (height > 0) levels.push({ index, width: Number(level.width) || 0, height, bitrate: Number(level.bitrate) || 0 })
    })
    return levels
  }
  // The sounds on offer: the engine's audio tracks (hls.js: lang, name), else
  // the element's own, where the browser exposes them.
  const audioTracksOf = (engine, video) => {
    const tracks = []
    try {
      const list = engine && Array.isArray(engine.audioTracks) ? engine.audioTracks : (video && video.audioTracks) || []
      for (let i = 0; i < list.length && tracks.length < 20; i++) {
        const track = list[i]
        if (track) tracks.push({ language: String(track.lang || track.language || ''), name: String(track.name || track.label || '') })
      }
    } catch (error) {}
    return tracks
  }

  // Quality, second kind: whole streams, one per quality. Videasy's hls.js
  // holds a single rendition with no size. Its qualities are separate streams,
  // listed in React state as \`sources: [{ quality: '1080p', url }]\`, and its
  // own menu switches by handing one to \`handleChangeQuality\`
  // (\`setCurrentSource\` does the same without that menu's bookkeeping).
  const streamHeight = (label) => {
    const match = /([0-9]{3,4}) *p/i.exec(String(label))
    return match ? Number(match[1]) : /4k/i.test(String(label)) ? 2160 : 0
  }
  const isStreamList = (value) => {
    try {
      return Array.isArray(value) && value.length > 1 &&
        value.every((stream) => stream && typeof stream.url === 'string' && streamHeight(stream.quality) > 0)
    } catch (error) { return false }
  }
  const findStreams = (video) => {
    let list = null
    let handle = null
    let set = null
    let current = null
    for (const fiber of reactFibers(video)) {
      for (const state of hookStates(fiber)) {
        if (!state || typeof state !== 'object') continue
        try {
          if (!list && isStreamList(state.sources)) list = state.sources
          if (!handle && typeof state.handleChangeQuality === 'function') handle = state.handleChangeQuality
          if (!set && typeof state.setCurrentSource === 'function') set = state.setCurrentSource
          if (!current && state.currentSource && typeof state.currentSource.url === 'string') current = state.currentSource
        } catch (error) {}
      }
      if (list && handle && current) break
    }
    const choose = handle || set
    if (!list || !choose) return null
    const playing = current ? list.findIndex((stream) => stream.url === current.url) : -1
    return { list, choose, current: playing }
  }
`

/**
 * The most videos one frame reports. A player page has one or two (the film,
 * an advert); more is a page of thumbnails, and each costs a search.
 */
const VIDEOS_PER_FRAME = 4

/**
 * `ENGINE_READERS` and `readFrame()`, which reads every video in the frame
 * that has a length, open shadow roots included, and what its engine offers.
 * For a page script that reports more than once (the phone's).
 */
export const FRAME_READER = `${ENGINE_READERS}
  const readFrame = () => {
    const found = []
    const walk = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element.tagName === 'VIDEO') found.push(element)
        if (element.shadowRoot) walk(element.shadowRoot)
      }
    }
    try { walk(document) } catch (error) {}
    const videos = []
    for (const video of found) {
      const duration = Number(video.duration)
      if (!(duration > 0) || videos.length >= ${VIDEOS_PER_FRAME}) continue
      let levels = []
      let streams = false
      let audio = []
      try {
        const engine = searchEngine(video)
        levels = engineLevels(engine)
        audio = audioTracksOf(engine, video)
        if (levels.length === 0) {
          const whole = findStreams(video)
          if (whole) {
            streams = true
            levels = whole.list.map((stream, index) => ({ index, width: 0, height: streamHeight(stream.quality), bitrate: 0 }))
          }
        }
      } catch (error) {}
      videos.push({ duration, width: Number(video.videoWidth) || 0, height: Number(video.videoHeight) || 0, levels, streams, audio })
    }
    return { videos }
  }
`

/**
 * One frame read once, as an expression: what `executeJavaScript` evaluates
 * in every frame of a test's page, answering a `FrameReading` (raw; see
 * `parseFrameReading`).
 */
export const READ_FRAME_SCRIPT = `(() => {${FRAME_READER}
  return readFrame()
})()`

/** One video in a frame, as the reader found it. */
export interface EngineVideo {
  /** Seconds, as the element reports it: the length of what is loaded into it. */
  duration: number
  /** The picture as decoded; 0 before the first frame. */
  width: number
  height: number
  /** What its engine offers, by size; width 0 where only a height is known. Empty when no engine was found. */
  levels: Array<{ width: number; height: number }>
  /** The levels are whole streams (Videasy's), not an engine's ladder. */
  streams: boolean
  /** The languages its sound is offered in (`audiotracks.ts`); empty when the engine lists none. */
  audio: string[]
}

/** One frame's videos. */
export interface FrameReading {
  videos: EngineVideo[]
}

const finite = (value: unknown): number | null => {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * A frame's answer, checked: a provider's page answered it, and a page can
 * have replaced anything the script used. Null when it is not a reading.
 */
export function parseFrameReading(raw: unknown): FrameReading | null {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { videos?: unknown }).videos)) return null
  const videos: EngineVideo[] = []
  for (const entry of (raw as { videos: unknown[] }).videos.slice(0, VIDEOS_PER_FRAME)) {
    if (typeof entry !== 'object' || entry === null) continue
    const v = entry as Record<string, unknown>
    const duration = finite(v.duration)
    if (duration === null || duration <= 0) continue
    const levels: EngineVideo['levels'] = []
    for (const level of Array.isArray(v.levels) ? (v.levels as unknown[]) : []) {
      const l = (level ?? {}) as Record<string, unknown>
      const height = finite(l.height)
      if (height !== null && height > 0) levels.push({ width: finite(l.width) ?? 0, height })
    }
    videos.push({
      duration,
      width: finite(v.width) ?? 0,
      height: finite(v.height) ?? 0,
      levels,
      streams: v.streams === true,
      audio: trackLanguages(v.audio),
    })
  }
  return { videos }
}

/**
 * The videos whose length could be the title's: an advert served through an
 * engine of its own lists its own ladder just as plainly. Unknown counts as
 * could be, as `lengthVerdict` has it.
 */
function titleVideos(readings: readonly FrameReading[], runtimeMinutes: number | null): EngineVideo[] {
  return readings.flatMap((r) => r.videos).filter((v) => lengthVerdict(v.duration, runtimeMinutes) !== 'implausible')
}

/**
 * The best the source offers by its engine's own list, as a quality class:
 * what a test files in the judge's `player` slot, an offer. Null when no
 * engine with sizes was found on a video that could be the title.
 */
export function engineOffer(readings: readonly FrameReading[], runtimeMinutes: number | null): number | null {
  const classes = titleVideos(readings, runtimeMinutes).flatMap((v) =>
    v.levels.map((level) => qualityClass({ width: level.width > 0 ? level.width : null, height: level.height })),
  )
  return classes.length > 0 ? Math.max(...classes) : null
}

/** The languages the title's engine offers its sound in. */
export function engineAudio(readings: readonly FrameReading[], runtimeMinutes: number | null): string[] {
  return languageList(titleVideos(readings, runtimeMinutes).flatMap((v) => v.audio))
}

/** Every video length the frames reported, for the right-film check (`rightfilm.ts`). */
export function engineLengths(readings: readonly FrameReading[]): number[] {
  return readings.flatMap((r) => r.videos.map((v) => v.duration))
}
