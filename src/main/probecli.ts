/**
 * The `--probe-providers` mode.
 *
 * Runs the stream probe over the whole catalogue and prints a report, then
 * quits. It lives inside the app's own main process rather than as a separate
 * Electron entry point for one reason: `probeStream` needs a real browser, and
 * the app is already a real browser with a working build. A second entry point
 * would mean a second bundling target that could drift from this one.
 *
 *   npm run probe:providers
 *   npm run probe:providers -- --json report.json --verbose --only vidsrc-me
 *
 * The exit code is deliberately 0 even when providers fail. A dead third-party
 * host is information, not a build error — wiring this into CI as a gate would
 * mean an unrelated outage blocks every commit.
 */

import { app, BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Provider } from '@shared/types'
import {
  probeStream,
  type ProbeSubject,
  type StreamProbeResult,
  type StreamVerdict,
} from './streamprobe'
import { extractStream, type ExtractResult } from './streamextract'
import { probeThroughPlayer, score, type UiProbeResult, type UiProbeScore } from './probeui'
import { probeQuality, type QualityProbeResult } from './qualityprobe'
import type { QualityOutcome } from '@shared/streamquality'
import { playerShellUrl, startRendererServer, stopRendererServer } from './localserver'

/**
 * The canaries.
 *
 * Chosen so that a `no-media` verdict means the provider is broken rather than
 * the title being obscure: one of the most-indexed series ever made, one
 * enormously popular film. Both are old enough that every catalogue has had
 * years to acquire them, and a provider that cannot serve these cannot serve
 * anything.
 *
 * Two of each type rather than one of each, and that pair is the point. A
 * single failure is ambiguous: when MoviesAPI answered
 * `/api/vidora/v1/tv/tt0903747/1/1` with a 404, that could equally mean the
 * provider is broken or that it simply does not carry Breaking Bad. Deleting a
 * provider from the catalogue on one canary would eventually delete a working
 * one over a single missing title. Two independent, near-universally-available
 * titles per media type make "fails everything" separable from "has a gap".
 */
export const CANARIES: ProbeSubject[] = [
  {
    imdbId: 'tt0903747',
    tmdbId: 1396,
    type: 'tv',
    season: 1,
    episode: 1,
    label: 'Breaking Bad S01E01',
    runtimeMinutes: 58,
  },
  {
    imdbId: 'tt0386676',
    tmdbId: 2316,
    type: 'tv',
    season: 1,
    episode: 1,
    label: 'The Office S01E01',
    runtimeMinutes: 23,
  },
  {
    imdbId: 'tt0944947',
    tmdbId: 1399,
    type: 'tv',
    season: 1,
    episode: 1,
    label: 'Game of Thrones S01E01',
    runtimeMinutes: 62,
  },
  {
    imdbId: 'tt4574334',
    tmdbId: 66732,
    type: 'tv',
    season: 1,
    episode: 1,
    label: 'Stranger Things S01E01',
    runtimeMinutes: 49,
  },
  {
    imdbId: 'tt14688458',
    tmdbId: 125988,
    type: 'tv',
    season: 1,
    episode: 1,
    label: 'Silo S01E01',
    runtimeMinutes: null,
  },
  { imdbId: 'tt0137523', tmdbId: 550, type: 'movie', label: 'Fight Club', runtimeMinutes: 139 },
  { imdbId: 'tt1375666', tmdbId: 27205, type: 'movie', label: 'Inception', runtimeMinutes: 148 },
  { imdbId: 'tt0133093', tmdbId: 603, type: 'movie', label: 'The Matrix', runtimeMinutes: 136 },
  {
    imdbId: 'tt0816692',
    tmdbId: 157336,
    type: 'movie',
    label: 'Interstellar',
    runtimeMinutes: 169,
  },
  { imdbId: 'tt1160419', tmdbId: 438631, type: 'movie', label: 'Dune', runtimeMinutes: 155 },
]

