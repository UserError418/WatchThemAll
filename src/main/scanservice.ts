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
 * ## Fan out, then re-check anything that died
 *
 * Contention is real and it was measured, against the shipped catalogue on one
 * title, nine providers:
 *
 * | at once | time  | verdicts                        |
 * |---------|-------|---------------------------------|
 * | 2       | 34.3s | 7 stream, 2 unsure, 0 dead      |
 * | 6       | 12.0s | 7 stream, 2 unsure, 0 dead      |
 * | 6 again | 12.0s | 6 stream, 2 unsure, 1 dead      |
 * | 9       | 12.1s | 4 stream, 3 unsure, 2 dead      |
 *
 * Two things follow. Going wider than six buys **nothing** — past that the
 * per-provider timeout is the floor rather than the queue — while costing
 * providers that demonstrably stream: one that worked at two and at six came
 * back dead at nine. And six is not perfectly clean either; a provider that
 * streamed on one run died on the next.
 *
 * A starved player is indistinguishable from a broken one, and the whole value
 * of the feature is the user trusting a red dot enough to stop trying that
 * source. So speed is taken from the fan-out and accuracy is bought back
 * afterwards: anything that comes back `dead` is probed again **on its own**,
 * with nothing to compete with, and the better of the two results stands.
 *
 * That keeps the common case — most sources working — at the fast path, and
 * only pays for the re-check on sources that looked broken, which are the ones
 * worth being right about. A title where everything is dead is the slow case,
 * and it is the case where being wrong is least acceptable.
 */

import type { Provider } from '@shared/types'
import type { ProbeVerdict, ProviderScan, ProviderScanProgress } from '@shared/ipc'
import { probeStream, type ProbeSubject, type StreamVerdict } from './streamprobe'
import { providerRank } from '@shared/scanrank'

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
  /** How many providers to measure at once. See the header for the measurements. */
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
  /**
   * Six, measured rather than chosen — see the table in the header. Wider is
   * not faster and is less accurate; narrower is three times slower for the
   * same answer.
   */
  const concurrency = Math.max(1, options.concurrency ?? 6)

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

      let confirming = false
      const publish = (provider: Provider | null, finished: boolean): void => {
        options.onProgress({
          titleKey,
          providerId: provider?.id ?? null,
          providerName: provider?.name ?? null,
          done: Object.keys(verdicts).length,
          total,
          verdicts: { ...verdicts },
          confirming,
          finished,
          cancelled: finished && token !== mine,
        })
      }

      const probe = async (provider: Provider): Promise<ProbeVerdict> => {
        const result = await probeStream(provider, subject, { timeoutMs, frameUrl: options.frameUrl })
        return VERDICT[result.verdict]
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
          const verdict = await probe(provider)

          // Checked again after the await: the user may have cancelled during
          // the probe, and a late write would corrupt the next run's verdicts.
          if (token !== mine) return
          verdicts[provider.id] = verdict
          publish(provider, false)
        }
      }

      await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker))

      /**
       * Re-check the dead ones, alone.
       *
       * The fan-out above is the only thing that could have starved them, so
       * this pass removes that variable rather than adding a retry for its own
       * sake — a provider genuinely without the title fails here too, and keeps
       * its red dot.
       *
       * The better of the two results stands. Streaming under either condition
       * proves the source can serve this title, and the question the dot
       * answers is whether it is worth the user's click.
       */
      confirming = true
      for (const provider of providers) {
        if (token !== mine) break
        if (verdicts[provider.id] !== 'dead') continue

        publish(provider, false)
        const second = await probe(provider)
        if (token !== mine) break
        if (providerRank(undefined, second) < providerRank(undefined, verdicts[provider.id])) {
          verdicts[provider.id] = second
        }
        publish(provider, false)
      }
      confirming = false

      const scan: ProviderScan = { titleKey, at: Date.now(), verdicts }
      if (token === mine) running = false
      publish(null, true)
      return scan
    },
  }
}
