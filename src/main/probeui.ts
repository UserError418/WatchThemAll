/**
 * Provider reachability, measured through the player the user actually uses.
 *
 * `streamprobe.ts` answers a related but different question. It builds its own
 * `BrowserWindow` on its own session and watches the network for a manifest or
 * a segment, and it is good at explaining *why* something failed. What it
 * cannot do is tell you whether the app plays the title, because it is a second
 * implementation of the playback path — and two implementations drift.
 *
 * That drift is not hypothetical. The ad blocker was added to the player and
 * the probe kept passing, because the probe's session never had the rules
 * installed: a rule that killed every stream would have shipped green. The
 * probe measured a pipeline no user has.
 *
 * So this module measures the real one. It calls `createInlinePlayer` — the
 * same function the app calls when you press play — and asks the resulting
 * player one question: **is the video advancing?** Everything the user depends
 * on is therefore in the measurement by construction rather than by
 * remembering to copy it: the session partition, the spoofed identity headers,
 * the local shell framing, the ad rules, the autoplay handling.
 *
 * ## Pinned to one provider on purpose
 *
 * The player's job in the app is to *hide* a broken provider by falling back to
 * the next one, which is exactly what a health check must not allow: fallback
 * would report the catalogue's best provider fifteen times over. Each run is
 * given a single candidate, so it can only succeed by playing.
 */

import { BrowserWindow, webContents, type Session } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Provider } from '@shared/types'
import type { PlayRequest } from '@shared/ipc'
import { createInlinePlayer } from './playerview'
import { renderTemplate } from './providers'
import type { ProbeSubject } from './streamprobe'
import { checkRuntime, type RuntimeVerdict } from './runtimecheck'

/** How the player behaved for one provider and one title. */
export interface UiProbeResult {
  providerId: string
  subject: ProbeSubject
  /** The video reported a position that moved. Nothing else counts as playing. */
  played: boolean
  seconds: number
  duration: number
  /** Milliseconds from opening the view to the first advancing position. */
  ms: number | null
  /** Why the player gave up, when it says. */
  reason: string | null
  /**
   * Whether what played is the right *length* for what was asked for.
   *
   * Separate from `played` on purpose, because they are separate questions and
   * conflating them is what let a provider score 100% while serving another
   * programme entirely.
   */
  runtime: RuntimeVerdict
  runtimeReason: string
  /** What was on screen, when `evidenceDir` asked for it. Null otherwise. */
  evidence: UiProbeEvidence | null
}

/**
 * What a person needs to judge whether the right title played.
 *
 * The runtime check catches a wrong *length* and nothing else. Two episodes of
 * one series run the same length, and so do two films, so the last word on
 * "is this the right thing" belongs to someone looking at it. This is what
 * they look at.
 */
export interface UiProbeEvidence {
  /** Each frame's document title and the start of its visible text. */
  frames: string[]
  /** Path of a screenshot taken part-way into the title, or null. */
  screenshot: string | null
}

