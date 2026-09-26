/**
 * The provider scan, on a phone.
 *
 * Same contract as the desktop — `providers.scan()` in `@shared/ipc` — and a
 * completely different mechanism underneath, because almost nothing the desktop
 * probe relies on exists in a WebView. `src/main/scanservice.ts` opens a hidden
 * `BrowserWindow` per provider on its own session and reads Electron's
 * `webRequest`. Here there is one WebView, one network stack, and no way to
 * script a cross-origin frame.
 *
 * What is available is the hook the cast feature already uses:
 * `shouldInterceptRequest` on the app's `WebViewClient` fires for every
 * subresource of every frame, cross-origin included, and `MediaCapture` keeps
 * what it sees. So the phone can answer the same question the desktop probe
 * answers — *did anything actually fetch a stream* — by emptying that buffer,
 * loading one provider, and looking at what lands in it.
 *
 * ## Three consequences of there being exactly one buffer
 *
 * `MediaCapture` records a URL and its headers. It does **not** record which
 * frame asked, because `shouldInterceptRequest` is not told. Everything awkward
 * about this file follows from that:
 *
 * 1. **Providers are measured one at a time.** The desktop runs six at once;
 *    here two providers in flight would put their requests in
 *    one undifferentiated pile and both would be credited with whatever either
 *    of them fetched.
 *
 * 2. **Playback stops for the duration.** A player streaming in the background
 *    fills the buffer with segments several times a second, and every provider
 *    the scan touched would come back green. The surface is blanked before the
 *    first provider and restored after the last.
 *
 * 3. **Each provider gets a settling period before the next begins.** An HLS
 *    player keeps pulling segments for several seconds after its document has
 *    been navigated away — measured at up to six — which is more than long
 *    enough for a dead provider to be credited with its predecessor's stream.
 *    `scripts/android-provider-probe.py` found this the hard way and
 *    `BLANK_SETTLE_MS` is its number.
 *
 * ## Why the probe surface is visible
 *
 * It would be nicer to load each provider somewhere the user cannot see. It is
 * also not possible to do that *and* press play.
 *
 * Several providers resolve no stream at all until something clicks, and the
 * only way to click inside a cross-origin iframe on Android is a native touch
 * dispatched at real coordinates — see `ScanPlugin`. A touch has to land
 * somewhere, so the frame has to be laid out somewhere, at a real size. An
 * off-screen or zero-sized surface cannot be tapped, and a provider that needed
 * a tap would be reported dead.
 *
 * So the scan shows what it is doing. That is the honest presentation anyway:
 * the user pressed a button that tries a dozen video players, and watching it
 * happen is easier to trust than a spinner.
 */

import { registerPlugin } from '@capacitor/core'
import type { Provider } from '@shared/types'
import type { ProbeVerdict, ProviderScan, ProviderScanProgress, ScanReason } from '@shared/ipc'
import { isMediaRequest, isMediaResponse, WHOLE_FILE_URL } from '@main/mediarequest'
import { renderTemplate } from '@main/providers'
import type { PlayRequest } from '@shared/ipc'
import { capture, PEEK_LIMIT_BYTES, type Candidate } from './cast'
import { bestQuality, judgeQuality, readLadder, readMediaPlaylist, type Rendition } from '@shared/streamquality'
import { readStreamHeader, streamHeaderOf } from '@shared/streamheader'
import { lengthVerdict } from '@main/runtimecheck'

interface ScanNative {
  /** A real touch at a point in the WebView. See `ScanPlugin`. */
  tap(options: { x: number; y: number }): Promise<void>
}

const Scan = registerPlugin<ScanNative>('Scan')

/**
 * How long to give one provider before calling it.
 *
 * Shorter than the desktop's eighteen, and that is measured rather than
 * forgotten. The desktop's budget is set by 111Movies, which takes up to 15.3
 * seconds there to make a request the desktop recognises. On the phone the
 * same provider was recognised in 3.4 seconds for a series and 8.1 for a film,
 * because peeking at its opaque requests finds its first playlist long before
 * anything else would give it away, and ScreenScape in under three. Every
 * second here is on the critical path of a one-at-a-time scan, so it is not
 * padded to match a number that belongs to the other platform.
 */
const PROBE_MS = 15_000

/**
 * How long to wait after blanking before the next provider starts.
 *
 * Not a guess: an HLS player goes on fetching segments for several seconds
 * after its document is gone. Six is the figure `android-provider-probe.py`
 * settled on after crediting providers with their predecessor's traffic.
 */
const BLANK_SETTLE_MS = 6_000

