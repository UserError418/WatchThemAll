/**
 * Hidden probe sessions: a provider loaded out of sight, in a WebView of its
 * own, with a network log that belongs to it alone.
 *
 * The TypeScript face of `ProbeViewPlugin.java`, and what lets the scan
 * (`scan.ts`) measure providers two at a time without showing them. The app's
 * one WebView means one capture buffer with no frame attribution, and pressing
 * play inside a cross-origin iframe from there needs a real touch on a surface
 * the user can see; the Java headers explain how a separate WebView removes
 * both constraints. This file is the contract.
 *
 * ## Shape
 *
 * `openProbe` returns a session. `poll()` hands back the requests made since
 * the previous poll, so a caller loops on it the way `scan.ts` loops on
 * `capture.list()` — except that nothing in the answer came from anyone
 * else, so there is no clearing, blanking or settling to do. `close()` ends
 * it and frees its WebView; always call it, in a `finally`.
 *
 * Every session presses play by itself (see `probescript.ts`) and is always
 * silent. `tap()` is the fallback for a player that ignores a scripted click.
 *
 * A `ProbeRequest` carries `url`, `headers` and `atMs`, so it is a `Candidate`
 * as far as `capture.peek` and `capture.read` in `cast.ts` are concerned —
 * the scan's opaque-URL and quality checks work on it unchanged.
 */

import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { probePageScript } from './probescript'

/** One request the probed page made, as the native side saw it. */
export interface ProbeRequest {
  /** Position in the session's log, from 1. */
  seq: number
  url: string
  method: string
  /** As the page sent them, plus `Cookie`, which the WebView adds later. */
  headers: Record<string, string>
  /** True only for the shell document itself; the provider is a subframe. */
  mainFrame: boolean
  /** Wall clock, milliseconds, comparable with `ProbeSession.openedAtMs`. */
  atMs: number
}

/** What the device's WebView supports. Worth asking once before a scan. */
export interface ProbeCapabilities {
  /** Play can be pressed without a touch. False means only `tap()` presses. */
  documentStartScript: boolean
  /** The whole WebView can be muted natively, Web Audio included. */
  muteAudio: boolean
  webViewVersion: string
  /** Opening more than this at once is refused. */
  maxSessions: number
}

/** The provider's own document failed to load. Sub-resource failures are not reported. */
export interface ProbeDocumentError {
  url: string
  /** The HTTP status, or 0 when there was no response at all (DNS, TLS, reset). */
  status: number
  description: string
}

export interface ProbeSession {
  readonly id: string
  /** Wall clock at which the native side started loading. `atMs` values count from the same clock. */
  readonly openedAtMs: number
  /** Whether the page script was installed — i.e. whether play is being pressed and media muted in-page. */
  readonly documentStartScript: boolean
  /** Whether the WebView itself is muted. */
  readonly audioMuted: boolean
  /**
   * Requests made since the previous poll, oldest first.
   *
   * `missed` counts requests the log dropped before this poll read them,
   * which only happens when polls are far apart on a page streaming hard.
   * `open` is false once the session has closed or its renderer died.
   * `playingAtMs` is when the page script first saw media playing in any
   * frame, or null — decode evidence the request log can miss, because a
   * service worker's requests never reach it.
   */
  poll(): Promise<{ requests: ProbeRequest[]; missed: number; open: boolean; playingAtMs: number | null }>
  /** A real touch in the probe view, at CSS pixels within it, or at its centre. */
  tap(point?: { x: number; y: number }): Promise<void>
  /** Destroy the WebView. Safe to call more than once. */
  close(): Promise<void>
}

export interface OpenProbeOptions {
  /** The provider URL, exactly as the player would load it. */
  url: string
  /**
   * The page the provider appears to be embedded in. Its origin is what the
   * provider sees as `Referer` and as its parent. Defaults to the app's own
   * origin, which is what the in-app player gives it.
   */
  referer?: string
  /** See `ProbeScriptOptions.pressPlay`. */
  pressPlay?: boolean
  onDocumentError?: (error: ProbeDocumentError) => void
  /** The session ended by itself: its renderer was killed or crashed. */
  onGone?: (reason: string) => void
}

interface ProbeViewNative {
  capabilities(): Promise<ProbeCapabilities>
  open(options: {
    sessionId: string
    url: string
    referer?: string
    pageScript?: string
  }): Promise<{ sessionId: string; openedAtMs: number; documentStartScript: boolean; audioMuted: boolean }>
  close(options: { sessionId: string }): Promise<{ closed: boolean }>
  closeAll(): Promise<{ closed: number }>
  tap(options: { sessionId: string; x?: number; y?: number }): Promise<void>
  requests(options: {
    sessionId: string
    after: number
  }): Promise<{ requests: ProbeRequest[]; cursor: number; missed: number; open: boolean; playingAtMs: number }>
  addListener(
    event: 'probeDocumentError',
    cb: (payload: ProbeDocumentError & { sessionId: string }) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    event: 'probeGone',
    cb: (payload: { sessionId: string; reason: string }) => void,
  ): Promise<PluginListenerHandle>
}

const ProbeView = registerPlugin<ProbeViewNative>('ProbeView')

export function probeCapabilities(): Promise<ProbeCapabilities> {
  return ProbeView.capabilities()
}

/** Destroy every open session, including ones whose handles were lost. Resolves with how many. */
export async function closeAllProbes(): Promise<number> {
  return (await ProbeView.closeAll()).closed
}

/**
 * Names are made here rather than by the caller: they only have to be unique
 * within this page's lifetime, and a caller inventing them is a caller who
 * can collide with itself.
 */
let opened = 0
const nextSessionId = (): string => `probe-${Date.now().toString(36)}-${(opened += 1)}`

export async function openProbe(options: OpenProbeOptions): Promise<ProbeSession> {
  const sessionId = nextSessionId()

  // Listening starts before the load does, so an error that arrives before
  // `open` resolves — a refused connection can — is not lost.
  const handles: PluginListenerHandle[] = []
  const stopListening = (): void => {
    for (const handle of handles.splice(0)) void handle.remove()
  }
  handles.push(
    await ProbeView.addListener('probeDocumentError', ({ sessionId: from, ...error }) => {
      if (from === sessionId) options.onDocumentError?.(error)
    }),
    await ProbeView.addListener('probeGone', ({ sessionId: from, reason }) => {
      if (from !== sessionId) return
      stopListening()
      options.onGone?.(reason)
    }),
  )

  let native: Awaited<ReturnType<ProbeViewNative['open']>>
  try {
    native = await ProbeView.open({
      sessionId,
      url: options.url,
      referer: options.referer,
      pageScript: probePageScript({ pressPlay: options.pressPlay }),
    })
  } catch (error) {
    stopListening()
    throw error
  }

  let cursor = 0
  return {
    id: sessionId,
    openedAtMs: native.openedAtMs,
    documentStartScript: native.documentStartScript,
    audioMuted: native.audioMuted,

    async poll() {
      const answer = await ProbeView.requests({ sessionId, after: cursor })
      cursor = answer.cursor
      return {
        requests: answer.requests,
        missed: answer.missed,
        open: answer.open,
        playingAtMs: answer.playingAtMs > 0 ? answer.playingAtMs : null,
      }
    },

    tap(point) {
      return ProbeView.tap({ sessionId, ...point })
    },

    async close() {
      stopListening()
      await ProbeView.close({ sessionId })
    },
  }
}