/**
 * Canaries that can tell the *right* title from *a* title.
 *
 * The set above answers "does this provider serve anything", and is built for
 * that: every series is asked for at S01E01, which is exactly the one request
 * a wrong template still gets right. A provider that ignores the season and
 * episode serves S01E01 whatever it is asked for; one that reads a TMDB id as
 * an IMDB id, or a series id as a film id, serves some other programme — and
 * both play, so both score as working.
 *
 * These are chosen so the wrong answer is a different *length*, which is the
 * one fact about what played that the probe can read. Each series canary is a
 * late episode that runs far longer than its show's pilot:
 *
 * | title                      | asked for | pilot  |
 * |----------------------------|-----------|--------|
 * | Stranger Things S04E09     | 143 min   | 48 min |
 * | Game of Thrones S08E03     | 82 min    | 62 min |
 *
 * so an ignored episode number fails the runtime check rather than passing it.
 * Runtimes are TMDB's own, looked up rather than remembered — an invented
 * number would condemn providers over a guess.
 *
 * Two anime canaries, for two different failures:
 *
 * - **One Piece** shares its name with a live-action adaptation that runs
 *   twice as long. A backend that looks titles up by name rather than by id
 *   serves the live-action episode for the anime's id — measured on the
 *   peakstorm backend behind Videasy — and only the length gives it away.
 * - **Frieren** is there for coverage: whether the provider serves anime
 *   through its TV endpoint at all. Every episode of it runs about the same,
 *   so which episode played still needs a person looking at the picture.
 */
export const CONTENT_CANARIES: ProbeSubject[] = [
  {
    imdbId: 'tt4574334',
    tmdbId: 66732,
    type: 'tv',
    season: 4,
    episode: 9,
    label: 'Stranger Things S04E09',
    runtimeMinutes: 143,
  },
  {
    imdbId: 'tt0944947',
    tmdbId: 1399,
    type: 'tv',
    season: 8,
    episode: 3,
    label: 'Game of Thrones S08E03',
    runtimeMinutes: 82,
  },
  { imdbId: 'tt0137523', tmdbId: 550, type: 'movie', label: 'Fight Club', runtimeMinutes: 139 },
  {
    imdbId: 'tt0388629',
    tmdbId: 37854,
    type: 'tv',
    season: 1,
    episode: 5,
    label: 'One Piece (anime) S01E05',
    runtimeMinutes: 25,
  },
  {
    imdbId: 'tt22248376',
    tmdbId: 209867,
    type: 'tv',
    season: 1,
    episode: 5,
    label: 'Frieren S01E05',
    runtimeMinutes: 25,
  },
]

/**
 * A title that fails on *every* provider is evidence about the title.
 *
 * The canaries carry hand-written TMDB and IMDB ids, and one mistyped id makes
 * every provider look like it has a gap. Catalogues also genuinely differ,
 * which is the reason there is a list here rather than one title — so the
 * report has to separate "this provider does not carry it" from "this id is
 * wrong". Unanimity across unrelated providers is the signal: they do not all
 * lose the same title on the same day, but they do all fail a bad id.
 */
export function suspectCanaries(
  results: { subject: { label: string }; verdict: StreamVerdict }[],
  workingProviderCount: number,
): string[] {
  if (workingProviderCount < 2) return []
  const byLabel = new Map<string, { total: number; ok: number }>()
  for (const result of results) {
    const seen = byLabel.get(result.subject.label) ?? { total: 0, ok: 0 }
    seen.total += 1
    if (result.verdict === 'stream') seen.ok += 1
    byLabel.set(result.subject.label, seen)
  }
  return [...byLabel.entries()]
    .filter(([, seen]) => seen.ok === 0 && seen.total >= workingProviderCount)
    .map(([label]) => label)
}

/** Single-character marks, so a wide table stays readable. */
const MARK: Record<StreamVerdict, string> = {
  stream: '✓',
  'no-media': '·',
  empty: '∅',
  'api-error': '!',
  blocked: '⊘',
  unreachable: '✗',
  'no-template': '–',
}