/** How often to look in the capture buffer while a provider is loading. */
const POLL_MS = 500

/**
 * When to tap, measured from the provider starting to load.
 *
 * Three attempts rather than one. The first lands while many players are still
 * building their UI and hits nothing; the later ones catch those. The desktop
 * presses four times for the same reason and records what happens without them
 * — vidflix scored 0/2 against a network probe's 10/10, purely because nothing
 * had clicked.
 */
const TAP_AT_MS = [1_500, 5_000, 9_000]

/**
 * How many captured requests to fetch, when their URLs say nothing.
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
 * variant and an audio playlist or two; each is one small fetch on a scan that
 * already takes fifteen seconds per provider.
 */
const QUALITY_PEEKS = 4

/**
 * How many playlist fetches to try at most, counting the ones that fail.
 *
 * Separate from `QUALITY_PEEKS` so that playlists which do not answer cannot
 * use up the budget meant for ones that do. A player that works through
 * several servers leaves the dead ones' playlists first in the buffer.
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

/** A playlist by its URL, which is all the capture buffer holds. */
const PLAYLIST_URL = /\.(m3u8|mpd)(\?|$)/i

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

export interface ScanRunnerOptions {
  /** The enabled providers, in the user's order. Read per run, not captured. */
  providers: () => Provider[]
  /**
   * Stop and resume whatever is playing.
   *
   * Not optional and not a nicety: a live player fills the one capture buffer
   * this scan reads, and every provider would come back green. `PlayerSurface`
   * already has `blank`/`restore` for the cast case, which is the same need.
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

/**
 * The surface each provider is loaded into.
 *
 * Its own element rather than the player's, so a scan cannot leave the player
 * pointing somewhere unexpected, and so tearing it down is unconditional.
 * Centred and 16:9 at a comfortable size: large enough that a play button is
 * where a player would put it, which is what the tap depends on.
 */
function createProbeSurface(): {
  load(url: string): void
  blank(): void
  centre(): { x: number; y: number }
  destroy(): void
} {
  const host = document.createElement('div')
  host.id = 'wta-scan-surface'
  host.style.cssText = [
    'position: fixed',
    'left: 50%',
    'top: 50%',
    'transform: translate(-50%, -50%)',
    'width: min(92vw, 560px)',
    'aspect-ratio: 16 / 9',
    // Above the app, below nothing — the scan sheet that describes what is
    // happening draws itself around this rectangle rather than over it, so the
    // native tap has an unobstructed path to the frame.
    'z-index: 420',
    'background: #000',
    'border-radius: 12px',
    'overflow: hidden',
  ].join(';')

  const frame = document.createElement('iframe')
  // No `sandbox`, for the reason recorded in `MainActivity`: providers detect
  // it and refuse to serve, which would make this measure the attribute rather
  // than the provider.
  frame.setAttribute('allow', 'autoplay; encrypted-media')
  frame.setAttribute('referrerpolicy', 'origin')
  frame.style.cssText = 'width: 100%; height: 100%; border: 0; display: block; background: #000'

  host.appendChild(frame)
  document.body.appendChild(host)

  return {
    load(url) {
      frame.setAttribute('src', url)
    },
    blank() {
      frame.setAttribute('src', 'about:blank')
    },
    centre() {
      const rect = host.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    },
    destroy() {
      host.remove()
    },
  }
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

      const providers = options.providers()
      const verdicts: Record<string, ProbeVerdict> = {}
      /** Milliseconds to the first recognised media, for streaming providers only. */
      const timings: Record<string, number> = {}
      /** Best quality class offered, for streaming providers whose playlists say. */
      const qualities: Record<string, number> = {}
      /** Why each provider that did not stream failed, where the phone can tell. */
      const reasons: Record<string, ScanReason> = {}
      const total = providers.length

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
          // Always false here. The re-check exists to undo starvation caused by
          // probing several providers at once, and this side cannot do that —
          // one capture buffer means one provider at a time, so nothing it
          // measures was ever competing for bandwidth.
          confirming: false,
          finished,
          cancelled: finished && token !== mine,
        })
      }

      options.suspendPlayback()
      const surface = createProbeSurface()
      publish(providers[0] ?? null, false)

      try {
        for (const [index, provider] of providers.entries()) {
          if (token !== mine) break
          publish(provider, false)

          const url = renderTemplate(provider, request)
          if (url === null) {
            // The provider cannot express this request at all — no template for
            // this media type, or an id it needs and the title lacks. Nothing
            // to load, and nothing transient about it.
            verdicts[provider.id] = 'dead'
            continue
          }

          const measured = await probeOne(surface, url)
          verdicts[provider.id] = measured.verdict
          if (measured.ms !== null) timings[provider.id] = measured.ms
          if (measured.quality !== null) qualities[provider.id] = measured.quality

          // The last verdict goes out with the finished event; nothing follows
          // it, so there is nothing to settle for.
          const next = providers[index + 1]
          if (!next) break

          // Blank and settle *between* providers, so the next one starts
          // against an empty network rather than inheriting this one's tail.
          // The settle is the next provider's wait, so it is named: the picker
          // reads "Testing <current> (done + 1 of total)", and naming the one
          // just finished read one ahead — "Testing Videasy (5 of 4)".
          publish(next, false)
          surface.blank()
          if (token === mine) await sleep(BLANK_SETTLE_MS)
        }
      } finally {
        surface.destroy()
        options.resumePlayback()
        if (token === mine) running = false
      }

      const scan: ProviderScan = { titleKey, at: Date.now(), verdicts, timings, qualities }
      publish(null, true)
      return scan
    },
  }
}

