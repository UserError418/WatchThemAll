<script lang="ts">
  /**
   * The player's floating chrome.
   *
   * Lives in a transparent `WebContentsView` stacked above the video, which is
   * the only arrangement in which it can overlap the picture at all: the app
   * window's own page always paints beneath its child views, so the controls
   * used to grow a band and push the video down instead of floating over it.
   *
   * That freedom comes with one obligation, and it shapes everything here:
   * **a view swallows every mouse event inside its bounds.** Whatever this
   * document covers is unclickable in the video underneath. So the overlay is
   * sized to exactly what it draws — `setOverlayArea` is not a nicety, it is what
   * keeps the rest of the picture usable.
   */

  import type {
    OverlayArea,
    PlayerContext,
    PlayerSuggestion,
    ProbeVerdict,
    ScanInFlight,
    ScanReason,
    TitleProviderState,
    CastDevice,
    CastStatus,
  } from '@shared/ipc'
  import {
    formatQuality,
    formatStreamTime,
    inScanOrder,
    providerDot,
    resumeNote,
    sharedLabel,
    tagText,
  } from '@shared/scanrank'
  import { deliveryCastability, type Castability } from '@shared/castability'
  import { untrack } from 'svelte'
  import { fade } from 'svelte/transition'
  import type { Episode, Season, StreamDelivery } from '@shared/types'
  import { airDate, episodeCode, hasAired, runtime } from './lib/format'
  import CastRemote from './components/CastRemote.svelte'
  import { actionForEvent } from '@shared/playerkeys'
  import { nextAiredEpisode, previousEpisode, type NextEpisode } from '@shared/episodesteps'
  import { episodeOf } from '@shared/sourceresults'
  import { liveRunApplies, type RunSubject } from './lib/liverun'
  import { isDownloadedSource } from '@shared/downloads/types'
  import {
    nudgeTarget,
    parseRememberedDevice,
    preferredDevice,
    STREAM_WAIT_MS,
    type RemoteMode,
    type RemotePhase,
  } from './lib/castremote'

  /**
   * The desktop strip's height, border included.
   *
   * Declared rather than measured, like the source list's, so the view can be
   * sized before the season has loaded. The phone's list is sized by CSS
   * instead; it is not in a view that needs telling.
   */
  const EPISODE_PANEL_HEIGHT = 212
  const SOURCE_PANEL_MAX = 300
  /** `.panel`'s top margin, which sits between the bar and the panel itself. */
  const PANEL_GAP = 6
  /** How long the bar stays after the pointer stops asking for it. */
  const HIDE_AFTER_MS = 2_800

  /**
   * The same, with a panel open. Longer, because a list is being read rather
   * than glanced at — but still finite, which is the point: an open panel used
   * to hold the chrome open indefinitely, and since this view swallows every
   * click inside its bounds that left a third of the picture permanently
   * unusable to anyone who opened the source list and then looked away.
   */
  const PANEL_HIDE_AFTER_MS = 5_000

  /**
   * The strip this view keeps even when the chrome is away.
   *
   * Without it the bar could never come back, and for a while it never did.
   * The original trigger was the player view's `input-event` stream, on the
   * stated grounds that no frame can hide an event from it. That is wrong, and
   * measurably so: an embed plays the video in a cross-origin iframe, Chromium
   * routes pointer events straight to that frame's own widget after the first
   * hit test, and the top-level view stops being told. Driving the mouse from
   * the middle of the picture to the top edge produced exactly **one** report,
   * for the position where it entered, and then silence — so nothing ever said
   * "near the top" and the bar was never seen at all.
   *
   * A live strip of our own has no such hole: this document is a real view and
   * gets every event inside its bounds whatever the page below is doing. The
   * cost is the forty pixels of picture it makes unclickable, which is the
   * cheapest thing in reach — it is the band the bar covers anyway.
   */
  const HOT_ZONE_PX = 40

  /**
   * How long the Hide button keeps the chrome away.
   *
   * The bar sits over the top of the picture, and embeds put their own
   * controls there too — a title, a settings cog, a server switcher. Waiting
   * out the auto-hide does not help, because reaching for those controls is
   * exactly what summons the bar back over them. So Hide is a promise the
   * pointer cannot break: for this long nothing but the countdown is drawn,
   * and nothing but the countdown takes a click.
   */
  const SEND_AWAY_MS = 5_000

  /**
   * The countdown pill shown while the chrome is away, which is also the size
   * of the view: fixed rather than measured, because a view is sized to what
   * its document asked for and a document in a view that has not grown yet
   * has nothing to measure. Wide enough for "Controls back in 5s".
   */
  const AWAY_PILL = { width: 176, height: 30, top: 8 }

  interface Props {
    /**
     * Touch input, no pointer — the Android build.
     *
     * Two things change, and both are forced rather than stylistic.
     *
     * **The bar never hides.** Every route back to it needs a pointer: the hot
     * zone is hovered, and `onPointerTop` reports a pointer position. A phone
     * has neither, and a tap inside the provider's cross-origin iframe is
     * invisible to this document — so a bar that hid once would never return,
     * stranding the user in a full-screen video with no exit and no way to
     * change source. Fifty-six pixels of a 915px screen is the right price for
     * the only way out.
     *
     * **The hot zone is not rendered.** It exists to be hovered and would
     * otherwise be a dead strip swallowing taps along the top edge.
     */
    touch?: boolean
  }

  const { touch = false }: Props = $props()

  /** The bar: 64 on the desktop since its buttons grew (2026-09-27); the phone keeps 56 until its port. */
  const BAR_HEIGHT = $derived(touch ? 56 : 64)

  const api = window.wtaChrome

  let context = $state<PlayerContext | null>(null)
  let panel = $state<'none' | 'episodes' | 'sources'>('none')
  /**
   * Our own controls have the film (v2, told by the shell through main).
   * Then the bar keeps only Back, Cast and Reload, in that order, and the
   * source list and the episode strip open at the bottom, from the buttons in
   * our controls (the owner, 2026-09-27). Until then (a source still starting,
   * or its own page showing), and on the phone until its port, the bar keeps
   * every button, because nothing else offers them.
   */
  let owned = $state(false)
  /**
   * Panels open at the bottom, from our controls' buttons. On the phone the
   * source list does; its episode list keeps its own centred sheet, which
   * already sits clear of the controls.
   */
  const bottomPanels = $derived(owned)
  let barVisible = $state(true)
  let hoveringChrome = $state(false)

  /**
   * When the chrome comes back after Hide, or null while it has not been sent
   * away. While this is set nothing may show the bar — not the pointer, not
   * the hot zone, not a failing source — except the countdown itself, clicked.
   */
  let awayUntil = $state<number | null>(null)
  /** The clock the countdown reads, ticked only while the chrome is away. */
  let awayNow = $state(0)
  const awaySeconds = $derived(
    awayUntil === null ? 0 : Math.max(1, Math.ceil((awayUntil - awayNow) / 1000)),
  )

  function sendAway(): void {
    // Cleared by hand: the chrome leaves the DOM under the pointer, so no
    // `mouseleave` arrives, and a stale hover would hold the bar open for good
    // once it returned.
    hoveringChrome = false
    barVisible = false
    awayNow = Date.now()
    awayUntil = awayNow + SEND_AWAY_MS
  }

  /** Back early, or on time. Back as if summoned: it hides again on its own. */
  function comeBack(): void {
    awayUntil = null
    barVisible = true
  }

  $effect(() => {
    if (awayUntil === null) return
    const until = awayUntil
    // A quarter-second tick rather than one per second, so the number turns
    // over within a beat of the real second rather than up to a second late.
    const tick = setInterval(() => {
      awayNow = Date.now()
      if (awayNow >= until) comeBack()
    }, 250)
    return () => clearInterval(tick)
  })

  /** What a picker shows before anything is known: every dot blank. */
  const NO_SOURCE_STATE: TitleProviderState = {
    outcomes: {},
    resume: null,
    scan: null,
    sharedFrom: {},
    castability: {},
    order: [],
  }

  /**
   * What each source has actually done with this title.
   *
   * The same question the detail view's picker answers, and deliberately the
   * same call — a second derivation would eventually disagree with the first,
   * and the user would have two lists telling them different things about the
   * same provider. See `SourcePicker.svelte` for what the colours claim.
   *
   * Worth more here than there, because this list is the one people reach for
   * *after* a source has just disappointed them: the point is to pick the next
   * one without guessing. Listed in Automatic's order, as there, for the same
   * reason — so the top of the list is the next one worth trying.
   */
  let sourceState = $state<TitleProviderState>(NO_SOURCE_STATE)

  /* ── Testing every source ─────────────────────────────────────────────────
   *
   * The same scan the detail view offers, reached from the menu people
   * actually open when a source has just failed them. It is one run either way
   * — the bridge owns it — so starting it here and watching it from there, or
   * the reverse, both work.
   *
   * Local state rather than the app's `scan.svelte.ts` store: that store talks
   * to `window.wta`, and this document only has `window.wtaChrome`.
   */
  let scanVerdicts = $state<Record<string, ProbeVerdict>>({})
  let scanTimings = $state<Record<string, number>>({})
  let scanQualities = $state<Record<string, number>>({})
  let scanReasons = $state<Record<string, ScanReason>>({})
  /** How each source's video arrived in the live run — what the cast list fills in from. */
  let scanDelivery = $state<Record<string, StreamDelivery>>({})
  let scanning = $state(false)
  let scanDone = $state(0)
  let scanTotal = $state(0)
  /** Every source under test right now; the rows mark each one. */
  let scanTesting = $state<ScanInFlight[]>([])
  /** What the live run measures, as its progress names it. */
  let scanSubject = $state.raw<RunSubject | null>(null)
  /** Runs finished or cancelled since this document opened: see `liveRunApplies`. */
  let scanFinished = $state(0)
  /** `scanFinished` when the stored state on screen was asked for (`refreshSourceState`). */
  let readAfter = $state(0)
  /** Counts the reads asked for, so only the latest answer is taken. */
  let reads = 0

  $effect(() =>
    api?.onProviderScan((progress) => {
      scanSubject = { titleKey: progress.titleKey, episode: progress.episode }
      if (progress.finished) scanFinished += 1
      scanVerdicts = progress.verdicts
      scanTimings = progress.timings
      scanQualities = progress.qualities
      scanReasons = progress.reasons
      scanDelivery = progress.delivery
      scanDone = progress.done
      scanTotal = progress.total
      scanTesting = progress.testing
      scanning = !progress.finished
    }),
  )

  /**
   * Forget the live run: it was of another episode. Main sends this document
   * only runs about what is playing, but a step to another episode keeps the
   * document, and results are per episode.
   */
  function clearLiveScan(): void {
    scanVerdicts = {}
    scanTimings = {}
    scanQualities = {}
    scanReasons = {}
    scanDelivery = {}
    scanning = false
    scanDone = 0
    scanTotal = 0
    scanTesting = []
    scanSubject = null
  }

  /**
   * Whether the live run colours the list rather than what is stored: by the
   * detail view's rule (`liverun.ts`). Only a run of the episode playing, and
   * once it is over only until the stored results have been read again,
   * which hold its results and order Automatic. The list used to keep a
   * finished run's verdicts until an episode step. As before, a run that has
   * settled nothing yet leaves the stored dots up.
   */
  const liveRun = $derived(
    context !== null &&
      Object.keys(scanVerdicts).length > 0 &&
      liveRunApplies(
        { subject: scanSubject, running: scanning, finished: scanFinished },
        { type: context.type, imdbId: context.imdbId, tmdbId: context.tmdbId },
        episodeOf(context),
        readAfter,
      ),
  )

  /** Live run first while `liveRun` says so, else whatever was stored for this title. */
  const verdicts = $derived<Record<string, ProbeVerdict>>(
    liveRun ? scanVerdicts : (sourceState.scan?.verdicts ?? {}),
  )
  /** Time to stream for the sources that streamed, from the same run as `verdicts`. */
  const timings = $derived<Record<string, number>>(liveRun ? scanTimings : (sourceState.scan?.timings ?? {}))
  const qualities = $derived<Record<string, number>>(
    liveRun ? scanQualities : (sourceState.scan?.qualities ?? {}),
  )
  const reasons = $derived<Record<string, ScanReason>>(liveRun ? scanReasons : (sourceState.scan?.reasons ?? {}))

  /** " · 3.8 s · 1080p" for a source that streamed; see `SourcePicker.svelte`. */
  function measurement(id: string): string {
    const shared = sharedNote(id)
    if (verdicts[id] !== 'stream') return shared
    const ms = timings[id]
    const quality = qualities[id]
    return (
      (ms !== undefined ? ` · ${formatStreamTime(ms)}` : '') +
      (quality !== undefined ? ` · ${formatQuality(quality)}` : '') +
      shared
    )
  }

  /**
   * " · PC" or " · Phone" for a result measured on another kind of device,
   * so a result from elsewhere is not passed off as this device's own.
   * Not during a live run here, whose results are all this device's.
   */
  function sharedNote(id: string): string {
    if (liveRun) return ''
    return sharedLabel(sourceState.sharedFrom[id])
  }

  /**
   * The download, when there is one, at the top: it is what the player plays
   * first. Tests never rank it (it is not a source), so the test order put it
   * last, below the fold of a long list.
   */
  function downloadedFirst<T extends { id: string }>(rows: T[]): T[] {
    return [...rows.filter((r) => isDownloadedSource(r.id)), ...rows.filter((r) => !isDownloadedSource(r.id))]
  }

  /**
   * The menu's rows, in Automatic's order as of the last re-read.
   *
   * Not re-sorted while a test runs — `sourceState` is re-read only when it
   * finishes — so the rows hold still while their dots fill in.
   */
  const sourceRows = $derived(downloadedFirst(inScanOrder(context?.providers ?? [], sourceState.order)))

  async function toggleScan(): Promise<void> {
    if (context === null) return
    if (scanning) {
      await api.cancelScan()
      return
    }
    const media = { type: context.type, imdbId: context.imdbId, tmdbId: context.tmdbId }
    const episode =
      context.season !== null && context.episode !== null
        ? { season: context.season, episode: context.episode }
        : null
    await api.scan(media, episode)
    // Re-read so the dots and the stored scan describe one moment. The run's
    // results are filed by the time the call returns.
    await refreshSourceState()
  }

  /* ── Casting ──────────────────────────────────────────────────────────────
   *
   * Offered from the player and nowhere else, because there is nothing to cast
   * until the provider's own player has fetched a stream. The button is hidden
   * entirely where casting cannot work — desktop, and any phone without Google
   * Play Services — rather than shown and then apologising.
   */

  let castAvailable = $state(false)
  let castDevices = $state<CastDevice[]>([])
  let castStatus = $state<CastStatus | null>(null)
  /** The last failure, in the user's words. Cleared when they try again. */
  let castError = $state<string | null>(null)

  /* ── The remote ───────────────────────────────────────────────────────────
   *
   * The cast button opens it, and a connected television keeps it up. It
   * replaces the chrome rather than adding to it: while choosing it is the
   * list of televisions and sources, and while casting the picture is
   * elsewhere, this window is muted or blanked, and a 56px bar over a black
   * rectangle is a control surface for nothing. The rest of the machinery is
   * further down, beside the episode helpers it uses; these are here because
   * the height calculation needs them.
   */

  const casting = $derived(castStatus?.connected === true)

  /** The cast button was pressed and the remote has not been closed since. */
  let remoteOpen = $state(false)

  /**
   * Stood down on request, while still casting.
   *
   * The single reason it exists: a provider that has not started fetching needs
   * its own play button pressed, and that button is on the page the remote is
   * covering. Reset whenever a cast starts or ends, so it can never be the
   * state a user comes back to.
   */
  let remoteHidden = $state(false)
  /** Attached, and back at the list: "Change source", or a source that did not cast. */
  let picking = $state(false)
  const showRemote = $derived(castAvailable && (remoteOpen || casting) && !remoteHidden)
  const remoteMode = $derived<RemoteMode>(!casting || picking ? 'choose' : 'control')

  /**
   * The television a source will be sent to, before one is attached.
   *
   * Preselected (`preferredDevice`) so that with one television, or the one
   * used last, casting is the cast button and then a source: two taps. Nothing
   * connects until the source is picked, because connecting wakes the set and
   * puts the receiver's idle screen on it, which reads as a failure for as long
   * as the choosing takes.
   */
  let selectedDevice = $state<string | null>(null)

  /** Per document and not synced: which television is "the" television is a fact about the room. */
  const LAST_DEVICE_KEY = 'wta.cast.lastDevice'

  function rememberedDevice(): ReturnType<typeof parseRememberedDevice> {
    try {
      return parseRememberedDevice(localStorage.getItem(LAST_DEVICE_KEY))
    } catch {
      return null
    }
  }

  function rememberDevice(device: CastDevice): void {
    try {
      localStorage.setItem(LAST_DEVICE_KEY, JSON.stringify({ id: device.id, name: device.name }))
    } catch {
      // Not remembering is only one more tap next time.
    }
  }

  $effect(() => {
    const found = castDevices
    const current = untrack(() => selectedDevice)
    // A choice the user made stands for as long as that television is there.
    if (current !== null && found.some((d) => d.id === current)) return
    selectedDevice = preferredDevice(found, rememberedDevice())
  })

  /* ── Choosing what to cast ────────────────────────────────────────────────
   *
   * Agreed with the owner 2026-09-26: connecting to a television no longer
   * sends whatever happens to be playing. It opens a list — the ordinary
   * source list, narrowed to what can cast — and the user picks. Only then is
   * the source loaded here, started, and handed over. Since 2026-09-27 that
   * list is the remote's first face, and picking from it is also what
   * connects.
   *
   * The reason was the receiver, and then turned out not to be. It was built
   * believing a plain Chromecast refuses HLS; measured the same evening, it
   * plays HLS through the cast proxy. What the list still narrows away is
   * what genuinely does not cast — another container, a source a television
   * refused — and what it adds is choosing before loading rather than after.
   * See `shared/castability.ts`.
   */

  /** Sources a cast from the list could not start this time, with why, so their rows can say. */
  let castFailures = $state<Record<string, string>>({})
  /** The last failure, shown at the head of the list it returned to. */
  let castFailureNote = $state<string | null>(null)

  /**
   * Whether a source can cast this title, with the live test's findings first.
   * A test run from the list itself fills the list in as each source settles.
   */
  function castabilityOf(id: string): Castability {
    // A download is a playlist and segments served from this device: it casts.
    if (isDownloadedSource(id)) return 'yes'
    return deliveryCastability(liveRun ? scanDelivery[id] : undefined) ?? sourceState.castability[id] ?? 'unknown'
  }

  /**
   * The list, in the ordinary order: castable first, then what nothing has
   * checked — a source seen handing out a file elsewhere ahead of the rest.
   * Sources known not to cast are left out and counted, except one the user
   * just tried, which stays so its row can say what happened.
   */
  const castGroups = $derived.by(() => {
    const rows = sourceRows.map((provider) => ({ provider, castable: castabilityOf(provider.id) }))
    const tried = (id: string): boolean => id in castFailures
    return {
      yes: rows.filter((r) => r.castable === 'yes' && !tried(r.provider.id)),
      maybe: [
        ...rows.filter((r) => r.castable === 'likely' && !tried(r.provider.id)),
        ...rows.filter((r) => r.castable === 'unknown' && !tried(r.provider.id)),
        ...rows.filter((r) => tried(r.provider.id)),
      ],
      hidden: rows.filter((r) => r.castable === 'no' && !tried(r.provider.id)).length,
    }
  })

  /** Re-read what is known about this title's sources — for the dots, and for castability. */
  async function refreshSourceState(): Promise<void> {
    if (context === null) return
    const asked = ++reads
    const finished = scanFinished
    let result: TitleProviderState
    try {
      result = await api.outcomes(
        { type: context.type, imdbId: context.imdbId, tmdbId: context.tmdbId },
        episodeOf(context),
      )
    } catch {
      // No record is a fair answer: every dot is blank, every source unchecked.
      result = NO_SOURCE_STATE
    }
    if (asked !== reads) return
    sourceState = result
    readAfter = finished
  }

  /** The cast button, and C: straight into the remote, whatever state it is in. */
  function openRemote(): void {
    panel = 'none'
    remoteHidden = false
    // Already attached: the remote is the answer, on whichever face it was.
    if (casting) return
    // C again closes it, as it closed the panel this replaced.
    if (remoteOpen) {
      closeRemote()
      return
    }
    castError = null
    castFailures = {}
    castFailureNote = null
    picking = false
    remoteOpen = true
    void refreshSourceState()
  }

  /** Close without casting: the player, as it was. */
  function closeRemote(): void {
    remoteOpen = false
    picking = false
    castError = null
    castFailureNote = null
    barVisible = true
  }

  /** Leave the list: back to the transport while attached, else close the remote. */
  function cancelChoice(): void {
    if (casting) {
      picking = false
      castFailureNote = null
      castError = null
      return
    }
    closeRemote()
  }

  /**
   * Reach the chosen television. True once attached.
   *
   * The remote's phase says so meanwhile, and holds the list still, because
   * on the desktop this is a TCP connection and a receiver launch, which is a
   * second or two.
   */
  async function connectTo(deviceId: string): Promise<boolean> {
    const device = castDevices.find((d) => d.id === deviceId)
    castError = null
    remotePhase = 'connecting'
    remoteNote = `Connecting to ${device?.name ?? 'the television'}…`
    try {
      const connected = await api.cast.connect(deviceId)
      if (!connected.ok) {
        castError = connected.error ?? 'Could not connect to that TV.'
        return false
      }
      if (device) rememberDevice(device)
      return true
    } catch (error) {
      castError = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      castStatus = await api.cast.status()
      if (remotePhase === 'connecting') {
        remotePhase = 'playing'
        remoteNote = ''
      }
    }
  }

  /**
   * Cast from one source: attach the television if need be, load the source
   * here, start it, hand it over.
   *
   * The television is fed from this window, so a source not already playing
   * has to be loaded here first. A failure of any kind comes back to the list
   * rather than to the remote's "stuck" state: the question at that moment is
   * which source to try next, and the list is where that is answered.
   */
  async function castFrom(providerId: string, providerName: string): Promise<void> {
    if (context === null) return
    const token = ++switchToken
    castFailureNote = null
    castError = null

    if (!casting) {
      if (selectedDevice === null) return
      if (!(await connectTo(selectedDevice))) return
      if (token !== switchToken) return
    }
    picking = false

    if (providerId !== context.providerId) {
      remotePhase = 'switching'
      remoteNote = `Loading ${providerName} here first — the television is fed from this window.`
      api.switchProvider(providerId)
      // Nothing is captured for a beat after a navigation.
      await sleep(2000)
      if (token !== switchToken) return
    }

    const result = await handOver(token)
    if (result === null || result.ok) return
    castFailures = { ...castFailures, [providerId]: result.reason }
    castFailureNote = `${providerName}: ${result.reason}`
    remotePhase = 'playing'
    remoteNote = ''
    picking = true
    // The attempt was filed as a measurement; the list should reflect it.
    void refreshSourceState()
  }

  /**
   * Going small drops a choice nobody finished.
   *
   * Back, Escape from the player and Android Back all shrink the player, and
   * the remote would otherwise wait, unseen, to cover the picture again on the
   * way back. A running cast is not a choice: it stays, as it always has.
   */
  $effect(() => {
    if (mini && remoteOpen && !casting) closeRemote()
  })

  /** "Change source": the list, with the television still attached and still playing. */
  function changeSource(): void {
    castFailureNote = null
    castError = null
    picking = true
    void refreshSourceState()
  }

  /**
   * One path for every transport command, so a failure is never silent.
   *
   * The television is across the room; a button that did nothing and said
   * nothing is indistinguishable from one that worked and a picture nobody is
   * looking at.
   */
  async function send(action: 'play' | 'pause' | 'stop' | 'seek', seconds = 0): Promise<void> {
    try {
      await api.cast.control(action, seconds)
      castStatus = await api.cast.status()
    } catch (error) {
      castError = error instanceof Error ? error.message : String(error)
    }
  }

  $effect(() => {
    void api?.cast.available().then((yes) => (castAvailable = yes))
  })

  /**
   * Poll while the remote is up or a television is attached, and only then.
   *
   * The position on the television is the one thing the phone cannot be told
   * about — `RemoteMediaClient` reports it to native code, and pushing every
   * tick across the bridge would cost more than reading it once a second. The
   * interval is torn down when the remote closes so a backgrounded player is
   * not waking the bridge forever.
   */
  $effect(() => {
    if (!castAvailable) return
    if (!showRemote && !castStatus?.connected) return

    const tick = (): void => {
      void api?.cast.status().then((next) => (castStatus = next))
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  })

  /**
   * Sweep for televisions while the remote is choosing and nothing is attached.
   *
   * One query is not enough, and asking once was the second reason this button
   * appeared to do nothing. On the desktop `startDiscovery` *is* the mDNS
   * query — it takes three seconds and only then is there anything to read —
   * so firing it and reading `devices()` in the same breath reliably returns
   * the empty list from before it ran. Android's is a live scan that fills in
   * over the same sort of interval.
   *
   * So: ask, read, ask again, until the remote closes or a television is
   * attached. `MIN_SWEEP_MS` is a floor
   * rather than a delay — it costs nothing on desktop, where the query already
   * takes longer, and stops the loop spinning on a platform that returns at
   * once.
   */
  const MIN_SWEEP_MS = 2500

  $effect(() => {
    if (!showRemote || casting) return

    let sweeping = true

    const sweep = async (): Promise<void> => {
      while (sweeping) {
        const startedAt = Date.now()
        try {
          await api.cast.startDiscovery()
          if (!sweeping) return
          castDevices = await api.cast.devices()
        } catch {
          // A discovery that fails is not worth a message: the remote already
          // says it is looking, and the next sweep may well succeed.
        }
        const elapsed = Date.now() - startedAt
        if (elapsed < MIN_SWEEP_MS) {
          await new Promise((resolve) => setTimeout(resolve, MIN_SWEEP_MS - elapsed))
        }
      }
    }

    void sweep()

    return () => {
      sweeping = false
      void api.cast.stopDiscovery()
    }
  })

  /**
   * The receiver's volume, which is not the media session's.
   *
   * `SET_VOLUME` goes to `urn:x-cast:com.google.cast.receiver` addressed to
   * `receiver-0`; sent to the media transport instead it is accepted and
   * silently ignored, which is the failure mode this comment exists to stop
   * anyone rediscovering. Errors land in `castError` like the transport's do,
   * because a slider that moved and changed nothing is the same lie.
   */
  async function setReceiverVolume(level: number): Promise<void> {
    try {
      await api.cast.setVolume(level)
      castStatus = await api.cast.status()
    } catch (error) {
      castError = error instanceof Error ? error.message : String(error)
    }
  }

  async function setReceiverMuted(muted: boolean): Promise<void> {
    try {
      await api.cast.setMuted(muted)
      castStatus = await api.cast.status()
    } catch (error) {
      castError = error instanceof Error ? error.message : String(error)
    }
  }

  async function stopCasting(): Promise<void> {
    await api.cast.disconnect()
    castStatus = await api.cast.status()
  }

  /**
   * The app's colour tokens, as literals.
   *
   * This document is mounted on its own and has no access to the token sheet,
   * so the values are copied. `providerDot` returns a *tone* rather than a
   * colour precisely so that this copy stays in one place instead of being
   * spread through the markup.
   */
  const TONE: Record<'good' | 'warn' | 'bad', string> = {
    good: '#34d399',
    warn: '#fbbf24',
    bad: '#fb5c76',
  }
  /** `--resume` from the app's tokens; this document has no stylesheet to read. */
  const RESUME_COLOUR = '#5b9dfa'
  const resumeText = $derived(sourceState.resume ? resumeNote(sourceState.resume) : null)

  /**
   * Re-read on every open, never cached.
   *
   * The player appends to this log as it plays, so the most interesting entry
   * is almost always the one written seconds ago — the source that just failed
   * and sent the user to this menu in the first place.
   */
  function openSources(): void {
    if (panel === 'sources') {
      panel = 'none'
      return
    }
    panel = 'sources'
    void refreshSourceState()
  }

  /** Episodes of the season being browsed, which need not be the one playing. */
  let browsingSeason = $state<number | null>(null)
  let browsingSeasonName = $state<string | null>(null)
  let episodes = $state<Episode[]>([])
  let loadingEpisodes = $state(false)

  $effect(() =>
    api?.onContext((next) => {
      // Untracked: the phone's bridge calls this synchronously while
      // subscribing, so inside this effect, and a tracked read made the effect
      // depend on the `context` it writes: effect_update_depth_exceeded on
      // every player open.
      const previous = untrack(() => context)
      const moved =
        previous !== null &&
        (previous.tmdbId !== next.tmdbId || previous.season !== next.season || previous.episode !== next.episode)
      if (moved) clearLiveScan()
      context = next
    }),
  )

  /* ── The failed-source offer ──────────────────────────────────────────── */

  /**
   * Moved here from the app window, and the move is the whole point.
   *
   * The app window's page paints *beneath* the native player view, so a banner
   * there could not be drawn over the picture — it had to reserve a band of
   * layout, and that reservation is what squashed the video down every time a
   * provider failed. This document is the layer that can float, so the banner
   * floats.
   */
  let suggestion = $state<PlayerSuggestion | null>(null)
  $effect(() =>
    api?.onSuggestion((next) => {
      suggestion = next
    }),
  )

  /**
   * How long the user has to stop the switch.
   *
   * The offer is not a question: the provider has already failed and the user
   * is looking at a black rectangle, so doing nothing should fix it rather
   * than preserve it. Five seconds is long enough to read the sentence and
   * reach the button, short enough that waiting it out is never the fastest
   * way to give up.
   */
  const AUTOSWITCH_SECONDS = 5

  /** Seconds left, or null when no countdown is running. */
  let countdown = $state<number | null>(null)

  /**
   * The player is shrunk into the app's corner, and this chrome with it.
   *
   * On the desktop this view is sized to nothing, and on the phone its host
   * is hidden. Its document keeps running, so the bar, the menus and a
   * standing offer are all still here on the way back.
   */
  let mini = $state(false)
  $effect(() =>
    api?.onMini((next) => {
      mini = next
    }),
  )

  /**
   * Keyed on the offer itself, so a second provider failing restarts the clock
   * rather than inheriting what was left of the first one's.
   */
  $effect(() => {
    const pending = suggestion
    if (!pending) {
      countdown = null
      return
    }
    /*
     * A cast outranks the auto-switch.
     *
     * The local embed failing to start is the *expected* state while casting —
     * it is muted on the desktop and blanked on the phone — so the countdown
     * would fire on almost every cast and silently move the user to another
     * provider, clearing the capture and abandoning the stream the television
     * is playing. The offer is not merely hidden, it is not armed.
     */
    if (casting) {
      countdown = null
      return
    }

    /*
     * Some offers only offer: a stall mid-episode, and a source that "Test all
     * sources" found working. Main decides which (`mayAutoSwitch`); this only
     * obeys. The banner stays, without a clock.
     */
    if (!pending.autoSwitch) {
      countdown = null
      return
    }
    /*
      Nor while the player is small. The rule is that the player never
      switches without the offer bar on screen, and a mini player has no
      room for one. So the offer waits: the mini player says the source
      stopped, and the countdown starts from the top once the user opens the
      player again. That is where they can see it and stop it.
    */
    if (mini) {
      countdown = null
      return
    }

    /**
     * The seconds live in a plain local and are only mirrored into state.
     * Reading `countdown` inside the effect would make the effect depend on a
     * value it writes every tick, so each tick would tear the interval down
     * and start another — which once produced two intervals and switched the
     * provider twice.
     *
     * Always from the top. This runs again only for a new offer, or after the
     * mini player or a cast stopped the clock, and both mean "start over".
     * It used to carry on from what the last clock had left, so a second
     * failure in the same load (a silence offer, then the provider's page
     * failing) switched two or three seconds later instead of five.
     */
    let left = AUTOSWITCH_SECONDS
    countdown = left

    const tick = setInterval(() => {
      left -= 1
      countdown = left
      if (left > 0) return
      clearInterval(tick)
      // Taking the offer, not picking from the menu: main marks the source
      // being left as tried, so the next offer cannot send the user back.
      void api.acceptSuggestion()
    }, 1000)

    return () => clearInterval(tick)
  })

  function switchNow(): void {
    if (!suggestion) return
    countdown = null
    void api.acceptSuggestion()
  }

  /** Stop the clock and stay put. The source keeps loading either way. */
  function keepWaiting(): void {
    countdown = null
    void api.dismissSuggestion()
  }

  /**
   * Measured rather than assumed: the sentence wraps at narrow widths, and a
   * guessed height either clips the buttons or swallows clicks on picture the
   * banner is not covering.
   */
  let suggestionHeight = $state(0)

  /**
   * The bar is summoned by the pointer and dismissed by time.
   *
   * Position is a *trigger*, not a hold: an earlier version treated "pointer is
   * near the top" as a reason to stay open, so nudging the mouse mid-episode
   * brought the bar back and it never left again. Only hovering the chrome
   * itself, or having a panel open, actually holds it.
   *
   * A second trigger, and the one that carries the weight — see `HOT_ZONE_PX`.
   * This one only sees the pointer while it is over parts of the player that
   * are not the provider's iframe, which on a playing embed is almost nowhere.
   */
  $effect(() =>
    api?.onPointerTop((nearTop) => {
      if (nearTop && awayUntil === null) barVisible = true
    }),
  )

  /**
   * v2: movement anywhere over the picture brings the bar up, as it brings up
   * the shell's own controls below. The shell is the only document that sees
   * that movement (`PlayerOverlay.svelte`), and main passes it on. Each report
   * restarts the hide clock. `hold` keeps the bar up while the film is paused
   * or the bottom controls are in use, so the top and bottom go together.
   */
  let activityTick = $state(0)
  let heldByShell = $state(false)
  $effect(() =>
    api?.onActivity((hold) => {
      heldByShell = hold
      if (awayUntil !== null) return
      barVisible = true
      activityTick += 1
    }),
  )

  /** Enter and C open Episodes and Cast, wherever the key was pressed; so do the shell's buttons, and Sources. */
  $effect(() =>
    api?.onOpenPanel((which) => {
      if (awayUntil !== null) comeBack()
      barVisible = true
      if (which === 'episodes' && context?.type === 'tv') openEpisodes()
      if (which === 'cast' && castAvailable) openRemote()
      if (which === 'sources') openSources()
    }),
  )

  $effect(() =>
    api?.onOwned((value) => {
      owned = value
    }),
  )

  // On the phone, the bar is pinned open whenever our controls do not have the
  // film (starting, or the source's own page showing): nothing else can bring
  // it back there, and without it there is no way to another source.
  $effect(() => {
    if (touch && !owned) barVisible = true
  })

  // The phone's tap on the picture while the controls show: all of it goes.
  $effect(() =>
    api?.onDismiss(() => {
      barVisible = false
    }),
  )

  // A panel open when the layout changes would jump from the bottom to the top.
  $effect(() => {
    void bottomPanels
    untrack(() => (panel = 'none'))
  })

  /** A player key pressed while this document has the focus; main routes it. */
  function onKeydown(event: KeyboardEvent): void {
    const action = actionForEvent(event)
    if (action === null) return
    event.preventDefault()
    // Escape on the list steps out of the list, as Close does. Routed on, it
    // would shrink the player with the remote still open over it.
    if (action === 'escape' && showRemote && remoteMode === 'choose') {
      cancelChoice()
      return
    }
    api?.action(action)
  }

  /**
   * A standing offer pins the chrome open.
   *
   * Two reasons. The source has just failed, so the controls are the thing the
   * user wants in front of them; and the banner hangs below the bar, so a bar
   * that came and went underneath it would slide the buttons up and down while
   * somebody was aiming at them.
   */
  $effect(() => {
    // Not while sent away: the offer waits for the bar, and an auto-switch
    // goes ahead on its own either way.
    if (suggestion && awayUntil === null) barVisible = true
  })

  $effect(() => {
    if (!barVisible) return
    // A phone could not see a tap on the picture, so its bar stayed up. Our
    // controls can (they take the taps), so while they have the film the
    // bar hides with them (the owner, 2026-09-27: "hide together").
    if (touch && !owned) return
    if (suggestion) return
    // Hovering the chrome holds it open — including hovering a panel, which is
    // a child of it — and so does the shell while paused or in use.
    // A tap is reported as a mouseenter with no leave to follow, so on a
    // phone hovering means nothing.
    if (hoveringChrome && !touch) return
    if (heldByShell) return
    // Read so that each report of activity restarts the clock.
    void activityTick
    const timer = setTimeout(
      () => (barVisible = false),
      panel === 'none' ? HIDE_AFTER_MS : PANEL_HIDE_AFTER_MS,
    )
    return () => clearTimeout(timer)
  })

  /** Closing the chrome must not leave a panel open behind it. */
  $effect(() => {
    if (!barVisible) panel = 'none'
  })

  /**
   * Reserve the room the open panel needs.
   *
   * Both panels declare their own height in CSS, so a constant is honest for
   * them. Casting has no panel: the remote takes the whole slot (`WHOLE_SLOT`).
   */
  const panelHeight = $derived(
    panel === 'episodes'
      ? EPISODE_PANEL_HEIGHT + PANEL_GAP
      : panel === 'sources'
        ? SOURCE_PANEL_MAX
        : 0,
  )

  /**
   * Larger than any window, because the remote takes the whole slot.
   *
   * `placeOverlay` clamps whatever arrives to the video view's own bounds, so
   * a sentinel is both honest and exact: this document cannot measure the slot
   * itself — its `innerHeight` is whatever it last asked for, which is 56.
   */
  const WHOLE_SLOT = 10_000

  /**
   * How far above the picture's bottom edge a panel opened from our controls
   * sits: clear of the shell's seek bar and button row (`PlayerOverlay.svelte`),
   * so the time and the buttons stay in sight while a panel is open.
   */
  const ABOVE_OUR_CONTROLS = 120

  /**
   * How much of the window this overlay may cover.
   *
   * Everything it draws, and — when it draws nothing — the strip it needs to
   * notice the pointer coming back. A view swallows every click inside its
   * bounds, so this is the number that decides how much of the picture stays
   * the user's.
   */
  const neededArea: OverlayArea = $derived(
    showRemote
      ? { height: WHOLE_SLOT, width: null }
      : awayUntil !== null
        ? { height: AWAY_PILL.top + AWAY_PILL.height, width: AWAY_PILL.width, barVisible: false, away: true }
        : bottomPanels && barVisible && panel !== 'none'
          ? // A panel at the bottom: the view is one rectangle from the top, so
            // it takes the whole slot, and a click beside the panel closes it.
            {
              height: WHOLE_SLOT,
              width: null,
              barVisible: true,
              away: false,
              episodesOpen: panel === 'episodes',
              sourcesOpen: panel === 'sources',
            }
          : {
              height: (barVisible ? BAR_HEIGHT + panelHeight : HOT_ZONE_PX) + suggestionHeight,
              width: null,
              barVisible,
              away: false,
              episodesOpen: barVisible && panel === 'episodes',
              sourcesOpen: barVisible && panel === 'sources',
            },
  )

  $effect(() => {
    api?.setOverlayArea(neededArea)
  })

  /* ── Episodes ─────────────────────────────────────────────────────────── */

  async function loadSeason(season: number): Promise<void> {
    if (context === null || context.type !== 'tv') return
    loadingEpisodes = true
    browsingSeason = season
    browsingSeasonName = null
    try {
      const result = await api.season(context.tmdbId, season)
      // Guard against a slow answer for a season the user has since left.
      if (browsingSeason === season) {
        episodes = result?.episodes ?? []
        browsingSeasonName = result?.name || null
      }
    } catch {
      // A failed fetch leaves the strip empty rather than breaking the chrome;
      // the player itself is unaffected by not knowing the episode list.
      if (browsingSeason === season) {
        episodes = []
        browsingSeasonName = null
      }
    } finally {
      loadingEpisodes = false
    }
  }

  function openEpisodes(): void {
    if (panel === 'episodes') {
      panel = 'none'
      return
    }
    panel = 'episodes'
    if (context?.season != null && browsingSeason !== context.season)
      void loadSeason(context.season)
  }

  const still = (path: string | null): string | null =>
    path === null ? null : `https://image.tmdb.org/t/p/w300${path}`

  /** The line under an episode's name: how long it runs, or when it airs. */
  function episodeDetail(episode: Episode, aired: boolean): string {
    if (aired) return runtime(episode.runtime)
    return episode.airDate ? `Airs ${airDate(episode.airDate)}` : 'Not yet aired'
  }

  /** The browsed season as TMDB names it ("Season 1", or "Book One"). */
  const seasonName = $derived(
    browsingSeasonName ?? (browsingSeason === null ? '' : `Season ${browsingSeason}`),
  )

  /** The scrolling list itself, while it is on screen. */
  let episodeList = $state<HTMLElement | null>(null)

  /**
   * How much of the episode before the playing one stays in view.
   *
   * Enough to show the list goes both ways. Opening flush on the playing
   * episode made it look like the start of the season.
   */
  const EPISODE_PEEK = 48

  /**
   * Open the list at the episode that is playing, not at episode 1.
   *
   * Someone halfway through a season opens this for the next episode, or the
   * one they just left. Starting at the top made them scroll past everything
   * they had already seen to reach either. One of the two assignments is a
   * no-op: the strip scrolls sideways and the phone's list down.
   */
  $effect(() => {
    const list = episodeList
    const current = list?.querySelector<HTMLElement>('.episode.playing')
    if (!list || !current) return
    const listBox = list.getBoundingClientRect()
    const box = current.getBoundingClientRect()
    list.scrollLeft += box.left - listBox.left - EPISODE_PEEK
    list.scrollTop += box.top - listBox.top - EPISODE_PEEK
  })

  /**
   * Let a mouse wheel scroll the strip.
   *
   * Chromium scrolls a sideways-only box on a vertical wheel only while Shift
   * is held, so with an ordinary mouse the last episodes of a season were
   * reachable only by dragging an 8px scrollbar. Registered by hand because
   * the listener must be allowed to `preventDefault`. A trackpad's own
   * sideways swipe is left alone.
   */
  $effect(() => {
    const list = episodeList
    if (!list || touch) return
    const onWheel = (event: WheelEvent): void => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      event.preventDefault()
      list.scrollLeft += event.deltaY
    }
    list.addEventListener('wheel', onWheel, { passive: false })
    return () => list.removeEventListener('wheel', onWheel)
  })

  /* ── The strip by keyboard (v2) ──────────────────────────────────────── */

  /**
   * The episode the arrows are on, in the season being browsed. It starts on
   * the playing episode, or on the first one that has aired.
   */
  let highlighted = $state<number | null>(null)

  $effect(() => {
    if (panel !== 'episodes' || episodes.length === 0) {
      if (panel !== 'episodes') highlighted = null
      return
    }
    if (highlighted !== null && episodes.some((e) => e.episode === highlighted)) return
    const playing = browsingSeason === context?.season ? (context?.episode ?? null) : null
    highlighted = playing ?? episodes.find((e) => hasAired(e.airDate))?.episode ?? null
  })

  /** Only episodes that have aired can be landed on; an unaired one cannot play. */
  function moveHighlight(step: 1 | -1): void {
    const playable = episodes.filter((e) => hasAired(e.airDate))
    if (playable.length === 0) return
    const at = playable.findIndex((e) => e.episode === highlighted)
    const next = playable[Math.min(playable.length - 1, Math.max(0, at < 0 ? 0 : at + step))]
    highlighted = next?.episode ?? null
    // A viewer picking an episode is using the bar: its clock starts over.
    activityTick += 1
  }

  $effect(() => {
    const target = highlighted
    if (target === null || !episodeList) return
    episodeList
      .querySelector<HTMLElement>(`[data-episode="${target}"]`)
      ?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  })

  $effect(() =>
    api?.onEpisodeNav((nav) => {
      // Back and Escape close the source list too (`SOURCE_KEYS` in main).
      if (nav === 'close') {
        panel = 'none'
        return
      }
      if (panel !== 'episodes') return
      if (nav === 'prev') moveHighlight(-1)
      else if (nav === 'next') moveHighlight(1)
      else if (highlighted !== null && browsingSeason !== null) {
        api.goTo(browsingSeason, highlighted)
        panel = 'none'
      }
    }),
  )

  const positionLabel = $derived(
    context === null || context.season === null || context.episode === null
      ? ''
      : episodeCode(context.season, context.episode),
  )

  /* ── The remote ───────────────────────────────────────────────────────────
   *
   * Opened by the cast button and kept up by a connected television, it
   * replaces the chrome rather than adding to it. The picture is elsewhere,
   * this window is blanked or muted, and a 56px bar over a black rectangle is
   * a control surface for nothing — so while it is up this document draws one
   * thing, full bleed. See `CastRemote.svelte`.
   */

  let remotePhase = $state<RemotePhase>('playing')
  /** What the remote says while `remotePhase` is not `playing`. */
  let remoteNote = $state('')

  /**
   * Cancels a switch that has been overtaken.
   *
   * Pressing ⏭ twice starts a second hand-over while the first is still
   * retrying, and without this the loser would keep writing phases and
   * eventually declare the *winner's* episode stuck.
   */
  let switchToken = 0

  /*
   * Whatever the remote was in the middle of stopped mattering the moment the
   * television let go, and the remote goes with it: Stop casting ends in the
   * player, not back at the list. Keyed on `casting` alone, so it runs when a
   * cast ends and not while the list is being used before one starts.
   */
  $effect(() => {
    if (casting) return
    switchToken += 1
    remoteHidden = false
    remotePhase = 'playing'
    remoteNote = ''
    picking = false
    steppingTo = null
    remoteOpen = false
  })

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  /**
   * Hand whatever this window is now playing to the television.
   *
   * A retry loop rather than one call, because the stream does not exist yet
   * when the episode starts loading: the embed has to reach its player and
   * fetch something before there is anything to cast. `beam` answers "nothing
   * to cast yet" until then, which is a perfectly ordinary answer and not an
   * error to show anyone.
   *
   * It gives up after `STREAM_WAIT_MS` into `stuck`, which is a real state and
   * not a failure — several providers fetch nothing at all until their own play
   * button is pressed, and the honest thing is to say so and offer the screen.
   */
  async function handOver(
    token: number,
  ): Promise<{ ok: true } | { ok: false; reason: string } | null> {
    const deadline = Date.now() + STREAM_WAIT_MS
    remotePhase = 'beaming'
    remoteNote = `Handing it to ${castStatus?.deviceName ?? 'the television'}…`

    while (Date.now() < deadline) {
      if (token !== switchToken) return null
      const result = await api.cast.beam()
      if (token !== switchToken) return null
      if (result.ok) {
        remotePhase = 'playing'
        remoteNote = ''
        castStatus = await api.cast.status()
        return { ok: true }
      }
      // A stream was found and the television could not take it: asking
      // again would only reload the TV with the same refusal.
      if (result.final)
        return { ok: false, reason: result.error ?? 'The television could not play it.' }
      await sleep(1200)
    }

    if (token !== switchToken) return null
    return {
      ok: false,
      reason: `${context?.providerName ?? 'This source'} has not handed over a stream yet. Some sources fetch nothing until their own play button is pressed.`,
    }
  }

  /** Hand over, and on failure say so in the remote — for the remote's own buttons. */
  async function handOverInRemote(token: number): Promise<void> {
    const result = await handOver(token)
    if (result === null || result.ok) return
    remotePhase = 'stuck'
    remoteNote = result.reason
  }

  /**
   * Step the television to another episode.
   *
   * Three things in order, and the order is the whole difficulty: this window
   * loads the episode, the provider fetches its stream, and only then can it be
   * sent. The television keeps showing the previous episode throughout — there
   * is nothing to put in its place until the last step — so the remote narrates
   * rather than pretending the jump was instant.
   */
  async function stepTo(step: EpisodePlace | null): Promise<void> {
    if (step === null || context === null) return
    const token = ++switchToken
    steppingTo = { season: step.season, episode: step.episode }

    remotePhase = 'switching'
    remoteNote = `Loading ${episodeCode(step.season, step.episode)} here first — the television is fed from this window.`
    api.goTo(step.season, step.episode)

    // Nothing is captured for a beat after a navigation; asking immediately
    // only burns the first attempt.
    await sleep(2000)
    if (token !== switchToken) return
    await handOverInRemote(token)
  }

  /** The season the television is playing, for the still. */
  const playingEpisodes = $derived(browsingSeason === context?.season ? episodes : [])

  type EpisodePlace = Pick<NextEpisode, 'season' | 'episode'>

  const remoteStep = $derived<EpisodePlace | null>(
    context?.season != null && context.episode != null
      ? { season: context.season, episode: context.episode }
      : null,
  )

  /**
   * The episode ⏮ and ⏭ count from: the one last asked for, until the player
   * reports having got there.
   *
   * `goTo` is a message to main and the new context comes back afterwards, so
   * counting from `remoteStep` alone would make a quick ⏭⏭ load the same
   * episode twice instead of skipping one.
   */
  let steppingTo = $state<EpisodePlace | null>(null)
  $effect(() => {
    const target = steppingTo
    if (
      target !== null &&
      remoteStep !== null &&
      target.season === remoteStep.season &&
      target.episode === remoteStep.episode
    )
      steppingTo = null
  })

  const remoteAt = $derived(steppingTo ?? remoteStep)
  /** A string, so the lookup below re-runs when the place changes and not on every new object. */
  const remoteAtKey = $derived(
    remoteAt === null || context === null
      ? ''
      : `${context.tmdbId}:${remoteAt.season}:${remoteAt.episode}`,
  )

  /**
   * Where ⏮ and ⏭ lead from `remoteAt`, looked up before either is pressed.
   *
   * Ahead of the press, because whether there *is* a next episode decides
   * whether ⏭ is enabled: the rule is auto-next's (`nextAiredEpisode`), which
   * stops at the last episode that has aired, and ⏮ from an episode 1 goes to
   * the last episode of the season before (`previousEpisode`). Both need
   * TMDB's season lists, which main caches. Keyed, so an answer for a place
   * the remote has since left is never shown for the one it is on.
   */
  let neighbours = $state<{
    key: string
    previous: EpisodePlace | null
    next: EpisodePlace | null
  }>({ key: '', previous: null, next: null })

  $effect(() => {
    const key = remoteAtKey
    if (!showRemote || key === '') return
    const at = untrack(() => remoteAt)
    const tmdbId = untrack(() => context?.tmdbId)
    if (at === null || tmdbId === undefined) return
    const season = (n: number): Promise<Season | null> => api.season(tmdbId, n)
    let live = true
    // The season count is not in the chrome's context; a season that does
    // not exist fails to fetch, and a failure answers "no next episode".
    void Promise.all([previousEpisode(at, season), nextAiredEpisode(at, Infinity, season)]).then(
      ([previous, next]) => {
        if (live) neighbours = { key, previous, next }
      },
    )
    return () => {
      live = false
    }
  })

  const remotePrevious = $derived(neighbours.key === remoteAtKey ? neighbours.previous : null)
  const remoteNext = $derived(neighbours.key === remoteAtKey ? neighbours.next : null)

  /**
   * The episode still, when the season happens to be loaded.
   *
   * Never fetched for its own sake. It is decoration on a control surface, and
   * a remote that waits for artwork before it can pause anything has its
   * priorities backwards.
   */
  const remoteArtwork = $derived(
    still(playingEpisodes.find((e) => e.episode === context?.episode)?.stillPath ?? null),
  )

  /** Load the season the moment the remote comes up, for the episode still. */
  $effect(() => {
    if (!showRemote) return
    if (context?.type !== 'tv' || context.season === null) return
    if (browsingSeason === context.season) return
    void loadSeason(context.season)
  })