interface CliOptions {
  /**
   * Run against only the first N canaries.
   *
   * Ten titles is the right number for a verdict and the wrong number for
   * "does this harness work at all", which is a question worth being able to
   * ask in thirty seconds.
   */
  titles: number | null
  json: string | null
  /**
   * A candidate catalogue to probe instead of the bundled one.
   *
   * This is what makes evaluating a *new* provider a one-command job rather
   * than an edit-build-run cycle against the shipped list. Write the candidates
   * to a file, probe them, and add only what measured as working — which is the
   * discipline that took the catalogue from fourteen entries to seven.
   */
  catalog: string | null
  /**
   * Stop a provider's run at its first streaming canary.
   *
   * Once a provider has demonstrably streamed, the remaining canaries only
   * measure *coverage* — and while triaging a candidate list the question is
   * only alive-or-dead. Coverage is worth measuring on the shortlist, with a
   * full run; paying for it across two dozen unknowns is how a sweep ends up
   * taking an hour.
   */
  fast: boolean
  verbose: boolean
  only: string[]
  /**
   * Per-title budget. Null means the mode's own default, because the modes
   * need different ones: the network probe calls it at the first manifest,
   * while the UI probe has to wait for a picture that moves. A single shared
   * default silently gave the UI probe the network probe's twelve seconds.
   */
  timeoutMs: number | null
  /**
   * Which titles to ask for. `--canaries content` swaps in the set that can
   * tell a wrong template from a right one; see `CONTENT_CANARIES`.
   */
  canaries: ProbeSubject[]
  /** UI probe only: write a screenshot of each title that plays into this directory. */
  evidence: string | null
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    json: null,
    catalog: null,
    fast: false,
    verbose: false,
    only: [],
    timeoutMs: null,
    titles: null,
    canaries: CANARIES,
    evidence: null,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = argv[++i] ?? null
    else if (arg === '--catalog') options.catalog = argv[++i] ?? null
    else if (arg === '--fast') options.fast = true
    else if (arg === '--verbose') options.verbose = true
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++i]) || null
    else if (arg === '--canaries') {
      const set = argv[++i]
      if (set === 'content') options.canaries = CONTENT_CANARIES
      else if (set !== 'default') throw new Error(`--canaries takes "default" or "content", not "${set}"`)
    }
    else if (arg === '--only') options.only.push(...(argv[++i] ?? '').split(','))
    else if (arg === '--titles') options.titles = Number(argv[++i]) || null
    else if (arg === '--evidence') options.evidence = argv[++i] ?? null
  }

  return options
}

/**
 * Probe every provider against every canary and print the result.
 *
 * Sequential on purpose. Running these in parallel would have a dozen video
 * players competing for bandwidth on one connection, and a provider that is
 * merely slow would be recorded as having no stream — turning a measurement
 * into a race.
 */
export async function runProbeCli(providers: Provider[], argv: string[]): Promise<void> {
  const options = parseArgs(argv)
  const catalogue = options.catalog ? readCandidateCatalog(options.catalog) : providers
  const targets = options.only.length
    ? catalogue.filter((p) => options.only.includes(p.id))
    : catalogue

  console.log(`\nProbing ${targets.length} provider(s) against ${options.canaries.length} canaries.`)
  console.log('A verdict of "stream" means a media manifest or segment was actually requested.\n')

  /**
   * Load each provider inside the same local shell the player uses.
   *
   * The app stopped navigating to provider URLs at the top level once Videasy
   * began answering 403 to anything whose `Sec-Fetch-Dest` was `document`. A
   * probe that still navigates directly measures a path no user takes, and
   * would have reported Videasy dead while it worked fine in the app.
   *
   * The server serves nothing but the shell here — no renderer is built for a
   * probe run — which is harmless: the shell route is matched before the
   * static file path.
   */
  const shellBaseUrl = await startRendererServer(join(app.getAppPath(), 'out/renderer'))
  const frameUrl = (providerUrl: string): string => playerShellUrl(shellBaseUrl, providerUrl)

  const results: StreamProbeResult[] = []

  for (const provider of targets) {
    const marks: string[] = []
    const detail: string[] = []

    for (const subject of options.canaries) {
      // Progress on stderr so a long run shows life without polluting the
      // report on stdout, which is what gets redirected to a file.
      process.stderr.write(`  … ${provider.id} / ${subject.label}\n`)
      const result = await probeStream(provider, subject, {
        timeoutMs: options.timeoutMs ?? 12_000,
        verbose: options.verbose,
        frameUrl,
      })
      results.push(result)
      marks.push(MARK[result.verdict])

      if (result.verdict !== 'stream')
        detail.push(`${subject.label.split(' ')[0]}:${result.verdict}`)
      if (options.fast && result.verdict === 'stream') break
    }

    /**
     * The verdict for the *provider*, as opposed to for one title.
     *
     * A provider that streams any canary works; the rest is coverage. This is
     * the number that decides whether an entry stays in the catalogue, and it
     * deliberately forgives gaps — a provider missing one show is normal, and
     * the fallback chain exists precisely to cover that.
     */
    // Not `slice(-options.canaries.length)`: `--fast` stops early, so the number of
    // results this provider contributed is however many marks it produced.
    const mine = results.slice(-marks.length)
    const streamed = mine.filter((r) => r.verdict === 'stream')
    const fastest = streamed.length
      ? `${Math.min(...streamed.map((r) => r.timeToMediaMs ?? Infinity))}ms`
      : '—'
    const health = streamed.length === 0 ? 'DEAD' : `${streamed.length}/${mine.length}`

    const redirect = mine.find((r) => r.redirectedTo)?.redirectedTo
    const note = redirect ? `  → ${new URL(redirect).origin}` : ''
    console.log(
      `  ${marks.join(' ')}  ${provider.id.padEnd(16)} ${health.padEnd(6)} ${fastest.padEnd(8)} ` +
        `${detail.join(' ').padEnd(40)}${note}`,
    )
  }

  stopRendererServer()
  summarise(results)

  if (options.json) {
    await writeFile(options.json, JSON.stringify(results, null, 2))
    console.log(`\nFull report written to ${options.json}`)
  }
}

