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
 * 1. **Providers are measured one at a time.** The desktop runs two at once and
 *    could run more; here two providers in flight would put their requests in
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
import { isMediaRequest } from '@main/mediarequest'
import { renderTemplate } from '@main/providers'
import type { PlayRequest } from '@shared/ipc'
import { capture } from './cast'

interface ScanNative {
  /** A real touch at a point in the WebView. See `ScanPlugin`. */
  tap(options: { x: number; y: number }): Promise<void>
}

const Scan = registerPlugin<ScanNative>('Scan')

/**
 * How long to give one provider before calling it.
 *
 * Longer than the desktop's twelve seconds, and deliberately. The desktop runs
 * two probes at once and can afford a tight budget because a slow provider only
 * costs half a slot; here every second is on the critical path, but a phone is
 * also on a slower network and behind more radio latency. Fifteen was measured
 * as the point past which no provider in the shipped catalogue had ever
 * produced its first media request.
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
      const total = providers.length

      const publish = (provider: Provider | null, finished: boolean): void => {
        options.onProgress({
          titleKey,
          providerId: provider?.id ?? null,
          providerName: provider?.name ?? null,
          done: Object.keys(verdicts).length,
          total,
          verdicts: { ...verdicts },
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

          verdicts[provider.id] = await probeOne(surface, url)
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

      const scan: ProviderScan = { titleKey, at: Date.now(), verdicts }
      publish(null, true)
      return scan
    },
  }
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
): Promise<ProbeVerdict> {
  await capture.clear()
  surface.load(url)

  const startedAt = Date.now()
  let tapped = 0
  let sawAnything = false

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
    if (candidates.some((candidate) => isMediaRequest(candidate.url))) return 'stream'
  }

  return sawAnything ? 'unsure' : 'dead'
}
