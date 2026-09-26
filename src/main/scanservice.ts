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
 * ## Three at a time, reds tried twice
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
 * source. So a source that comes back `dead` is tested a second time with the
 * longer budget, and the better of the two results stands.
 *
 * Until 2026-09-26 that meant six at once and then every red **alone**, one
 * after another — and a scan with several reds spent most of its time in that
 * single file, which is what the user saw: "why is it sequential now?" What
 * they asked for instead is **three sources under test at every moment**, the
 * re-checks included. So there is one pool: every provider's first test goes
 * into a queue, a red goes back in for its second, and whenever a test ends
 * the next one starts until the queue is empty.
 *
 * Three rather than six for the same reason re-checks existed at all: the
 * table shows contention costing working sources their green at six and not
 * at two. A re-check no longer has the line to itself, so it is not the
 * clean-room test it was; what it keeps is the second, longer look, at half
 * the contention the first pass used to run at.
 */

import type { Provider, StreamDelivery } from '@shared/types'
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
  /** How the video arrived, for a source that streamed; null otherwise. See `StreamDelivery`. */
  delivery: StreamDelivery | null
}

/** One test the pool runs: a provider's first, or the second a red gets. */
interface Job {
  provider: Provider
  budgetMs: number
  /** A second test of a provider whose first came back red. */
  recheck: boolean
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
  /** The longer per-provider budget: a red's second test, and the background tester's. */
  longTimeoutMs?: number
  /** How many providers are under test at every moment. See the header. */
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
   * Twenty seconds for a first test, twenty-five for a second.
   *
   * The fan-out's budget was eighteen, set by 111Movies' series pages at
   * 12.0–15.3 s to their first media request. Two things moved it. A source
   * now has to deliver video, not just a playlist, which adds the first
   * segment to every start. And since 2026-09-26 a source slower than 20–25 s
   * is called out as a timeout rather than a vague "may work".
   *
   * The second test gets the upper end of that range because it is where a false
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
  const longTimeoutMs = options.longTimeoutMs ?? 25_000
  /** Three, as asked on 2026-09-26 — see the header for why not six. */
  const concurrency = Math.max(1, options.concurrency ?? 3)

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
      // A stream whose traffic showed nothing identifiable is still an answer
      // (`unknown`), so the tester does not keep coming back to ask.
      delivery: streamed ? (result.delivery ?? 'unknown') : null,
    }
  }

  return {
    busy: () => running,

    async probeOne(titleKey, subject, provider) {
      const before = token
      const measured = await probe(provider, subject, longTimeoutMs)
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
      if (measured.delivery !== null) scan.delivery = { [provider.id]: measured.delivery }
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
      /** How each streaming provider's video arrived. */
      const delivery: Record<string, StreamDelivery> = {}
      const total = providers.length

      /** What is under test right now, by provider, in the order it started. */
      const inFlight = new Map<string, Job>()

      const publish = (finished: boolean): void => {
        options.onProgress({
          titleKey,
          testing: [...inFlight.values()].map((job) => ({
            providerId: job.provider.id,
            providerName: job.provider.name,
            recheck: job.recheck,
          })),
          done: Object.keys(verdicts).length,
          total,
          verdicts: { ...verdicts },
          timings: { ...timings },
          qualities: { ...qualities },
          reasons: { ...reasons },
          delivery: { ...delivery },
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
        if (measured.delivery !== null) delivery[provider.id] = measured.delivery
        else delete delivery[provider.id]
      }

      /**
       * One test, and what its result means for the queue.
       *
       * A first test settles the provider's verdict at once, so its dot fills
       * in, and a red goes back in the queue for a second test with the longer
       * budget. The second test replaces the first only if it is at least as
       * good — streaming under either condition proves the source can serve
       * this title — and when both fail its reason stands, because it had the
       * longer budget: "timeout (25 s)" is the truer sentence.
       */
      const perform = async (job: Job): Promise<void> => {
        const measured = await probe(job.provider, subject, job.budgetMs)
        inFlight.delete(job.provider.id)
        // Checked after the await: the user may have cancelled during the
        // probe, and a late write would corrupt the next run's verdicts.
        if (token !== mine) return

        if (!job.recheck) {
          settle(job.provider, measured)
          // Not a source that cannot express this title: a missing template is
          // not something a busy line caused, and a second test cannot change it.
          if (measured.verdict === 'dead' && measured.reason?.kind !== 'unsupported') {
            queue.push({ provider: job.provider, budgetMs: longTimeoutMs, recheck: true })
          }
        } else if (providerRank(undefined, measured.verdict) <= providerRank(undefined, verdicts[job.provider.id])) {
          settle(job.provider, measured)
        }
        publish(false)
      }

      /**
       * First tests in the user's order; second tests join the end as reds
       * come in. A shared queue rather than chunks, because tests differ by an
       * order of magnitude — a dead host fails in under a second while a
       * working provider uses its whole budget — and a chunk waits for its
       * slowest member.
       */
      const queue: Job[] = providers.map((provider) => ({ provider, budgetMs: timeoutMs, recheck: false }))
      /** The probes in progress, so the loop can wait for whichever ends first. */
      const tasks = new Set<Promise<void>>()

      publish(false)
      while (queue.length > 0 || tasks.size > 0) {
        // Keep the pool full. Once the run is cancelled nothing new starts, but
        // what is already running is let finish: a probe cannot be interrupted.
        while (token === mine && tasks.size < concurrency) {
          const job = queue.shift()
          if (!job) break
          inFlight.set(job.provider.id, job)
          const task: Promise<void> = perform(job).finally(() => tasks.delete(task))
          tasks.add(task)
          publish(false)
        }
        if (token !== mine) queue.length = 0
        if (tasks.size === 0) break
        await Promise.race(tasks)
      }

      const scan: ProviderScan = { titleKey, at: Date.now(), verdicts, testedAt, timings, qualities, reasons, delivery }
      if (token === mine) running = false
      publish(true)
      return scan
    },
  }
}