function summarise(results: StreamProbeResult[]): void {
  const byVerdict = new Map<StreamVerdict, string[]>()
  for (const r of results) {
    const key = `${r.providerId}/${r.url?.includes('/movie') || r.url?.includes('movie') ? 'movie' : 'tv'}`
    byVerdict.set(r.verdict, [...(byVerdict.get(r.verdict) ?? []), key])
  }

  console.log('\n─── Summary ───')
  for (const verdict of [
    'stream',
    'no-media',
    'api-error',
    'blocked',
    'empty',
    'unreachable',
    'no-template',
  ] as const) {
    const hits = byVerdict.get(verdict)
    if (hits?.length)
      console.log(
        `  ${MARK[verdict]} ${verdict.padEnd(12)} ${hits.length.toString().padStart(2)}  ${hits.join(' ')}`,
      )
  }

  /**
   * Mirrors, detected rather than declared.
   *
   * Two providers that fetch their video from the same CDN host are two doors
   * onto one backend, whatever their front pages look like. That matters
   * because the fallback chain must try a *different* backend after a failure —
   * another door onto the one that just failed will fail identically, and the
   * shipped catalogue had six of fourteen entries behind one backend.
   *
   * Measuring this beats hand-maintaining a `group` field, which is a claim
   * about infrastructure nobody outside the provider can see and which goes
   * quietly stale the moment one of them re-points their DNS.
   */
  const hostsByProvider = new Map<string, Set<string>>()
  for (const r of results) {
    for (const sample of r.mediaSamples) {
      if (!sample.startsWith('http')) continue
      const host = new URL(sample).hostname
      // Strip one label so `s2.` and `s4.streamflixapi.site` count as one CDN.
      const registrable = host.split('.').slice(-2).join('.')
      hostsByProvider.set(
        r.providerId,
        (hostsByProvider.get(r.providerId) ?? new Set()).add(registrable),
      )
    }
  }

  const providersByHost = new Map<string, Set<string>>()
  for (const [providerId, hosts] of hostsByProvider) {
    for (const host of hosts) {
      providersByHost.set(host, (providersByHost.get(host) ?? new Set()).add(providerId))
    }
  }

  const mirrors = [...providersByHost.entries()].filter(([, ids]) => ids.size > 1)
  if (mirrors.length) {
    console.log('\n─── Same backend (group these, or the fallback chain wastes its time) ───')
    for (const [host, ids] of mirrors) {
      console.log(`  ${host.padEnd(28)} ${[...ids].join(', ')}`)
    }
  } else if (hostsByProvider.size > 1) {
    console.log('\n─── Backends ───')
    for (const [providerId, hosts] of hostsByProvider) {
      console.log(`  ${providerId.padEnd(16)} ${[...hosts].join(', ')}`)
    }
    console.log('  No two providers share a stream host, so no grouping is needed.')
  }

  /**
   * Redirects are worth surfacing separately from the verdict.
   *
   * A provider that redirects still works, so it is not a failure — but the
   * catalogue is pointing at a domain the operator has already moved off, and
   * that old domain is exactly what stops resolving first. Following it now is
   * free; following it after it dies is a support ticket.
   */
  const moved = results.filter(
    (r) => r.redirectedTo && new URL(r.redirectedTo).origin !== new URL(r.url!).origin,
  )
  if (moved.length) {
    console.log('\n─── Stale domains (still work, but the catalogue is behind) ───')
    for (const r of moved) {
      console.log(
        `  ${r.providerId.padEnd(16)} ${new URL(r.url!).origin}  →  ${new URL(r.redirectedTo!).origin}`,
      )
    }
  }
}

