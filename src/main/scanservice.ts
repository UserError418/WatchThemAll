/**
 * Running a provider scan on the desktop.
 *
 * `providerscan.ts` decides what a verdict *means*; this decides how to get
 * one. It is the Electron half, and the only part of the feature the phone does
 * not share — see `mobile/src/bridge/scan.ts` for the WebView equivalent, which
 * answers the same question through a different keyhole.
 *
 * ## Why this reuses `streamprobe` rather than `probeui`
 *
 * There are two existing ways to measure a provider and they are not
 * interchangeable here.
 *
 * `probeui.probeThroughPlayer` is the better measurement: it drives the real
 * player and asks whether the video *advances*, which nothing can fake. It is
 * also unusable for this feature, and its own header says why — it needs a
 * **shown** window. A video element in a window with no rendering lifecycle
 * never reports a moving position, so the check would report every provider as
 * broken. A feature whose entire premise is "in the background" cannot open a
 * dozen visible windows across the user's desktop to find out.
 *
 * `streamprobe.probeStream` works hidden, because it watches the network rather
 * than the picture, and bytes move without anything being painted. It is a
 * weaker claim — a manifest was fetched, not a frame was shown — and that is
 * exactly why the verdict it produces is called `stream` rather than `playing`.
 * It also already presses play in every frame, which is the requirement that
 * kills every cheaper approach: several providers resolve nothing at all until
 * something clicks.
 *
 * ## Concurrency is deliberately low
 *
 * Two at a time. The temptation is to fan out across all twelve and finish in
 * fifteen seconds, and it produces a measurement of the user's bandwidth rather
 * than of the providers: a dozen HLS players starting at once starve each
 * other, and a starved player looks exactly like a broken one. Since the whole
 * value of this feature is the user trusting a red dot enough not to try that
 * source, a false red is the most expensive thing it can produce.
 *
 * Two still cuts a twelve-provider scan from around two and a half minutes to
 * about seventy seconds, which is the difference between a feature people use
 * and one they cancel.
 */

import type { Provider } from '@shared/types'
import type { ProbeVerdict, ProviderScan, ProviderScanProgress } from '@shared/ipc'
import { probeStream, type ProbeSubject, type StreamVerdict } from './streamprobe'

/**
 * What each network verdict means for the user's dot.
 *
 * The grouping is by *what the user should do about it*, which is not the same
 * as how severe it sounds:
 *
 * - `stream` is the only green. Media was fetched; the source works.
 * - `blocked` and `api-error` are amber, because both are the provider having a
 *   bad moment rather than the provider lacking the title. A challenge page
 *   often passes in the real player, which carries cookies this throwaway
 *   session does not, and a 500 from the provider's own API is usually gone in
 *   an hour. Telling the user to give up on those would be wrong.
 * - Everything else is red. `no-media` is the common, genuine case — the
 *   player's backend answered and had nothing to serve, which is a catalogue
 *   gap and precisely the fact the user wants surfaced. `no-template` is
 *   definitive rather than transient: the provider cannot express this request
 *   at all.
 */
const VERDICT: Record<StreamVerdict, ProbeVerdict> = {
  stream: 'stream',
  blocked: 'unsure',
  'api-error': 'unsure',
  'no-media': 'dead',
  empty: 'dead',
  unreachable: 'dead',
  'no-template': 'dead',
}

export interface ScanServiceOptions {
  /** The enabled providers, in the user's order. Read per run, not captured. */
  providers: () => Provider[]
  /** Wraps a provider URL in the local shell, exactly as the player does. */
  frameUrl: (providerUrl: string) => string
  /** Pushed after every provider settles, and once more at the end. */
  onProgress: (progress: ProviderScanProgress) => void
  /** Per-provider budget. The default matches the CLI probe's. */
  timeoutMs?: number
  /** How many providers to measure at once. See the header on why this is low. */
  concurrency?: number
}

export interface ScanService {
  /**
   * Measure every enabled provider against one title.
   *
   * Resolves with whatever settled, including on cancellation — a partial scan
   * is still worth keeping, because the providers it did reach were genuinely
   * measured.
   */
  run(titleKey: string, subject: ProbeSubject): Promise<ProviderScan>
  /** Stop scheduling further providers. */
  cancel(): void
  /** Whether a scan is in flight. */
  busy(): boolean
}

export function createScanService(options: ScanServiceOptions): ScanService {
  const timeoutMs = options.timeoutMs ?? 12_000
  const concurrency = Math.max(1, options.concurrency ?? 2)

  /**
   * Identifies the run, so a cancelled scan's stragglers cannot write.
   *
   * `probeStream` cannot be interrupted — it owns a hidden window talking to a
   * hostile page, and its watchdog is what guarantees it ever returns at all.
   * So cancelling stops *scheduling* and abandons the results still in flight.
   * Without a token those late results would land in the next scan's verdicts,
   * attributing one title's measurement to another.
   */
  let token = 0
  let running = false

  return {
    busy: () => running,

    cancel() {
      token += 1
      running = false
    },

    async run(titleKey, subject) {
      // A second scan supersedes the first rather than racing it: two scans
      // would compete for the bandwidth each is trying to measure.
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

      publish(providers[0] ?? null, false)

      /**
       * A shared queue rather than a chunked `Promise.all`.
       *
       * Chunking into pairs makes every pair wait for its slower half, and
       * these differ by an order of magnitude — a dead host fails in under a
       * second while a working provider uses its whole budget. Measured across
       * the shipped catalogue that idles a worker for roughly a third of the
       * run.
       */
      let next = 0
      const worker = async (): Promise<void> => {
        while (token === mine) {
          const provider = providers[next]
          next += 1
          if (!provider) return

          publish(provider, false)
          const result = await probeStream(provider, subject, { timeoutMs, frameUrl: options.frameUrl })

          // Checked again after the await: the user may have cancelled during
          // the probe, and a late write would corrupt the next run's verdicts.
          if (token !== mine) return
          verdicts[provider.id] = VERDICT[result.verdict]
          publish(provider, false)
        }
      }

      await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker))

      const scan: ProviderScan = { titleKey, at: Date.now(), verdicts }
      if (token === mine) running = false
      publish(null, true)
      return scan
    },
  }
}
