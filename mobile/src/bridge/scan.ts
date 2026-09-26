/**
 * The provider scan, on a phone.
 *
 * Same contract as the desktop — `providers.scan()` in `@shared/ipc` — and the
 * same shape since 1.9.2: every provider loaded out of sight, two at a time,
 * then every red tried again alone with a longer budget. The mechanism is
 * the phone's own.
 *
 * ## Hidden sessions
 *
 * Each provider is loaded into a probe session (`probeview.ts`): a WebView of
 * its own, laid out *under* the app's WebView, so the user sees the app and
 * nothing else while the provider plays exactly as it would on screen. Until
 * 1.9.2 the scan loaded providers one at a time into an iframe the user could
 * see, for two reasons that the sessions remove — see `ProbeViewPlugin.java`:
 *
 * - **Attribution.** The app's single capture buffer could not say which frame
 *   asked for what, so two providers in flight would have shared one pile of
 *   requests. A session logs its own provider's requests and nothing else,
 *   so two run side by side with nothing to blank or wait out between them.
 * - **Pressing play.** A cross-origin iframe could only be clicked by a real
 *   touch on real pixels. A session installs a script into every frame
 *   (`probescript.ts`) that presses play and keeps everything muted; a native
 *   tap is the fallback while nothing has started.
 *
 * Two at a time rather than the desktop's six: measured on the emulator, two
 * sessions gave the same results as one, while the app's own UI fell from
 * 40–60 fps to 16–20 as they decoded. A third would cost the user more than
 * it saves them.
 *
 * ## What counts as a stream
 *
 * Unchanged from the visible scan, and deliberately the phone's own rule — see
 * `scanjudge.ts`. One addition: the page script reports when a video starts
 * playing, in any frame, and that counts. 111Movies fetches its segments
 * through a service worker, whose requests never reach a session's log; the
 * script saw its video advance all the same.
 *
 * ## Why every red is tried again
 *
 * As on the desktop (`scanservice.ts`): a provider sharing the phone with
 * another can be starved into looking dead, and red is the verdict that costs
 * the user a working source. The better of the two results stands; when both
 * fail, the solo run's reason does, because it had the phone to itself.
 */

import type { Provider } from '@shared/types'
import type { PlayRequest, ProbeVerdict, ProviderScan, ProviderScanProgress, ScanReason } from '@shared/ipc'
import { providerRank } from '@shared/scanrank'
import { isMediaRequest, isMediaResponse, WHOLE_FILE_URL } from '@main/mediarequest'
import { renderTemplate } from '@main/providers'
import { capture, PEEK_LIMIT_BYTES, type Candidate } from './cast'
import { bestQuality, judgeQuality, readLadder, readMediaPlaylist, type Rendition } from '@shared/streamquality'
import { readStreamHeader, streamHeaderOf } from '@shared/streamheader'
import { lengthVerdict } from '@main/runtimecheck'
import { closeAllProbes, openProbe, type ProbeDocumentError, type ProbeRequest } from './probeview'
import { isScanCandidate, judgeMissedStream } from './scanjudge'

/**
 * How many providers are loaded at once. See the header for the measurement.
 */
const CONCURRENCY = 2

/**
 * How long one provider gets in the shared pass, and alone in the re-check.
 *
 * The desktop's figures, so "timeout (20 s)" means the same on both. The
 * visible scan gave fifteen, which was enough to *recognise* a stream on the
 * phone; it was not enough to call a provider that is still loading at the
 * end a timeout rather than a failure, which is what the reasons now say.
 */
const PROBE_MS = 20_000
const SOLO_PROBE_MS = 25_000

/** How often to read a session's log while it loads. */
const POLL_MS = 500

/**
 * When to tap the session natively, from its start — only while nothing has
 * streamed or played.
 *
 * The page script presses play in every frame by itself; these catch players
 * that ignore a scripted click. MoviesAPI started only on a real touch in the
 * spike's measurements, and then paused on the next one: a tap on a playing
 * video is a pause. So a tap is only ever made while the session has shown
 * nothing, which a started video ends.
 */
const TAP_AT_MS = [5_000, 9_000, 14_000]

/**
 * How many requests to fetch, when their URLs say nothing.
 *
 * Per poll, so a provider that is streaming is recognised within a second or
 * two of its first opaque request; per provider, so one that never streams
 * costs a dozen small fetches rather than one for everything its page asked
 * for. Measured: 111Movies' first opaque request that answers as a playlist
 * arrives among its first few.
 */
const PEEKS_PER_POLL = 2
const PEEKS_PER_PROVIDER = 12