/**
 * Whether any whole file named in the buffer really is a video.
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
 * Fetch a few captured requests and ask what they turned out to be.
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
  const fresh = candidates
    .filter((candidate) => !peeked.has(candidate.url))
    .sort((a, b) => b.atMs - a.atMs)
    .slice(0, Math.min(PEEKS_PER_POLL, PEEKS_PER_PROVIDER - peeked.size))

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
 * Load one provider and decide what happened.
 *
 * The capture buffer is emptied first, which is what makes "what is in it now"
 * attributable to this provider — given the caller has already stopped playback
 * and waited out the previous provider's tail.
 *
 * The distinction between `unsure` and `dead` is the distinction between the
 * page doing *something* and doing nothing. `MediaCapture` keeps plausible
 * candidates and drops the obvious non-media, so an empty buffer after fifteen
 * seconds means the page made no request that could have been a stream — a
 * shell with nothing behind it. A buffer with candidates in it that none of
 * which look like media means the player's backend answered and no stream
 * followed, which is often a bot challenge or a provider having a bad minute,
 * and is amber rather than red for the reason given on `ProbeVerdict`.
 */
async function probeOne(
  surface: ReturnType<typeof createProbeSurface>,
  url: string,
): Promise<{ verdict: ProbeVerdict; ms: number | null; quality: number | null }> {
  await capture.clear()
  surface.load(url)

  const startedAt = Date.now()
  let tapped = 0
  let sawAnything = false
  const peeked = new Set<string>()
  /** Bodies already fetched while deciding what a candidate was; reused for quality. */
  const bodies = new Map<string, string>()

  while (Date.now() - startedAt < PROBE_MS) {
    await sleep(POLL_MS)

    const elapsed = Date.now() - startedAt
    while (tapped < TAP_AT_MS.length && elapsed >= (TAP_AT_MS[tapped] ?? Infinity)) {
      tapped += 1
      const { x, y } = surface.centre()
      // A tap that fails is not a reason to abandon the provider: the plugin is
      // absent in the browser preview harness, where the rest still works.
      await Scan.tap({ x, y }).catch(() => {})
    }

    const candidates = await capture.list().catch(() => [])
    if (candidates.length > 0) sawAnything = true
    // Timed to the poll that noticed it, so it can read up to one poll interval
    // (half a second) later than the moment itself. The desktop times the
    // request directly, so the two platforms' figures are close, not equal.
    // A whole file by name must prove it is one; see `confirmWholeFiles`.
    const named = candidates.filter((candidate) => isMediaRequest(candidate.url))
    const streaming =
      named.some((candidate) => !WHOLE_FILE_URL.test(candidate.url)) ||
      (await confirmWholeFiles(named, peeked, bodies)) ||
      (await peekForMedia(candidates, peeked, bodies))
    if (streaming) {
      // Timed before the quality read, which is ours and not the provider's.
      const ms = Date.now() - startedAt
      return { verdict: 'stream', ms, quality: await readQuality(bodies) }
    }
  }

  return { verdict: sawAnything ? 'unsure' : 'dead', ms: null, quality: null }
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
 * Keeps watching the capture buffer for up to `QUALITY_WAIT_MS`, because the
 * playlist that proved the stream is not always the one that names sizes.
 */
async function readQuality(bodies: Map<string, string>): Promise<number | null> {
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
    for (const candidate of (await capture.list().catch(() => [])).sort((a, b) => a.atMs - b.atMs)) {
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
 * Whether a captured request is a playlist: by its URL, or — for the opaque
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