/** True when the process was started to probe rather than to run the app. */
/**
 * Read a candidate list from disk.
 *
 * Accepts both catalogue shapes — a bare array, and the `{version, providers}`
 * document the managed list uses — so a file fetched straight from the
 * published catalogue can be probed without reshaping it by hand.
 */
function readCandidateCatalog(path: string): Provider[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as { providers?: unknown }).providers ?? [])
  if (!Array.isArray(list)) {
    throw new Error(`${path} is neither a provider array nor a catalogue document`)
  }
  return list as Provider[]
}

/**
 * The `--extract-streams` mode.
 *
 * A sibling of the probe above, answering the next question along. The probe
 * asks whether a manifest appears at all; this asks whether that manifest is
 * usable by anything other than the page that produced it — which is what
 * decides whether the app can ever own its own `<video>` element, and with it
 * resume-to-position, stall detection and the auto-switch on both platforms.
 *
 *   npm run probe:streams
 *   npm run probe:streams -- --only videasy --json extract.json
 */
export async function runExtractCli(providers: Provider[], argv: string[]): Promise<void> {
  const options = parseArgs(argv)
  const targets = options.only.length
    ? providers.filter((p) => options.only.includes(p.id))
    : providers.filter((p) => p.tier === 'core')

  // One subject, not the canary set: this measures the *shape* of a provider's
  // stream URLs, which does not vary by title, and each probe costs 20 seconds.
  const subject = CANARIES.find((c) => c.type === 'movie')
  if (!subject) throw new Error('no movie canary to extract with')

  console.log(`\nExtracting from ${targets.length} provider(s) using ${subject.label}.`)
  console.log(
    "open = fetches bare · header-gated = needs the page's Referer · sealed = unusable outside the page\n",
  )

  const results: ExtractResult[] = []
  for (const provider of targets) {
    process.stderr.write(`  … ${provider.id}\n`)
    const result = await extractStream(provider, subject, options.timeoutMs ?? 12_000, options.verbose)
    results.push(result)

    const bits = [
      result.verdict.padEnd(13),
      result.stream ? result.stream.kind.padEnd(11) : '—'.padEnd(11),
      `bare:${result.bareStatus ?? '—'}`.padEnd(10),
      `replay:${result.replayStatus ?? '—'}`.padEnd(12),
      result.segmentOk === null ? '' : `segment:${result.segmentOk ? 'ok' : 'FAIL'}`,
    ]
    console.log(`${provider.name.padEnd(14)} ${bits.join(' ')}`)
    if (result.stream) {
      console.log(`               ${result.stream.url.slice(0, 110)}`)
      const referer = result.stream.headers['Referer'] ?? result.stream.headers['referer']
      const origin = result.stream.headers['Origin'] ?? result.stream.headers['origin']
      const cookie = result.stream.headers['Cookie'] ?? result.stream.headers['cookie']
      console.log(
        `               referer=${referer ?? '—'} origin=${origin ?? '—'} cookie=${cookie ? 'yes' : 'no'} at ${result.stream.foundAtMs}ms`,
      )
    }
    if (result.error) console.log(`               error: ${result.error}`)
  }

  const usable = results.filter((r) => r.verdict === 'open' || r.verdict === 'header-gated')
  console.log(
    `\n${usable.length}/${results.length} provider(s) yield a stream URL usable outside their page.`,
  )

  if (options.json) {
    await writeFile(options.json, JSON.stringify(results, null, 2))
    console.log(`Wrote ${options.json}`)
  }
}

