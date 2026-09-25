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
import type { ProbeVerdict, ProviderScan, ProviderScanProgress } from '@shared/ipc'
import { isMediaRequest, isMediaResponse } from '@main/mediarequest'
import { renderTemplate } from '@main/providers'
import type { PlayRequest } from '@shared/ipc'
import { capture, type Candidate } from './cast'
import { bestQuality, readLadder } from '@shared/streamquality'

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
        for (const provider of providers) {
          if (token !== mine) break
          publish(provider, false)

          const url = renderTemplate(provider, request)
          if (url === null) {
            // The provider cannot express this request at all — no template for
            // this media type, or an id it needs and the title lacks. Nothing
            // to load, and nothing transient about it.
            verdicts[provider.id] = 'dead'
            publish(provider, false)
            continue
          }

          const measured = await probeOne(surface, url)
          verdicts[provider.id] = measured.verdict
          if (measured.ms !== null) timings[provider.id] = measured.ms
          if (measured.quality !== null) qualities[provider.id] = measured.quality
          publish(provider, false)

          // Blank and settle *between* providers, so the next one starts
          // against an empty network rather than inheriting this one's tail.
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
    const streaming =
      candidates.some((candidate) => isMediaRequest(candidate.url)) ||
      (await peekForMedia(candidates, peeked, bodies))
    if (streaming) {
      // Timed before the quality read, which is ours and not the provider's.
      const ms = Date.now() - startedAt
      return { verdict: 'stream', ms, quality: await readQuality(candidates, bodies) }
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
 * The parser is the desktop's, from `shared/`, so a playlist reads the same on
 * both.
 */
async function readQuality(candidates: Candidate[], bodies: Map<string, string>): Promise<number | null> {
  const playlists = candidates
    .filter((candidate) => PLAYLIST_URL.test(candidate.url) || bodies.has(candidate.url))
    .sort((a, b) => a.atMs - b.atMs)
    .slice(0, QUALITY_PEEKS)

  const read = await Promise.all(
    playlists.map(async (candidate) => {
      const known = bodies.get(candidate.url)
      if (known !== undefined) return known
      const response = await capture.peek(candidate).catch(() => null)
      return response && (response.status === 200 || response.status === 206) ? response.body : ''
    }),
  )
  const offered = read.map((body) => bestQuality(readLadder(body))).filter((q): q is number => q !== null)
  return offered.length > 0 ? Math.max(...offered) : null
}