/**
 * How many playlists to read for quality once a stream is found.
 *
 * Oldest first, because a player fetches its master before anything else and
 * the master is the only playlist that names sizes. Four covers a master, a
 * variant and an audio playlist or two; each is one small fetch.
 */
const QUALITY_PEEKS = 4

/**
 * How many playlist fetches to try at most, counting the ones that fail.
 *
 * Separate from `QUALITY_PEEKS` so that playlists which do not answer cannot
 * use up the budget meant for ones that do. A player that works through
 * several servers leaves the dead ones' playlists first in the log.
 */
const QUALITY_FETCHES = 8

/**
 * How long to keep looking for a quality once a stream is found.
 *
 * The stream is recognised by its first playlist, and that is not always one
 * that can be read: the playlists of servers a player abandons come first, and
 * the one it plays arrives after. Spent only while nothing readable has turned
 * up, and after the stream's time was taken.
 *
 * It does not rescue VidSrc. Measured 2026-09-26: every VidSrc playlist the
 * phone asks for again answers 403 "ip … not in range" — bound to the client
 * that fetched it — so VidSrc shows no quality on the phone, where the desktop
 * reads its ladder.
 */
const QUALITY_WAIT_MS = 4_000

/** A playlist by its URL. */
const PLAYLIST_URL = /\.(m3u8|mpd)(\?|$)/i

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

export interface ScanRunnerOptions {
  /** The enabled providers, in the user's order. Read per run, not captured. */
  providers: () => Provider[]
  /**
   * Stop and resume whatever is playing.
   *
   * No longer about attribution — a session's log holds only its own
   * provider — but two decoding probes and the user's own video would share
   * one phone's bandwidth and decoder, and a starved probe looks dead.
   */
  suspendPlayback: () => void
  resumePlayback: () => void
  onProgress: (progress: ProviderScanProgress) => void
}

export interface ScanRunner {
  run(
    titleKey: string,
    request: Pick<PlayRequest, 'imdbId' | 'tmdbId' | 'type' | 'season' | 'episode'>,
  ): Promise<ProviderScan>
  cancel(): void
  busy(): boolean
}

/** One provider's result. */
interface Measured {
  verdict: ProbeVerdict
  /** Milliseconds to the first sign of a stream, for a stream only. */
  ms: number | null
  quality: number | null
  reason: ScanReason | null
}

export function createScanRunner(options: ScanRunnerOptions): ScanRunner {
  /** Identifies the run, so a cancelled scan's stragglers cannot write. */
  let token = 0
  let running = false

  return {
    busy: () => running,

    cancel() {
      token += 1
      running = false
    },

    async run(titleKey, request) {
      token += 1
      const mine = token
      running = true
      const cancelled = (): boolean => token !== mine

      const providers = options.providers()
      const verdicts: Record<string, ProbeVerdict> = {}
      /** Milliseconds to the first sign of a stream, for streaming providers only. */
      const timings: Record<string, number> = {}
      /** Best quality class offered, for streaming providers whose playlists say. */
      const qualities: Record<string, number> = {}
      /** Why each provider that did not stream failed. */
      const reasons: Record<string, ScanReason> = {}
      /** When each provider's standing result was measured. */
      const testedAt: Record<string, number> = {}
      const total = providers.length

      let confirming = false
      const publish = (provider: Provider | null, finished: boolean): void => {
        options.onProgress({
          titleKey,
          providerId: provider?.id ?? null,
          providerName: provider?.name ?? null,
          done: Object.keys(verdicts).length,
          total,
          verdicts: { ...verdicts },
          timings: { ...timings },
          qualities: { ...qualities },
          reasons: { ...reasons },
          confirming,
          finished,
          cancelled: finished && token !== mine,
        })
      }

      const settle = (provider: Provider, measured: Measured): void => {
        verdicts[provider.id] = measured.verdict
        testedAt[provider.id] = Date.now()
        if (measured.reason !== null) reasons[provider.id] = measured.reason
        else delete reasons[provider.id]
        if (measured.ms !== null) timings[provider.id] = measured.ms
        else delete timings[provider.id]
        if (measured.quality !== null) qualities[provider.id] = measured.quality
        else delete qualities[provider.id]
      }

      const measure = (provider: Provider, budgetMs: number): Promise<Measured> => {
        const url = renderTemplate(provider, request)
        // The provider cannot express this request at all — no template for
        // this media type, or an id it needs and the title lacks. Nothing to
        // load, and nothing transient about it.
        if (url === null) return Promise.resolve({ verdict: 'dead', ms: null, quality: null, reason: { kind: 'unsupported' } })
        return probeOne(url, budgetMs, cancelled)
      }

      options.suspendPlayback()
      publish(providers[0] ?? null, false)

      try {
        /**
         * A shared queue rather than pairs, as on the desktop: a dead host
         * fails in a second while a working provider can use its whole
         * budget, and a pair waits for its slower half.
         */
        let next = 0
        const worker = async (): Promise<void> => {
          while (!cancelled()) {
            const provider = providers[next]
            next += 1
            if (!provider) return

            publish(provider, false)
            const measured = await measure(provider, PROBE_MS)
            // Checked after the await: a cancelled run must not write.
            if (cancelled()) return
            settle(provider, measured)
            publish(provider, false)
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker))

        // Every red again, alone, with the longer budget. See the header.
        confirming = true
        for (const provider of providers) {
          if (cancelled()) break
          if (verdicts[provider.id] !== 'dead' || reasons[provider.id]?.kind === 'unsupported') continue

          publish(provider, false)
          const second = await measure(provider, SOLO_PROBE_MS)
          if (cancelled()) break
          if (providerRank(undefined, second.verdict) <= providerRank(undefined, verdicts[provider.id])) {
            settle(provider, second)
          }
          publish(provider, false)
        }
        confirming = false
      } finally {
        // Each probe closes its own session; this is for one a crash or a
        // cancellation left behind, since every session is a decoding WebView.
        await closeAllProbes().catch(() => 0)
        options.resumePlayback()
        if (token === mine) running = false
      }

      const scan: ProviderScan = { titleKey, at: Date.now(), verdicts, testedAt, timings, qualities, reasons }
      publish(null, true)
      return scan
    },
  }
}