/**
 * The `--probe-ui` mode: reachability as the user experiences it.
 *
 * Same catalogue, same providers, different question. `--probe-providers` asks
 * "did a manifest go over the wire"; this asks "did the picture move". The
 * second is the one a user would recognise, and it is measured by driving the
 * real player rather than a replica of it — see `probeui.ts` for why that
 * distinction stopped being academic the day the ad blocker landed.
 *
 *   npm run probe:ui
 *   npm run probe:ui -- --only videasy --timeout 45000
 *   npm run probe:ui -- --canaries content --catalog candidates.json --evidence /tmp/shots
 */
export async function runUiProbeCli(providers: Provider[], argv: string[]): Promise<void> {
  const options = parseArgs(argv)
  const catalogue = options.catalog ? readCandidateCatalog(options.catalog) : providers
  const targets = options.only.length
    ? catalogue.filter((p) => options.only.includes(p.id))
    : catalogue

  const subjects = options.canaries.slice(0, Math.max(1, options.titles ?? options.canaries.length))

  console.log(`\nPlaying ${subjects.length} titles on ${targets.length} provider(s), for real.`)
  console.log('A tick means the video reported a position that advanced.\n')

  const shellBaseUrl = await startRendererServer(join(app.getAppPath(), 'out/renderer'))
  const frameUrl = (providerUrl: string): string => playerShellUrl(shellBaseUrl, providerUrl)
  const dirname = join(app.getAppPath(), 'out/main')

  /**
   * One window that outlives the whole run, and it is not decoration.
   *
   * Each probe opens a window, plays into it and destroys it. Destroying the
   * last window fires `window-all-closed`, which `index.ts` answers by quitting
   * — so without this the process exits silently, with status 0, after the
   * first title. It printed the header and nothing else, which reads exactly
   * like "no providers matched" rather than like "the app shut itself down".
   */
  const keepalive = new BrowserWindow({ show: false, width: 1, height: 1 })

  const scores: UiProbeScore[] = []
  const every: UiProbeResult[] = []

  /**
   * Progress goes to stderr, per title, as each one finishes.
   *
   * The summary below is per *provider*, which at ten titles and a sixty
   * second timeout means up to ten minutes of a run producing no output at
   * all. A full catalogue sweep was killed at seventy minutes having printed
   * only its header, which reads exactly like "no providers matched" rather
   * than like "still working". Stderr so a `--json` run or a pipe still sees
   * only the report.
   */
  const progress = (line: string): void => {
    process.stderr.write(`${line}\n`)
  }

  for (const [index, provider] of targets.entries()) {
    const results: UiProbeResult[] = []
    const marks: string[] = []
    progress(`\n[${index + 1}/${targets.length}] ${provider.id}`)
    for (const subject of subjects) {
      const startedAt = Date.now()
      const result = await probeThroughPlayer({
        provider,
        subject,
        frameUrl,
        dirname,
        timeoutMs: options.timeoutMs ?? 30_000,
        evidenceDir: options.evidence ?? undefined,
      })
      results.push(result)
      every.push(result)
      // A tick means it played; a warning means it played the wrong *length*,
      // which is worse than not playing at all because it looks like success.
      const mark = result.played ? (result.runtime === 'implausible' ? '⚠' : '✓') : '·'
      marks.push(mark)
      const seconds = Math.round((Date.now() - startedAt) / 1000)
      // The delivered length on every line that played, not only the wrong
      // ones: "143m of 143m" is the evidence that a template is right, and a
      // bare tick is only evidence that something played.
      const length = result.played
        ? `${Math.round(result.duration / 60)}m of ${subject.runtimeMinutes ?? '?'}m`
        : (result.reason ?? '')
      progress(`      ${mark} ${subject.label.padEnd(28)} ${String(seconds).padStart(3)}s  ${length}`)
      for (const frame of result.evidence?.frames ?? []) progress(`          ${frame.slice(0, 150)}`)
      if (result.evidence?.screenshot) progress(`          ${result.evidence.screenshot}`)
    }

    const summary = score(provider.id, results)
    scores.push(summary)
    const failed = results
      .filter((r) => !r.played)
      .map((r) => r.subject.label.split(' ')[0])
      .join(' ')
    const wrongLength = results.filter((r) => r.played && r.runtime === 'implausible')
    console.log(
      `  ${marks.join(' ')}  ${provider.id.padEnd(16)} ${String(summary.percent).padStart(3)}%` +
        `  ${summary.played}/${summary.total}  ${failed}`,
    )
    for (const wrong of wrongLength) {
      console.log(`        ⚠ ${wrong.subject.label}: ${wrong.runtimeReason}`)
    }
  }

  console.log('\nRanked by what actually played:\n')
  for (const summary of [...scores].sort((a, b) => b.percent - a.percent)) {
    console.log(`  ${String(summary.percent).padStart(3)}%  ${summary.providerId}`)
  }

  const suspect = suspectCanaries(
    every.map((r) => ({ subject: r.subject, verdict: r.played ? 'stream' : 'no-media' })),
    scores.filter((s) => s.played > 0).length,
  )
  if (suspect.length > 0) {
    console.log(
      `\nFailed on every working provider, so suspect the id rather than the providers:\n  ${suspect.join('\n  ')}`,
    )
  }

  if (!keepalive.isDestroyed()) keepalive.destroy()
  stopRendererServer()

  if (options.json) {
    await writeFile(options.json, JSON.stringify({ scores }, null, 2), 'utf8')
    console.log(`Wrote ${options.json}`)
  }
}

