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
import type { ProbeVerdict, ProviderScan, ProviderScanProgress, ScanReason } from '@shared/ipc'
import type { ProbeSubject } from './streamprobe'
import { probeQuality } from './qualityprobe'
import { providerRank } from '@shared/scanrank'
import { verdictForReason } from '@shared/scanreason'

/**
 * What each network verdict means for the user's dot is decided by its reason,
 * in `scanreason.ts`: a stream is green, a bot check amber, and everything the
 * test saw fail — a backend error, a refused segment, a timeout — red.
 *
 * That used to be softer. A 500 from the provider's own API was amber, on the
 * theory that it "is usually gone in an hour". Months of real use said
 * otherwise — VidFast answered 500 on every title for days — and on
 * 2026-09-26 it became red. What keeps red safe is the re-check below: any
 * red is probed again alone, with a longer budget, before it is believed.
 */
/** What one probe of one provider settles. */
interface Measured {
  verdict: ProbeVerdict
  ms: number | null
  quality: number | null
  /** Why it did not stream; null when it did. */
  reason: ScanReason | null
}

export interface ScanServiceOptions {
  /** The enabled providers, in the user's order. Read per run, not captured. */
  providers: () => Provider[]
  /** Wraps a provider URL in the local shell, exactly as the player does. */
  frameUrl: (providerUrl: string) => string
  /** Pushed after every provider settles, and once more at the end. */
  onProgress: (progress: ProviderScanProgress) => void
  /** Per-provider budget in the fan-out, from navigation start. See the default below. */
  timeoutMs?: number
  /** Per-provider budget when probing alone — the re-check, and the background tester. */
  soloTimeoutMs?: number
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
  /**
   * Measure one provider alone, for the background tester.
   *
   * Resolves with a one-provider result to merge with `recordScan`, or null
   * when a scan by hand started meanwhile: that scan measures this provider
   * too, and a result taken while it competed for bandwidth is the kind of
   * starved measurement the re-check exists to throw away.
   */
  probeOne(titleKey: string, subject: ProbeSubject, provider: Provider): Promise<ProviderScan | null>
  /** Stop scheduling further providers. */
  cancel(): void
  /** Whether a scan is in flight. */
  busy(): boolean
}

export function createScanService(options: ScanServiceOptions): ScanService {
  /**
   * Twenty seconds in the fan-out, twenty-five alone.
   *
   * The fan-out's budget was eighteen, set by 111Movies' series pages at
   * 12.0–15.3 s to their first media request. Two things moved it. A source
   * now has to deliver video, not just a playlist, which adds the first
   * segment to every start. And since 2026-09-26 a source slower than 20–25 s
   * is called out as a timeout rather than a vague "may work".
   *
   * The re-check gets the upper end of that range because it is where a false
   * red is caught, and slow sources exist: VidLux, probed alone on five titles,
   * streamed on all five at 8.5–19.2 s, after two of its own lookups failed
   * within the first second. CinemaOS, at 35.6 and 59.9 s when it streamed at
   * all, stays a timeout either way — which is the point.
   *
   * The budget is a ceiling, so a provider that streams sooner still finishes
   * sooner; what the extra seconds cost is the wait on providers that never
   * stream at all.
   */
  const timeoutMs = options.timeoutMs ?? 20_000
  const soloTimeoutMs = options.soloTimeoutMs ?? 25_000
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

  /**
   * One measurement: the verdict, how long the stream took to appear, the best
   * quality it offers, and why it failed if it did.
   *
   * The time is the probe's own `timeToMediaMs` — from the start of the load
   * to the first video — which is the moment the source stopped being a page
   * and started being a stream. Measured under the fan-out's contention, so it
   * is fair between providers of one scan rather than a figure for a quiet
   * line.
   *
   * The quality is `probeQuality`'s scan reading, which stops where the probe
   * always stopped; see `QualityMode` for why it must not linger.
   */
  const probe = async (provider: Provider, subject: ProbeSubject, budget: number): Promise<Measured> => {
    const result = await probeQuality(provider, subject, {
      mode: 'scan',
      timeoutMs: budget,
      frameUrl: options.frameUrl,
    })
    const streamed = result.verdict === 'stream'
    return {
      verdict: streamed || !result.reason ? 'stream' : verdictForReason(result.reason),
      ms: streamed ? result.timeToMediaMs : null,
      quality: streamed ? result.judgement.best : null,
      reason: streamed ? null : result.reason,
    }
  }

  return {
    busy: () => running,

    async probeOne(titleKey, subject, provider) {
      const before = token
      const measured = await probe(provider, subject, soloTimeoutMs)
      // A scan by hand started, or was cancelled, while this one ran.
      if (token !== before || running) return null
      const at = Date.now()
      const scan: ProviderScan = {
        titleKey,
        at,
        verdicts: { [provider.id]: measured.verdict },
        testedAt: { [provider.id]: at },
      }
      if (measured.ms !== null) scan.timings = { [provider.id]: measured.ms }
      if (measured.quality !== null) scan.qualities = { [provider.id]: measured.quality }
      if (measured.reason !== null) scan.reasons = { [provider.id]: measured.reason }
      return scan
    },

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
      /** Milliseconds to the first media request, kept for streaming providers only. */
      const timings: Record<string, number> = {}
      /** Best quality class offered, for streaming providers whose stream says. */
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
          const measured = await probe(provider, subject, timeoutMs)

          // Checked again after the await: the user may have cancelled during
          // the probe, and a late write would corrupt the next run's verdicts.
          if (token !== mine) return
          settle(provider, measured)
          publish(provider, false)
        }
      }

      await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker))

      /**
       * Re-check the reds, alone, with the longer budget.
       *
       * The fan-out above is the only thing that could have starved them, so
       * this pass removes that variable rather than adding a retry for its own
       * sake — a provider genuinely without the title fails here too, and keeps
       * its red dot.
       *
       * The better of the two results stands: streaming under either
       * condition proves the source can serve this title, and the question the
       * dot answers is whether it is worth the user's click. When both fail,
       * the solo result's reason stands, because it had the source to itself
       * and the longer budget — "timeout (25 s)" is the truer sentence.
       */
      confirming = true
      for (const provider of providers) {
        if (token !== mine) break
        if (verdicts[provider.id] !== 'dead') continue

        publish(provider, false)
        const second = await probe(provider, subject, soloTimeoutMs)
        if (token !== mine) break
        if (providerRank(undefined, second.verdict) <= providerRank(undefined, verdicts[provider.id])) {
          settle(provider, second)
        }
        publish(provider, false)
      }
      confirming = false

      const scan: ProviderScan = { titleKey, at: Date.now(), verdicts, testedAt, timings, qualities, reasons }
      if (token === mine) running = false
      publish(null, true)
      return scan
    },
  }
}