/**
 * Whether any whole file named in the session's log really is a video.
 *
 * The desktop judges a `.mp4` by the response it got; the phone has only the
 * URL, and a URL can lie. VidRock's player loads `…/demo-video.mp4` first on
 * every title, and it is 887 bytes of HTML — counted on the name alone, it made
 * VidRock stream on titles where nothing else loaded. So a whole file counts
 * once one fetch of it answers with something that is not a web page.
 */
async function confirmWholeFiles(
  named: Candidate[],
  peeked: Set<string>,
  bodies: Map<string, string>,
): Promise<boolean> {
  const files = named.filter((candidate) => WHOLE_FILE_URL.test(candidate.url) && !peeked.has(candidate.url))
  for (const candidate of files.slice(0, PEEKS_PER_POLL)) {
    peeked.add(candidate.url)
    try {
      const response = await capture.peek(candidate)
      const ok = response.status === 200 || response.status === 206
      if (ok) bodies.set(candidate.url, response.body)
      if (ok && !/^text\/html/i.test(response.contentType.trim())) return true
    } catch {
      // Unreachable or refused: not proof of anything, so not a stream yet.
    }
  }
  return false
}

/**
 * Fetch a few of the session's requests and ask what they turned out to be.
 *
 * The URL test is free and covers most providers; this covers the ones that
 * stream through opaque proxy paths, which the desktop recognises from the
 * response type and the phone never sees a response for. Newest first, since
 * once a player is streaming its latest requests are playlists and segments
 * rather than the page's own API calls.
 */
async function peekForMedia(
  candidates: Candidate[],
  peeked: Set<string>,
  bodies: Map<string, string>,
): Promise<boolean> {
  // Clamped at zero: `confirmWholeFiles` shares `peeked` without this cap, so
  // it can already be past it — and a negative end would make `slice` keep
  // all but the last few candidates rather than none.
  const allowance = Math.max(0, Math.min(PEEKS_PER_POLL, PEEKS_PER_PROVIDER - peeked.size))
  const fresh = candidates
    .filter((candidate) => !peeked.has(candidate.url))
    .sort((a, b) => b.atMs - a.atMs)
    .slice(0, allowance)

  for (const candidate of fresh) {
    peeked.add(candidate.url)
    try {
      const response = await capture.peek(candidate)
      const ok = response.status === 200 || response.status === 206
      if (ok) bodies.set(candidate.url, response.body)
      if (ok && isMediaResponse(response.contentType, response.body)) return true
    } catch {
      // Expired, unreachable or refused. The next candidate may still answer.
    }
  }
  return false
}

/**
 * Load one provider in a hidden session and decide what happened.
 *
 * Everything in the session's log is this provider's, so there is nothing to
 * clear first and nothing to wait out after. The rules for what the log
 * means are in `scanjudge.ts`.
 */