/**
 * The `--probe-quality` mode: can the app tell each source's best quality?
 *
 * The measurement that decides whether a quality label is worth building — see
 * `qualityprobe.ts` for how one reading is taken and `judgeQuality` for what
 * each outcome means. Sequential, like the other modes, and for the same
 * reason: providers sharing a line would starve each other, and a starved
 * adaptive player picks a lower rung, which here would read as lower quality.
 *
 *   npm run probe:quality -- --canaries content
 *   npm run probe:quality -- --canaries content --only vidsrc-me --json q.json
 *   npm run probe:quality -- --canaries content --scan-mode   # exactly as the scan reads it
 */
export async function runQualityCli(providers: Provider[], argv: string[]): Promise<void> {
  const options = parseArgs(argv)
  const catalogue = options.catalog ? readCandidateCatalog(options.catalog) : providers
  const targets = options.only.length
    ? catalogue.filter((p) => options.only.includes(p.id))
    : catalogue
  const subjects = options.canaries.slice(0, Math.max(1, options.titles ?? options.canaries.length))

  console.log(`\nReading the best quality of ${targets.length} provider(s) on ${subjects.length} titles.`)
  console.log('L ladder · F one file · U HLS naming no sizes · S sealed · ? unreadable · - no stream\n')

  const shellBaseUrl = await startRendererServer(join(app.getAppPath(), 'out/renderer'))
  const frameUrl = (providerUrl: string): string => playerShellUrl(shellBaseUrl, providerUrl)
  const results: QualityProbeResult[] = []

  for (const [index, provider] of targets.entries()) {
    process.stderr.write(`\n[${index + 1}/${targets.length}] ${provider.id}\n`)
    const mine: QualityProbeResult[] = []
    for (const subject of subjects) {
      const result = await probeQuality(provider, subject, {
        mode: argv.includes('--scan-mode') ? 'scan' : 'measure',
        // The scan's own budget, so "no stream" means what it means there.
        timeoutMs: options.timeoutMs ?? 18_000,
        frameUrl,
        verbose: options.verbose,
      })
      mine.push(result)
      results.push(result)
      process.stderr.write(`      ${describeQuality(result)}\n`)
    }

    const marks = mine.map((r) => QUALITY_MARK[r.judgement.outcome]).join(' ')
    const known = mine.map((r) => r.judgement.best).filter((b): b is number => b !== null)
    const streamed = mine.filter((r) => r.judgement.outcome !== 'no-stream').length
    const best = known.length > 0 ? `${Math.max(...known)}p` : '—'
    console.log(
      `  ${marks}  ${provider.id.padEnd(16)} best ${best.padEnd(6)} known on ${known.length}/${streamed} streamed`,
    )
  }

  stopRendererServer()
  summariseQuality(results)

  if (options.json) {
    await writeFile(options.json, JSON.stringify(results, null, 2))
    console.log(`\nFull report written to ${options.json}`)
  }
}