</script>

<svelte:window onkeydown={onKeydown} />

{#snippet castRow(provider: { id: string; name: string }, castable: Castability)}
  {@const dot = providerDot(
    sourceState.outcomes[provider.id],
    verdicts[provider.id],
    reasons[provider.id],
  )}
  {@const test = scanning ? scanTesting.find((t) => t.providerId === provider.id) : undefined}
  {@const failed = castFailures[provider.id]}
  {@const current = provider.id === context?.providerId}
  <!-- While a cast runs, the source playing here is the one feeding the TV. -->
  {@const currentLabel = casting ? 'on the TV' : 'playing'}
  <button
    class="source"
    class:playing={current}
    title={failed}
    onclick={() => void castFrom(provider.id, provider.name)}
  >
    {#if dot.tone}
      <span class="dot" style:background={TONE[dot.tone]} title={dot.hint}></span>
    {:else}
      <span class="dot none" title={dot.hint}></span>
    {/if}
    <span class="name">{provider.name}</span>
    {#if test}
      <span class="tag">{test.recheck ? 'testing again…' : 'testing…'}</span>
    {:else if failed}
      <span class="tag bad">did not cast</span>
    {:else if castable === 'yes'}
      <span class="tag">{current ? `${currentLabel} · ` : ''}casts{measurement(provider.id)}</span>
    {:else if castable === 'likely'}
      <span class="tag">cast on another title</span>
    {:else if current}
      <span class="tag">{currentLabel}</span>
    {:else if dot.label || measurement(provider.id)}
      <span class="tag" class:bad={dot.tone === 'bad'}
        >{tagText(dot.label, measurement(provider.id))}</span
      >
    {/if}
  </button>
{/snippet}

{#snippet castList()}
  <!--
    Choose what to cast. The ordinary source list, in its ordinary order,
    narrowed to what a television can play — see `castGroups`. The test
    button is here too: it is what turns "not checked" rows into answers,
    live. Drawn here and rendered by the remote, because everything a row
    reads lives in this component.
  -->
  <div class="cast-list">
    {#if castFailureNote}
      <p class="hint bad">{castFailureNote}</p>
    {/if}
    <button class="source test" class:playing={scanning} onclick={toggleScan}>
      <span class="dot none"></span>
      <span class="name">{scanning ? 'Stop testing' : 'Test all sources'}</span>
      {#if scanning}
        <span class="tag"
          >{#if scanTotal > 0 && scanDone >= scanTotal}double-checking{:else}{scanDone}/{scanTotal}{/if}</span
        >
      {/if}
    </button>
    {#if castGroups.yes.length > 0}
      <p class="cast-group">Casts to this TV</p>
      {#each castGroups.yes as row (row.provider.id)}
        {@render castRow(row.provider, row.castable)}
      {/each}
    {/if}
    {#if castGroups.maybe.length > 0}
      <p class="cast-group">Not checked for casting yet</p>
      {#each castGroups.maybe as row (row.provider.id)}
        {@render castRow(row.provider, row.castable)}
      {/each}
    {/if}
    {#if castGroups.hidden > 0}
      <!-- Counted rather than silently dropped: a list that shrank for
           no stated reason reads as sources having gone missing. -->
      <p class="hint">
        {castGroups.hidden === 1
          ? '1 source only streams'
          : `${castGroups.hidden} sources only stream`} in a format this TV cannot play.
      </p>
    {/if}
  </div>
{/snippet}

<!--
  `onmouseenter`/`onmouseleave` on the chrome itself is what holds it open. The
  pointer merely being near the top is a trigger, handled above.
-->
{#if showRemote}
  <!--
    The remote is up, so this document is the remote and nothing else.

    Not stacked over the bar: the bar's four buttons are Back, reload, Episodes
    and the source picker, and reloading or changing source under a running cast
    is how you lose the stream. The remote carries what still means something —
    Back, Stop casting, the episode keys and its own source list — and the rest
    come back with the picture.
  -->
  <CastRemote
    status={castStatus}
    mode={remoteMode}
    title={context?.title ?? ''}
    subtitle={positionLabel}
    artwork={remoteArtwork}
    phase={remotePhase}
    phaseLabel={remoteNote}
    error={castError}
    episodic={context?.type === 'tv'}
    canPrevious={remotePrevious !== null}
    canNext={remoteNext !== null}
    sourceName={context?.providerName ?? ''}
    devices={castDevices}
    {selectedDevice}
    sources={castList}
    onselectdevice={(id) => (selectedDevice = id)}
    onchangesource={changeSource}
    oncancel={cancelChoice}
    onreveal={() => (remoteHidden = true)}
    onretry={() => void handOverInRemote(++switchToken)}
    onback={() => api.back()}
    onstop={() => void stopCasting()}
    ontoggle={() => void send(castStatus?.playing ? 'pause' : 'play')}
    onseek={(seconds) => void send('seek', seconds)}
    onnudge={(by) =>
      void send('seek', nudgeTarget(castStatus?.seconds ?? 0, by, castStatus?.duration ?? 0))}
    onprevious={() => void stepTo(remotePrevious)}
    onnext={() => void stepTo(remoteNext)}
    onvolume={(level) => void setReceiverVolume(level)}
    onmute={() => void setReceiverMuted(!(castStatus?.muted ?? false))}
  />
{:else if awayUntil !== null}
  <!--
    All that is left of the chrome while it is away, in a view exactly this
    size. A button, because the view takes clicks here anyway: better that
    they bring the bar back than land nowhere.
  -->
  <button
    class="away"
    style="width: {AWAY_PILL.width}px; height: {AWAY_PILL.height}px; margin-top: {AWAY_PILL.top}px"
    title="Show the controls now"
    onclick={comeBack}
  >
    Controls back in {awaySeconds}s
  </button>
{:else if !barVisible && touch}
  <!-- Nothing: our controls bring the bar back on the next tap. -->
{:else if !barVisible}
  <!--
    The invisible strip along the top edge. `onmousemove` as well as
    `onmouseenter`, because the enter can be missed: the bar hides by shrinking
    this view underneath a pointer that is already inside it, and no crossing
    means no `mouseenter` — the bar would then be unreachable until the pointer
    left and came back.
  -->
  <div
    class="hotzone"
    style="height: {HOT_ZONE_PX}px"
    aria-hidden="true"
    onmouseenter={() => (barVisible = true)}
    onmousemove={() => (barVisible = true)}
  ></div>
{:else}
  <div
    class="chrome"
    transition:fade={{ duration: touch ? 200 : 0 }}
    class:bottom-panels={bottomPanels}
    class:touch-chrome={touch}
    style:--above-controls="{ABOVE_OUR_CONTROLS}px"
    role="group"
    aria-label="Player controls"
    onmouseenter={() => (hoveringChrome = true)}
    onmouseleave={() => (hoveringChrome = false)}
  >
    <!--
      Icons, not words (the owner, 2026-09-27: darker, bigger, "simple icons
      like cast symbol, crossed out eye for hide button"). Each keeps its words
      as a tooltip and as the name a screen reader says. The source button
      alone keeps its text, because that text is information, not a label: it
      is the one place the bar says which source is playing.

      The shapes are Material Design icons, filled at 24 units, like the mini
      player's.
    -->
    <div class="bar" style="height: {BAR_HEIGHT}px">
      <button class="tool" title="Back" aria-label="Back" onclick={() => api.back()}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" />
        </svg>
      </button>

      <span class="title">{context?.title ?? ''}</span>
      {#if positionLabel}<span class="position">{positionLabel}</span>{/if}

      <span class="spacer"></span>

      {#snippet reloadButton()}
      <button
        class="tool"
        title="Reload this source"
        aria-label="Reload this source"
        onclick={() => void api.reload()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z"
          />
        </svg>
      </button>
      {/snippet}

      {#snippet castButton()}
      {#if castAvailable}
        <!--
          Two states. A cast that is running is the more important fact on this
          bar: the picture in front of the user is no longer where the film is.
          So while it runs the button is blue and its screen is filled in (the
          "connected" cast icon), and its tooltip and the remote name the
          television. The name used to be on the button itself, and that is the
          text the owner asked to lose.
        -->
        <button
          class="tool"
          class:casting={castStatus?.connected === true}
          title={castStatus?.connected ? `Playing on ${castStatus.deviceName}` : 'Play on a TV'}
          aria-label={castStatus?.connected
            ? `Playing on ${castStatus.deviceName}`
            : 'Play on a TV'}
          onclick={openRemote}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            {#if castStatus?.connected}
              <path
                d="M1 18v3h3a3 3 0 0 0-3-3zm0-4v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7zm18-7H5v1.63A13 13 0 0 1 13.37 17H19zM1 10v2a9 9 0 0 1 9 9h2A11 11 0 0 0 1 10zm20-7H3a2 2 0 0 0-2 2v3h2V5h18v14h-7v2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"
              />
            {:else}
              <path
                d="M21 3H3a2 2 0 0 0-2 2v3h2V5h18v14h-7v2h7a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM1 18v3h3a3 3 0 0 0-3-3zm0-4v2a5 5 0 0 1 5 5h2a7 7 0 0 0-7-7zm0-4v2a9 9 0 0 1 9 9h2A11 11 0 0 0 1 10z"
              />
            {/if}
          </svg>
        </button>
      {/if}
      {/snippet}

      {#if bottomPanels}
        <!-- Back, Cast, Reload (the owner, 2026-09-27): the source list and the
             episodes are in our controls at the bottom, and Hide has nothing
             left to uncover. -->
        {@render castButton()}
        {@render reloadButton()}
      {:else}
        {@render reloadButton()}

        <!-- Not on a phone: the bar never hides there, so it has no way back. -->
        {#if !touch}
          <button
            class="tool"
            title="Hide these controls for 5 seconds"
            aria-label="Hide these controls for 5 seconds"
            onclick={sendAway}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 7a5 5 0 0 1 4.64 6.83l2.92 2.92A11.8 11.8 0 0 0 23 12c-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16A4.85 4.85 0 0 1 12 7zM2 4.27l2.74 2.74A11.8 11.8 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84L19.73 22 21 20.73 3.27 3zM7.53 9.8l1.55 1.55A3 3 0 0 0 12.65 15l1.55 1.55A5 5 0 0 1 7.53 9.8zm4.31-.78 3.15 3.15.02-.16a3 3 0 0 0-3-3z"
              />
            </svg>
          </button>
        {/if}

        {#if context?.type === 'tv'}
          <button
            class="tool"
            class:active={panel === 'episodes'}
            title="Episodes"
            aria-label="Episodes"
            onclick={openEpisodes}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 10h11v2H3zm0-4h11v2H3zm0 8h7v2H3zm13-1v8l6-4z" />
            </svg>
          </button>
        {/if}

        {@render castButton()}

        <button
          class="tool source-button"
          class:active={panel === 'sources'}
          title="Choose the source"
          onclick={openSources}
        >
          <span class="source-name">{context?.providerName ?? 'Source'}</span>
          <svg viewBox="0 0 24 24" aria-hidden="true"
            ><path d="M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z" /></svg
          >
        </button>
      {/if}
    </div>

    {#if bottomPanels && panel !== 'none'}
      <!-- Beside a panel at the bottom, the view covers the picture: a click
           there closes the panel, as a click outside a menu does. -->
      <button class="backdrop" tabindex="-1" aria-label="Close" onclick={() => (panel = 'none')}></button>
    {/if}

    {#if panel === 'episodes'}
      <!--
        Two shapes of one list, and the difference is the screen, not taste.

        On a desktop it is a strip hanging from the bar: a window is wide, a
        season is a sequence, and the strip covers only the top of the picture.

        On a phone the same strip was two cards wide, so a ten-episode season
        was five screens of sideways swiping, each card too big to be anything
        but in the way. There it is a vertical list, a row per episode with the
        synopsis beside the still, like the detail view's own season list, in a
        panel centred on the screen. Held upright, the panel takes most of the
        screen; turned sideways, it hangs from the bar, two-thirds wide.

        Each episode carries what makes it recognisable at a glance: the still,
        its number and name, and how long it runs, or when it airs if it has
        not yet.
      -->
      <div
        class="panel episodes"
        class:bottom={bottomPanels && !touch}
        class:touch
        style:height={touch ? null : `${EPISODE_PANEL_HEIGHT}px`}
        style:--below-bar="{BAR_HEIGHT + PANEL_GAP}px"
      >
        <div class="episodes-head">
          <span class="season-name">{seasonName}</span>
          {#if !loadingEpisodes && episodes.length > 0}
            <span class="season-count">{episodes.length} episodes</span>
          {/if}
          {#if touch}
            <span class="spacer"></span>
            <button
              class="close"
              aria-label="Close the episode list"
              onclick={() => (panel = 'none')}
            >
              ✕
            </button>
          {/if}
        </div>

        {#if loadingEpisodes}
          <p class="hint">Loading episodes…</p>
        {:else if episodes.length === 0}
          <p class="hint">No episode list for this season.</p>
        {:else}
          <div class="episode-list" bind:this={episodeList}>
            {#each episodes as episode (episode.episode)}
              {@const aired = hasAired(episode.airDate)}
              {@const art = still(episode.stillPath)}
              <!-- Not playable before it airs: no provider can have it yet,
                   and the detail view's list draws the same line. -->
              <button
                class="episode"
                data-episode={episode.episode}
                class:highlighted={episode.episode === highlighted && !touch}
                class:playing={episode.episode === context?.episode &&
                  browsingSeason === context?.season}
                class:unaired={!aired}
                disabled={!aired}
                onclick={() => {
                  if (browsingSeason !== null) api.goTo(browsingSeason, episode.episode)
                  panel = 'none'
                }}
              >
                <span class="thumb">
                  {#if art}
                    <img src={art} alt="" loading="lazy" decoding="async" />
                  {:else}
                    <span class="thumb-empty" aria-hidden="true">{episode.episode}</span>
                  {/if}
                  {#if episode.episode === context?.episode && browsingSeason === context?.season}
                    <span class="now-playing">Playing</span>
                  {:else if aired}
                    <span class="play" aria-hidden="true">▶</span>
                  {/if}
                </span>
                <span class="meta">
                  <span class="ep-title">{episode.episode}. {episode.name || 'TBA'}</span>
                  <span class="ep-detail">{episodeDetail(episode, aired)}</span>
                  {#if touch && episode.overview}
                    <span class="ep-overview">{episode.overview}</span>
                  {/if}
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if panel === 'sources'}
      <div class="panel sources" class:bottom={bottomPanels}>
        <!--
          Pinned at the head, as in the detail view's picker: at the foot it was
          easy to miss, and it is what fills the dots in. Sticky, so it stays in
          reach while the list scrolls.
        -->
        <div class="sources-head">
          <button class="source test" class:playing={scanning} onclick={toggleScan}>
            <span class="dot none"></span>
            <span class="name">{scanning ? 'Stop testing' : 'Test all sources'}</span>
            {#if scanning}
              <!-- A count, not a name: the rows below mark every source under
                   test, and the menu is too narrow for the three names. Once
                   every source has a verdict only second tests remain. -->
              <span class="tag"
                >{#if scanTotal > 0 && scanDone >= scanTotal}double-checking{:else}{scanDone}/{scanTotal}{/if}</span
              >
            {/if}
          </button>
          <div class="sources-divider"></div>
        </div>
        {#each sourceRows as provider (provider.id)}
          {@const resume = provider.id === sourceState.resume?.providerId}
          {@const dot = providerDot(
            sourceState.outcomes[provider.id],
            verdicts[provider.id],
            reasons[provider.id],
          )}
          {@const test = scanning
            ? scanTesting.find((t) => t.providerId === provider.id)
            : undefined}
          {@const time = measurement(provider.id)}
          <button
            class="source"
            class:playing={provider.id === context?.providerId}
            onclick={() => {
              api.switchProvider(provider.id)
              panel = 'none'
            }}
          >
            <!--
              An empty slot rather than a grey dot when a provider has never
              been tried. A dot of any colour is a claim and "no idea" is not
              one; reserving the space is what keeps the names from shifting.
            -->
            {#if resume}
              <span class="dot" style:background={RESUME_COLOUR} title={resumeText?.hint}></span>
            {:else if dot.tone}
              <span class="dot" style:background={TONE[dot.tone]} title={dot.hint}></span>
            {:else}
              <span class="dot none" title={dot.hint}></span>
            {/if}
            <span class="name">{provider.name}</span>
            {#if provider.id === context?.providerId}
              <span class="tag">Playing{time}</span>
            {:else if resume}
              <span class="tag resume" title={resumeText?.hint}>{resumeText?.label}{time}</span>
            {:else if test}
              <span class="tag">{test.recheck ? 'testing again…' : 'testing…'}</span>
            {:else if dot.label || time}
              <span class="tag" class:bad={dot.tone === 'bad'}>{tagText(dot.label, time)}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<!--
  Always present, so `clientHeight` reads a real 0 when there is no offer.
  Binding on the banner itself would leave the last measured height behind
  when it unmounted, and the overlay would keep swallowing clicks on picture
  it had stopped drawing over.
-->
<div class="offer-slot" bind:clientHeight={suggestionHeight}>
  <!--
    Never while the remote is up. Two reasons, and the second is the serious
    one: it draws across the remote's header, and switching provider under a
    running cast clears the capture and abandons the stream the television is
    playing. The remote's `stuck` phase already gives the same advice for the
    case that matters, with the source picker one button away.
  -->
  {#if suggestion && !showRemote && awayUntil === null}
    <div class="suggestion" role="alert">
      <span class="reason">{suggestion.reason}.</span>
      <!--
        The seconds are hidden from assistive tech while the sentence is not:
        `role="alert"` re-announces its whole subtree on every change, so a
        live counter would read the banner out five times. The buttons carry
        the same information in their labels.
      -->
      <span class="offer">
        {#if suggestion.autoSwitch}
          Switching to {suggestion.nextProviderName}
          {#if countdown !== null}<span class="count" aria-hidden="true">in {countdown}s</span>{/if}
        {:else}
          Try {suggestion.nextProviderName} instead?
        {/if}
      </span>
      <button class="switch" onclick={switchNow}>Switch now</button>
      <button class="wait" onclick={keepWaiting}
        >{suggestion.autoSwitch ? 'Keep waiting' : 'Stay'}</button
      >

      <!-- A draining bar, so the deadline is legible without reading it. -->
      {#if countdown !== null}
        <div class="timer" aria-hidden="true">
          <span style:width="{(countdown / AUTOSWITCH_SECONDS) * 100}%"></span>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /*
    Deliberately draws nothing. It exists to be hovered — the view under it is
    sized to exactly this, so it is also the only part of the picture the
    overlay is costing the user while the chrome is away.
  */
  .hotzone {
    width: 100%;
  }

  /* Dark and small: it must read over any frame without becoming the thing
     that is in the way. */
  .away {
    display: block;
    box-sizing: border-box;
    padding: 0 12px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 15px;
    background: rgba(12, 12, 16, 0.78);
    color: #e9e9ee;
    cursor: pointer;
    font:
      500 13px/1 Inter,
      system-ui,
      sans-serif;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .offer-slot {
    font:
      500 13px/1.4 Inter,
      system-ui,
      sans-serif;
    color: #e9e9ee;
  }

  /*
    Floats over the picture rather than displacing it — which is the whole
    reason it moved into this document. Opaque, because it has to stay
    readable over whatever frame the video happens to be showing.
  */
  .suggestion {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 8px 14px;
    margin: 6px 14px 0;
    padding: 12px 16px;
    border-radius: 12px;
    background: rgba(8, 8, 12, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .reason {
    font-weight: 600;
  }

  .offer {
    color: #9a9aa6;
  }

  .suggestion button {
    border: none;
    border-radius: 999px;
    cursor: pointer;
    font:
      600 12px/1 Inter,
      system-ui,
      sans-serif;
    padding: 7px 14px;
    white-space: nowrap;
  }

  .switch {
    background: #e8b04b;
    color: #17130a;
  }

  .wait {
    background: rgba(255, 255, 255, 0.1);
    color: #e9e9ee;
  }

  .count {
    color: #e8b04b;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  /* On the banner's bottom edge, so it reads as the deadline for the whole
     prompt rather than as one more control in the row. */
  .timer {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 2px;
    background: rgba(255, 255, 255, 0.12);
  }

  .timer span {
    display: block;
    height: 100%;
    background: #e8b04b;
    /* Exactly one tick, linear: easing here would make the bar disagree with
       the number beside it. */
    transition: width 1s linear;
  }

  /*
    One look for everything the chrome draws: the bar's buttons, the source
    list, the episode browser and the cast panel. They had grown four styles
    (pale pills on the bar, near-black panels, a white hover in the lists,
    amber meaning "this one" in three different ways), and the owner asked for
    them to match (2026-09-27). The same dark surface, the same hairline, the
    same hover, and one amber for "active" and "playing". Radii nest: 12 for a
    panel, 10 for a button, 8 for a row inside a panel.
  */
  .chrome {
    --surface: rgba(10, 10, 14, 0.94);
    /* Opaque enough for things that scroll under it, like a sticky header. */
    --surface-solid: rgba(10, 10, 14, 0.98);
    --surface-button: rgba(10, 10, 14, 0.72);
    --line: rgba(255, 255, 255, 0.1);
    --hover: rgba(255, 255, 255, 0.08);
    --accent: #f0b45a;
    --accent-fill: rgba(240, 180, 90, 0.14);
    --accent-line: rgba(240, 180, 90, 0.6);

    font:
      500 13px/1 Inter,
      system-ui,
      sans-serif;
    color: #e9e9ee;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    /* Fading rather than a hard edge: the picture reads through the chrome
       instead of being cropped by a bar sitting on top of it. */
    background: linear-gradient(to bottom, rgba(8, 8, 12, 0.94), rgba(8, 8, 12, 0));
  }

  /*
    Truncates rather than pushing the controls off the end.

    A flex item's `min-width` is `auto`, so a long title refuses to shrink and
    everything to its right — reload, Episodes, the source switcher — slides
    past the edge of the bar. Harmless in a 1280px window and fatal at 412px,
    where "The Lord of the Rings: The Rings of Power" alone is wider than the
    screen and took the only exit with it.
  */
  .title {
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .position {
    color: #9a9aa6;
    font-size: 12px;
    flex-shrink: 0;
  }

  .spacer {
    flex: 1;
  }

  /*
    The bar's buttons: 46px squares with a 26px icon (40 and 22 until the
    owner asked for them a bit larger, 2026-09-27), dark enough to read over
    a bright picture. They were 30px pills of white at 8% over the bar's
    gradient, which on a bright frame went pale grey and hard to tell apart.
    Near-black at 70% keeps them the darkest thing in the corner whatever is
    playing. Never shrinks: these are the controls the title gives way for,
    not the other way round.
  */
  .tool {
    flex-shrink: 0;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    height: 46px;
    min-width: 46px;
    padding: 0 10px;
    background: var(--surface-button);
    border: 1px solid var(--line);
    border-radius: 10px;
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-size: 14px;
  }

  .tool svg {
    width: 26px;
    height: 26px;
    fill: currentColor;
    flex-shrink: 0;
  }

  /* The hover is laid over the surface rather than replacing it, so a button
     and a list row light up by the same amount. */
  .tool:hover {
    background: linear-gradient(var(--hover), var(--hover)), var(--surface);
  }

  .tool.active {
    background: linear-gradient(var(--accent-fill), var(--accent-fill)), var(--surface);
    border-color: var(--accent-line);
    color: var(--accent);
  }

  /* Room on the left for the name; the chevron sits close on the right. */
  .source-button {
    padding: 0 6px 0 12px;
  }

  /* A source's name is short, but a custom provider's can be anything. */
  .source-name {
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* v2: the panels open at the bottom, from the buttons in our own controls.
     The view then covers the whole picture (`neededArea`), so the bar and the
     panel are lifted over the backdrop that catches a click beside them. */
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 1;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: default;
  }

  .bottom-panels .bar {
    position: relative;
    z-index: 2;
  }

  .panel.bottom {
    position: fixed;
    z-index: 3;
    bottom: var(--above-controls);
    margin: 0;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55);
  }

  .episodes.bottom {
    left: 14px;
    right: 14px;
  }

  /* The phone's controls sit above the gesture bar. */
  .touch-chrome .panel.bottom {
    bottom: calc(var(--above-controls) + var(--safe-bottom, 0px));
  }

  .sources.bottom {
    right: 14px;
    max-height: min(420px, calc(100vh - var(--above-controls) - 80px));
  }

  .panel {
    margin: 6px 14px 0;
    border-radius: 12px;
    background: var(--surface);
    border: 1px solid var(--line);
    overflow: hidden;
    /* Inherited by every list inside. The chrome's document declares no
       colour scheme, so without it a scrollbar is the platform's light one: a
       white bar across a dark panel. */
    scrollbar-color: rgba(255, 255, 255, 0.22) transparent;
  }

  /* The desktop strip. Its height is set inline from `EPISODE_PANEL_HEIGHT`,
     which the view is sized by, so border-box keeps the two the same number. */
  .episodes {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
  }

  .episodes-head {
    align-items: baseline;
    display: flex;
    flex-shrink: 0;
    gap: 10px;
    padding: 12px 16px 0;
  }

  .season-name {
    font-size: 14px;
    font-weight: 600;
  }

  .season-count {
    color: #9a9aa6;
    font-size: 12px;
  }

  .hint {
    color: #9a9aa6;
    margin: 0;
    padding: 24px;
  }

  .episode-list {
    display: flex;
    flex: 1;
    gap: 14px;
    min-height: 0;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 10px 16px 6px;
    scrollbar-width: thin;
  }

  .episode {
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    font: inherit;
    gap: 8px;
    padding: 0;
    text-align: left;
    width: 192px;
  }

  .episode:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .thumb {
    aspect-ratio: 16 / 9;
    background: #17171d;
    border-radius: 8px;
    display: block;
    overflow: hidden;
    position: relative;
    transition: box-shadow 0.12s ease-out;
    width: 100%;
  }

  .thumb img {
    display: block;
    filter: brightness(0.92);
    height: 100%;
    object-fit: cover;
    transition: filter 0.12s ease-out;
    width: 100%;
  }

  .thumb-empty {
    color: #4a4a55;
    display: grid;
    font-size: 26px;
    font-weight: 600;
    height: 100%;
    place-items: center;
  }

  /* Shown on hover only: on every card at once it is a column of identical
     glyphs, and it says nothing a pointer over a card does not already. */
  .play {
    background: rgba(8, 8, 12, 0.6);
    border-radius: 50%;
    box-sizing: border-box;
    display: grid;
    font-size: 13px;
    height: 34px;
    left: 50%;
    opacity: 0;
    padding-left: 3px;
    place-items: center;
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%);
    transition: opacity 0.12s ease-out;
    width: 34px;
  }

  .episode:not(:disabled):hover .thumb img {
    filter: brightness(1.05);
  }

  .episode:not(:disabled):hover .play {
    opacity: 1;
  }

  .episode.playing .thumb {
    box-shadow: 0 0 0 2px var(--accent);
  }

  /* Where the arrows are: lifted, with a white ring, apart from the amber of
     the playing episode. */
  .episode .thumb {
    transition:
      box-shadow 0.18s ease-out,
      transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1.2);
  }

  .episode.highlighted .thumb {
    box-shadow:
      0 0 0 3px #f4f4f6,
      0 8px 24px rgba(0, 0, 0, 0.55);
    transform: translateY(-3px) scale(1.03);
  }

  .episode.highlighted .ep-title {
    color: #fff;
  }

  .now-playing {
    background: var(--accent);
    border-radius: 5px;
    color: #17110a;
    font-size: 11px;
    font-weight: 700;
    left: 6px;
    padding: 3px 6px;
    position: absolute;
    top: 6px;
  }

  .meta {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
  }

  .ep-title {
    font-size: 13.5px;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ep-detail {
    color: #9a9aa6;
    font-size: 12px;
  }

  /*
    The phone's list, held upright: a panel centred on the screen, taking most
    of it, with the same gap above and below (the bar's height). It was a
    sheet sized to the black under the picture until the owner asked for it
    centred and larger (2026-09-27): half a phone held only three or four
    rows. `margin: auto` between `left: 0` and `right: 0` is what centres a
    fixed box of a set width.
  */
  .episodes.touch {
    /* Over the backdrop, as `.panel.bottom` is: this panel is not a bottom
       one, and without it the backdrop (z-index 1) took every tap on a row,
       so picking an episode only closed the list. */
    z-index: 3;
    background: var(--surface-solid);
    border-radius: 16px;
    border-width: 1px;
    bottom: calc(var(--safe-bottom, 0px) + var(--below-bar));
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55);
    height: auto;
    left: 0;
    margin: 0 auto;
    position: fixed;
    right: 0;
    top: calc(var(--safe-top, 0px) + var(--below-bar));
    width: min(640px, calc(100vw - 24px));
  }

  .touch .episodes-head {
    align-items: center;
    padding: 6px 6px 4px 16px;
  }

  .touch .season-name {
    font-size: 16px;
  }

  .close {
    background: none;
    border: 0;
    border-radius: 50%;
    color: #c9c9d2;
    font: inherit;
    font-size: 16px;
    height: 44px;
    width: 44px;
  }

  .touch .episode-list {
    flex-direction: column;
    gap: 2px;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0 6px 10px;
  }

  .touch .episode {
    align-items: start;
    border-radius: 10px;
    display: grid;
    gap: 12px;
    grid-template-columns: 124px minmax(0, 1fr);
    padding: 8px 10px;
    width: auto;
  }

  .touch .episode.playing {
    background: var(--accent-fill);
  }

  .touch .play {
    display: none;
  }

  .touch .ep-title {
    font-size: 15px;
    font-weight: 600;
  }

  .touch .meta {
    gap: 4px;
    padding-top: 2px;
  }

  .ep-overview {
    color: #a7a7b2;
    font-size: 12.5px;
    font-weight: 400;
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* A phone turned sideways has little height to spare, so the panel runs
     down to the screen's foot and is two-thirds of the width. The owner chose
     that over a narrow column down the right edge (2026-09-26): the synopsis
     gets room to be read. */
  @media (orientation: landscape) {
    .episodes.touch {
      border-radius: 12px;
      bottom: calc(8px + var(--safe-bottom, 0px));
      width: min(640px, 66vw);
    }
  }

  .sources {
    max-height: 288px;
    overflow-y: auto;
    padding: 6px;
    width: 280px;
    margin-left: auto;
    margin-right: 14px;
  }

  /* Covers the list's 6px padding, so rows scrolling under it do not show above it. */
  .sources-head {
    position: sticky;
    top: -6px;
    z-index: 1;
    margin: -6px -6px 0;
    padding: 6px 6px 0;
    background: var(--surface-solid);
  }

  .sources-divider {
    height: 1px;
    margin: 4px 0;
    background: var(--line);
  }

  /* Rows sized to sit under 40px buttons: 13.5px text, 38px tall. */
  .source {
    align-items: center;
    background: none;
    border: none;
    border-radius: 8px;
    box-sizing: border-box;
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: 13.5px;
    gap: 10px;
    min-height: 38px;
    padding: 9px 12px;
    text-align: left;
    width: 100%;
  }

  /* Takes the slack, so the tag stays pinned to the right edge. */
  .source .name {
    flex: 1;
  }

  .dot {
    border-radius: 50%;
    flex: 0 0 auto;
    height: 7px;
    width: 7px;
  }

  /* The reserved blank. See the comment on the markup. */
  .dot.none {
    background: none;
  }

  .source:hover {
    background: var(--hover);
  }

  /* The source playing now: the same amber, and the same tint, as the active
     button above it and the playing episode. */
  .source.playing {
    background: var(--accent-fill);
    color: var(--accent);
  }

  .tag {
    color: #9a9aa6;
    flex: 0 0 auto;
    font-size: 12px;
  }

  .tag.resume {
    color: #5b9dfa;
  }

  .tag.bad {
    color: #fb5c76;
  }

  /* ── Casting ──────────────────────────────────────────────────────────────
     A running cast is a mode, not a setting, so it is coloured rather than
     ticked: the picture on this screen is no longer where the film is, and
     that has to be readable at a glance from across the room. */

  .tool.casting {
    background: rgba(24, 46, 84, 0.9);
    border-color: rgba(91, 157, 250, 0.65);
    color: #cfe0ff;
  }

  /*
    The source list, rendered inside the remote.

    The remote is drawn outside `.chrome`, so the tokens the rows are styled
    with are declared again here — the same values, so a row in the remote is
    a row in the source picker.
  */
  .cast-list {
    --surface: rgba(10, 10, 14, 0.94);
    --surface-solid: rgba(10, 10, 14, 0.98);
    --line: rgba(255, 255, 255, 0.1);
    --hover: rgba(255, 255, 255, 0.08);
    --accent: #f0b45a;
    --accent-fill: rgba(240, 180, 90, 0.14);
    padding: 0 6px 6px;
    font:
      500 13px/1 Inter,
      system-ui,
      sans-serif;
  }

  .cast-list .hint {
    padding: 10px 12px;
    line-height: 1.4;
  }

  /* The two groups' headings: small caps-ish labels, like the season picker's. */
  .cast-group {
    margin: 8px 0 2px;
    padding: 0 12px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.45);
  }

  .hint.bad {
    color: #fb5c76;
    padding: 12px 16px;
  }
</style>