async function probeOne(url: string, budgetMs: number, cancelled: () => boolean): Promise<Measured> {
  let documentError: ProbeDocumentError | null = null
  let gone = false

  let session: Awaited<ReturnType<typeof openProbe>>
  try {
    session = await openProbe({
      url,
      onDocumentError: (error) => {
        documentError ??= error
      },
      onGone: () => {
        gone = true
      },
    })
  } catch {
    // No session at all: the plugin is missing (the browser preview harness)
    // or refused. That says nothing about the provider.
    return { verdict: 'unsure', ms: null, quality: null, reason: null }
  }

  /** Every request the session has logged, oldest first. */
  const requests: ProbeRequest[] = []
  const peeked = new Set<string>()
  /** Bodies already fetched while deciding what a request was; reused for quality. */
  const bodies = new Map<string, string>()
  let tapped = 0
  let lastRequestAtMs: number | null = null

  const readMore = async (): Promise<{ open: boolean; playingAtMs: number | null }> => {
    const answer = await session.poll()
    requests.push(...answer.requests)
    const last = answer.requests.at(-1)
    if (last) lastRequestAtMs = last.atMs
    return { open: answer.open, playingAtMs: answer.playingAtMs }
  }
  const candidates = (): Candidate[] => requests.filter(isScanCandidate)
  const latestCandidates = async (): Promise<Candidate[]> => {
    await readMore()
    return candidates()
  }

  /**
   * When the stream was proven, or null if it has not been yet.
   *
   * Cheapest evidence first: a playlist or segment named as one, then the
   * page's report that a video started, and only then the checks that cost a
   * fetch — a whole file that must prove it is one, an opaque request that
   * answers as media. Timed from the session's own clock where the evidence
   * carries a time, so a stream is dated by the request that proved it, not
   * by the poll that noticed.
   */
  const streamProvenAt = async (playingAtMs: number | null): Promise<number | null> => {
    const named = requests.filter((request) => isMediaRequest(request.url))
    const firstNamed = named.find((request) => !WHOLE_FILE_URL.test(request.url))
    if (firstNamed) return firstNamed.atMs
    if (playingAtMs !== null) return playingAtMs
    if (await confirmWholeFiles(named, peeked, bodies)) return Date.now()
    if (await peekForMedia(candidates(), peeked, bodies)) return Date.now()
    return null
  }

  try {
    const startedAt = Date.now()
    while (Date.now() - startedAt < budgetMs && !cancelled()) {
      await sleep(POLL_MS)
      const { open, playingAtMs } = await readMore()
      if (!open || gone) {
        // The renderer went, and took the provider with it. A crash is not a
        // verdict on the provider's catalogue, so amber, with nothing to add.
        return { verdict: 'unsure', ms: null, quality: null, reason: null }
      }
      // The document failed in a way no waiting changes; nothing will follow.
      if (documentError && documentFailedForGood(documentError)) break

      const provenAt = await streamProvenAt(playingAtMs)
      if (provenAt !== null) {
        const ms = Math.max(0, provenAt - session.openedAtMs)
        return { verdict: 'stream', ms, quality: await readQuality(bodies, latestCandidates), reason: null }
      }

      const elapsed = Date.now() - startedAt
      if (tapped < TAP_AT_MS.length && elapsed >= (TAP_AT_MS[tapped] ?? Infinity)) {
        tapped += 1
        // Failing to tap is not a reason to abandon the provider.
        await session.tap().catch(() => {})
      }
    }

    const judged = judgeMissedStream({ documentError, lastRequestAtMs, endedAtMs: Date.now(), budgetMs })
    return { verdict: judged.verdict, ms: null, quality: null, reason: judged.reason }
  } finally {
    await session.close().catch(() => {})
  }
}

/** A document failure no amount of waiting changes: no answer at all, or a server error. */
function documentFailedForGood(error: ProbeDocumentError): boolean {
  return error.status === 0 || error.status >= 500
}

/**
 * The best quality the captured playlists name, or null when none does.
 *
 * The phone's counterpart of the desktop's `probeQuality` scan reading, with
 * one reading fewer: it cannot reach into the provider's frame to ask the
 * `<video>` its size, so a source serving one whole file stays unknown here.
 * A single rendition without a master is read from its own header instead —
 * see `readDeclaredSizes`. The parsers and the judgement are the desktop's,
 * from `shared/`, so a stream reads the same on both.
 *
 * Keeps watching the session's requests for up to `QUALITY_WAIT_MS`, because
 * the playlist that proved the stream is not always the one that names sizes.
 */