const QUALITY_MARK: Record<QualityOutcome, string> = {
  ladder: 'L',
  'single-file': 'F',
  unlabelled: 'U',
  sealed: 'S',
  unreadable: '?',
  'no-stream': '-',
}

/** One title's line of progress: the outcome, then the evidence behind it. */
function describeQuality(r: QualityProbeResult): string {
  const j = r.judgement
  const parts = [QUALITY_MARK[j.outcome], r.subject.padEnd(26), j.outcome.padEnd(11)]
  parts.push(j.best !== null ? `best ${j.best}p` : 'best ?')
  if (r.video) {
    const minutes = Number.isFinite(r.video.duration) ? `${Math.round(r.video.duration / 60)}m` : 'live'
    parts.push(`playing ${r.video.width}x${r.video.height} ${minutes}`)
  }
  if (j.decoy) parts.push('DECOY (length does not fit)')
  if (j.contradiction) parts.push('CONTRADICTION (picture above ladder)')
  const statuses = r.playlists.map((p) => `${p.kind}:${p.status}`).join(',')
  if (statuses) parts.push(`[${statuses}]`)
  if (r.wholeFiles.length) parts.push(`files:${r.wholeFiles.length}`)
  return parts.join('  ')
}

/**
 * The answer to the question the mode exists for.
 *
 * Counted per provider, because the label would be per provider: one that names
 * its best quality on every title it streams could carry one, one that never
 * does could not, and one that sometimes does is the case to look at by hand.
 */
function summariseQuality(results: QualityProbeResult[]): void {
  const byProvider = new Map<string, QualityProbeResult[]>()
  for (const r of results) byProvider.set(r.providerId, [...(byProvider.get(r.providerId) ?? []), r])

  const always: string[] = []
  const sometimes: string[] = []
  const never: string[] = []
  const silent: string[] = []
  for (const [id, mine] of byProvider) {
    const streamed = mine.filter((r) => r.judgement.outcome !== 'no-stream')
    const known = streamed.filter((r) => r.judgement.best !== null)
    if (streamed.length === 0) silent.push(id)
    else if (known.length === streamed.length) always.push(id)
    else if (known.length > 0) sometimes.push(id)
    else never.push(id)
  }

  const streaming = byProvider.size - silent.length
  console.log('\n─── Best quality readable ───')
  console.log(`  on every title it streamed  ${always.length}/${streaming}  ${always.join(' ')}`)
  console.log(`  on some titles              ${sometimes.length}/${streaming}  ${sometimes.join(' ')}`)
  console.log(`  never                       ${never.length}/${streaming}  ${never.join(' ')}`)
  console.log(`  streamed nothing            ${silent.length}  ${silent.join(' ')}`)

  const flagged = results.filter((r) => r.judgement.decoy || r.judgement.contradiction)
  if (flagged.length) {
    console.log('\n─── Readings to look at by hand ───')
    for (const r of flagged) console.log(`  ${r.providerId.padEnd(16)} ${describeQuality(r)}`)
  }
}

export function isProbeRun(argv: string[]): boolean {
  return (
    argv.includes('--probe-providers') ||
    argv.includes('--extract-streams') ||
    argv.includes('--probe-ui') ||
    argv.includes('--probe-quality')
  )
}

/** Entry point used by `index.ts` when the flag is present. */
export async function probeAndQuit(providers: Provider[], argv: string[]): Promise<void> {
  try {
    if (argv.includes('--extract-streams')) await runExtractCli(providers, argv)
    else if (argv.includes('--probe-ui')) await runUiProbeCli(providers, argv)
    else if (argv.includes('--probe-quality')) await runQualityCli(providers, argv)
    else await runProbeCli(providers, argv)
  } catch (err) {
    console.error('[probe] failed:', err)
  } finally {
    app.exit(0)
  }
}