export interface UiProbeOptions {
  provider: Provider
  subject: ProbeSubject
  /** Resolves a provider URL to the local shell, exactly as the app does. */
  frameUrl: (providerUrl: string) => string
  /** Directory of the built main bundle, for the preload path. */
  dirname: string
  timeoutMs?: number
  /** Polling interval for the position. */
  sampleMs?: number
  /**
   * Where to write a screenshot of each title that plays. Absent means none
   * are taken, which is the default because each one costs several seconds.
   */
  evidenceDir?: string
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

function requestFor(subject: ProbeSubject, providerId: string): PlayRequest {
  return {
    providerId,
    imdbId: subject.imdbId,
    tmdbId: subject.tmdbId,
    type: subject.type,
    season: subject.season ?? null,
    episode: subject.episode ?? null,
    title: subject.label,
    runtimeMinutes: subject.runtimeMinutes ?? null,
  } as PlayRequest
}

/**
 * Play one title on one provider and report whether it moved.
 *
 * The window is hidden but deliberately not zero-sized: a player laid out into
 * no space is a player some embeds decline to start, and "the video was never
 * visible" is not the question being asked.
 */
export async function probeThroughPlayer(options: UiProbeOptions): Promise<UiProbeResult> {
  const { provider, subject, frameUrl, dirname } = options
  const timeoutMs = options.timeoutMs ?? 30_000
  const sampleMs = options.sampleMs ?? 500

  const base: UiProbeResult = {
    providerId: provider.id,
    subject,
    played: false,
    seconds: 0,
    duration: 0,
    ms: null,
    reason: null,
    runtime: 'unknown',
    runtimeReason: 'not reached',
    evidence: null,
  }

  const context = requestFor(subject, provider.id)
  const url = renderTemplate(provider, context)
  if (url === null) return { ...base, reason: 'no-template' }

  /**
   * Shown, not hidden, and that is the difference between working and not.
   *
   * A hidden window gets no rendering lifecycle at all — no
   * `requestAnimationFrame`, no compositor — and a video element in one never
   * reaches a state where it reports a duration, so the position stayed `null`
   * for the whole budget while the clicks landed correctly.
   *
   * `streamprobe` gets away with `show: false` because it only watches the
   * network, and bytes move without anything being painted. This check asks
   * whether the picture moves, which is a question only a rendered page can
   * answer. Under Xvfb "shown" costs nothing.
   */
  const win = new BrowserWindow({
    show: true,
    width: 1280,
    height: 720,
    webPreferences: { backgroundThrottling: false },
  })

  let outcomeReason: string | null = null
  const player = createInlinePlayer({
    window: win,
    dirname,
    url,
    context,
    // One candidate, so a failure cannot be papered over by falling back.
    candidates: [{ provider, url }],
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    frameUrl,
    reportOutcome: (_id, outcome) => {
      if (outcome === 'failed') outcomeReason = 'player reported failure'
    },
  })

  const startedAt = Date.now()
  let result = base

  try {
    let previous = -1
    let pressed = 0
    while (Date.now() - startedAt < timeoutMs) {
      await sleep(sampleMs)

      /**
       * Press play a few times, spaced out.
       *
       * Once for players ready immediately, again for those still building
       * their UI when the first attempt lands. Without this the check reports
       * working providers as dead — measured: vidflix came back 0/2 against a
       * network probe's 10/10, purely because nothing clicked.
       */
      if (pressed < 4 && Date.now() - startedAt > pressed * 3_000) {
        pressed += 1
        await player.pressPlay()
      }
      const position = player.position()
      if (process.env.WTA_PROBE_UI_LOG === '1') {
        console.log(
          `    [ui] ${subject.label} ${Math.round((Date.now() - startedAt) / 1000)}s presses=${pressed} ` +
            `position=${position === null ? 'null' : `${position.seconds.toFixed(1)}/${position.duration.toFixed(1)}`}`,
        )
      }
      if (position !== null) {
        // Advancing, not merely present. A stalled embed reports a steady
        // `currentTime` of 0 for as long as you care to watch it, and a
        // duration alone is metadata rather than playback.
        const advanced = position.seconds > previous && position.seconds > 0
        previous = Math.max(previous, position.seconds)
        if (advanced) {
          const runtime = checkRuntime({
            deliveredSeconds: position.duration,
            expectedMinutes: subject.runtimeMinutes ?? null,
          })
          result = {
            ...base,
            played: true,
            seconds: position.seconds,
            duration: position.duration,
            ms: Date.now() - startedAt,
            runtime: runtime.verdict,
            runtimeReason: runtime.reason,
          }
          break
        }
      }
    }

    if (result.played && options.evidenceDir) {
      result = {
        ...result,
        evidence: await collectEvidence(
          player.session,
          options.evidenceDir,
          `${provider.id}--${subject.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
        ),
      }
    }

    if (!result.played) {
      const exhausted = player.exhausted.map((e) => e.reason).join('; ')
      result = { ...base, reason: exhausted || outcomeReason || 'no advancing position' }
    }
  } finally {
    player.destroy()
    if (!win.isDestroyed()) win.destroy()
  }

  return result
}

/** Whatever a promise resolves to, or `fallback` if it takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** A frame's title and the start of its visible text, on one line. */
const DESCRIBE_FRAME = `(() => {
  const title = document.title || ''
  const text = ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').trim()
  return title || text ? title + ' | ' + text.slice(0, 240) : ''
})()`

/**
 * Jump the video 40% in, muted.
 *
 * Past the cold open, the recap and the title sequence, which are the parts
 * most alike between one episode and the next — the frame worth looking at is
 * one only this episode contains.
 */
const SEEK_INTO_TITLE = `(() => {
  const video = document.querySelector('video')
  if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return false
  video.muted = true
  video.currentTime = video.duration * 0.4
  void video.play().catch(() => {})
  return true
})()`

/**
 * Read every frame's text and photograph the picture part-way in.
 *
 * Found by session rather than handed over, so that `playerview` does not
 * grow an accessor for its view that only a probe would ever call. The
 * player's partition is unique to it, so the match is exact.
 *
 * Every step is time-boxed. A page busy enough to stall `executeJavaScript`
 * costs this result its evidence, never the run its progress.
 */
async function collectEvidence(
  session: Session,
  dir: string,
  name: string,
): Promise<UiProbeEvidence> {
  const contents = webContents
    .getAllWebContents()
    .find((candidate) => !candidate.isDestroyed() && candidate.session === session)
  if (!contents) return { frames: [], screenshot: null }

  const frames: string[] = []
  for (const frame of contents.mainFrame.framesInSubtree) {
    const text = String(await within<unknown>(frame.executeJavaScript(DESCRIBE_FRAME), 1_500, ''))
    if (text) frames.push(`${hostOf(frame.url)} :: ${text}`)
  }

  for (const frame of contents.mainFrame.framesInSubtree) {
    await within(frame.executeJavaScript(SEEK_INTO_TITLE), 1_500, false)
  }
  // Long enough for a seek to buffer and paint on a slow provider.
  await sleep(6_000)

  const image = await within(contents.capturePage(), 5_000, null)
  if (!image || image.isEmpty()) return { frames, screenshot: null }

  await mkdir(dir, { recursive: true })
  const path = join(dir, `${name}.png`)
  await writeFile(path, image.toPNG())
  return { frames, screenshot: path }
}

/** One provider's score over a catalogue of titles. */
export interface UiProbeScore {
  providerId: string
  played: number
  total: number
  /** Rounded percentage, which is the number worth comparing across providers. */
  percent: number
  results: UiProbeResult[]
}

export function score(providerId: string, results: UiProbeResult[]): UiProbeScore {
  const played = results.filter((r) => r.played).length
  return {
    providerId,
    played,
    total: results.length,
    percent: results.length === 0 ? 0 : Math.round((played / results.length) * 100),
    results,
  }
}