async function readQuality(
  bodies: Map<string, string>,
  requests: () => Promise<Candidate[]>,
): Promise<number | null> {
  const deadline = Date.now() + QUALITY_WAIT_MS
  /** Every playlist read so far, oldest first: its request and its body ('' if it would not answer). */
  const read: Array<{ candidate: Candidate; body: string }> = []
  /** Declared sizes by playlist URL, so a header is fetched once however often this loops. */
  const declared = new Map<string, Rendition | null>()

  for (;;) {
    // Oldest first, each URL once: a player that asks for the same playlist
    // twice puts it in the buffer twice, and reading both raced two header
    // fetches against one entry in `declared`.
    const seen = new Set(read.map((r) => r.candidate.url))
    const fresh: Candidate[] = []
    for (const candidate of (await requests()).sort((a, b) => a.atMs - b.atMs)) {
      if (seen.has(candidate.url) || !isPlaylist(candidate, bodies)) continue
      seen.add(candidate.url)
      fresh.push(candidate)
    }
    for (const candidate of fresh) {
      if (answered(read) >= QUALITY_PEEKS || read.length >= QUALITY_FETCHES) break
      read.push({ candidate, body: await readPlaylist(candidate, bodies) })
    }

    const ladders = read.map((r) => readLadder(r.body))
    // A ladder settles it; only without one is a header worth a fetch.
    if (!ladders.some((ladder) => bestQuality(ladder) !== null)) await readDeclaredSizes(read, declared)
    const best = judgeQuality({
      streamed: true,
      playlists: ladders.map((ladder, i) => ({ status: read[i]?.body ? 200 : 0, ladder })),
      wholeFiles: 0,
      video: null,
      declared: [...declared.values()].filter((size): size is Rendition => size !== null),
    }).best

    if (best !== null || answered(read) >= QUALITY_PEEKS || read.length >= QUALITY_FETCHES) return best
    if (Date.now() >= deadline) return best
    await sleep(POLL_MS)
  }
}

/** How many of the playlists read so far answered. */
function answered(read: Array<{ body: string }>): number {
  return read.filter((r) => r.body !== '').length
}

/**
 * Whether a request is a playlist: by its URL, or — for the opaque
 * proxy paths some providers stream through — by the body the stream check
 * already peeked at. Not by having been peeked at: the stream check reads the
 * page's API calls too, and those would take a place in `QUALITY_PEEKS`.
 */
function isPlaylist(candidate: Candidate, bodies: Map<string, string>): boolean {
  if (PLAYLIST_URL.test(candidate.url)) return true
  const body = bodies.get(candidate.url)
  return body !== undefined && readLadder(body).kind !== 'unknown'
}

/**
 * One captured playlist's body, whole.
 *
 * A body the stream check already peeked at is reused when it is complete; a
 * peek stops at 16 KB, which a film's media playlist runs past, and the length
 * check below needs every segment in it.
 */
async function readPlaylist(candidate: Candidate, bodies: Map<string, string>): Promise<string> {
  const known = bodies.get(candidate.url)
  if (known !== undefined && known.length < PEEK_LIMIT_BYTES) return known
  const response = await capture.read(candidate).catch(() => null)
  return response && (response.status === 200 || response.status === 206) ? response.body : ''
}

/**
 * The sizes the media playlists' own streams declare, from their headers,
 * recorded into `declared` by playlist URL.
 *
 * Only from playlists at least as long as a title: the scan has no runtime to
 * check against (see `lengthVerdict`), and an ad served as its own playlist
 * states its size just as plainly. The header is fetched with the playlist's
 * request headers — the same player asked the same host a moment earlier.
 */
async function readDeclaredSizes(
  read: Array<{ candidate: Candidate; body: string }>,
  declared: Map<string, Rendition | null>,
): Promise<void> {
  const pending = read.filter((r) => !declared.has(r.candidate.url) && readLadder(r.body).kind === 'hls-media')
  await Promise.all(
    pending.map(async ({ candidate, body }) => {
      declared.set(candidate.url, await declaredSize(candidate, body))
    }),
  )
}

/** One media playlist's declared size, or null when it has none this can read or trust. */
async function declaredSize(candidate: Candidate, body: string): Promise<Rendition | null> {
  const media = readMediaPlaylist(body)
  if (lengthVerdict(media.seconds, null) === 'implausible') return null
  const header = streamHeaderOf(media, candidate.url)
  if (!header) return null
  const answer = await capture.peekBytes(header.url, candidate, header.range).catch(() => null)
  if (!answer || (answer.status !== 200 && answer.status !== 206)) return null
  return readStreamHeader(header.source, answer.bytes)
}
