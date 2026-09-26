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
  import { formatQuality, formatStreamTime, inScanOrder, providerDot, resumeNote, sharedLabel } from '@shared/scanrank'
  import type { Castability } from '@shared/castability'
  import { untrack } from 'svelte'
  import type { Episode, StreamDelivery } from '@shared/types'
  import { clock } from './lib/format'
  import CastRemote from './components/CastRemote.svelte'
  import {
    nextEpisode,
    nudgeTarget,
    previousEpisode,
    STREAM_WAIT_MS,
    type EpisodeStep,
    type RemotePhase,
  } from './lib/castremote'

  const BAR_HEIGHT = 56
  const EPISODE_PANEL_HEIGHT = 226
  const SOURCE_PANEL_MAX = 300
  /** `.panel`'s top margin, which sits between the bar and the panel itself. */
  const PANEL_GAP = 6
  /** Enough for the "Looking for a TV" line, until the panel has been measured. */
  const CAST_PANEL_FALLBACK = 74
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

  const api = window.wtaChrome

  let context = $state<PlayerContext | null>(null)
  let panel = $state<'none' | 'episodes' | 'sources' | 'cast'>('none')
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
    // The cast list is a question held open with a television waiting on it;
    // hiding the chrome would leave the TV held with nothing to answer.
    if (castChoosing) void cancelCastChoice()
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

  $effect(() =>
    api?.onProviderScan((progress) => {
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

  /** Live run first, falling back to whatever was stored for this title. */
  const verdicts = $derived<Record<string, ProbeVerdict>>(
    Object.keys(scanVerdicts).length > 0 ? scanVerdicts : (sourceState.scan?.verdicts ?? {}),
  )
  /** Time to stream for the sources that streamed, from the same run as `verdicts`. */
  const timings = $derived<Record<string, number>>(
    Object.keys(scanVerdicts).length > 0 ? scanTimings : (sourceState.scan?.timings ?? {}),
  )
  const qualities = $derived<Record<string, number>>(
    Object.keys(scanVerdicts).length > 0 ? scanQualities : (sourceState.scan?.qualities ?? {}),
  )
  const reasons = $derived<Record<string, ScanReason>>(
    Object.keys(scanVerdicts).length > 0 ? scanReasons : (sourceState.scan?.reasons ?? {}),
  )

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
   * " · on your computer" for a result measured on another of the user's
   * devices, so a green from elsewhere is not passed off as this device's own.
   * Not during a live run here, whose results are all this device's.
   */
  function sharedNote(id: string): string {
    if (Object.keys(scanVerdicts).length > 0) return ''
    return sharedLabel(sourceState.sharedFrom[id])
  }

  /**
   * The menu's rows, in Automatic's order as of the last re-read.
   *
   * Not re-sorted while a test runs — `sourceState` is re-read only when it
   * finishes — so the rows hold still while their dots fill in.
   */
  const sourceRows = $derived(inScanOrder(context?.providers ?? [], sourceState.order))

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
    // Re-read so the dots and the stored scan describe one moment.
    sourceState = await api.outcomes(media)
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
  /** Set while a beam is in flight, so the panel can say what is happening. */
  let castBusy = $state(false)
  /** The last failure, in the user's words. Cleared when they try again. */
  let castError = $state<string | null>(null)
  /** The cast panel's rendered height, bound from the DOM. See `panelHeight`. */
  let castPanelHeight = $state(0)

  /* ── The remote ───────────────────────────────────────────────────────────
   *
   * A connected television replaces the chrome rather than adding to it. The
   * picture is elsewhere, this window is muted or blanked, and a 56px bar over
   * a black rectangle is a control surface for nothing — so while a cast is
   * running this document draws one thing, full bleed. The rest of the
   * machinery is further down, beside the episode helpers it uses; these three
   * are here because the height calculation needs them.
   */

  const casting = $derived(castStatus?.connected === true)

  /**
   * Stood down on request, while still casting.
   *
   * The single reason it exists: a provider that has not started fetching needs
   * its own play button pressed, and that button is on the page the remote is
   * covering. Reset whenever a cast starts or ends, so it can never be the
   * state a user comes back to.
   */
  let remoteHidden = $state(false)
  /** Connected, and waiting for the user to choose a source — see `castFrom`. The remote stays down meanwhile. */
  let castChoosing = $state(false)
  const showRemote = $derived(casting && !remoteHidden && !castChoosing)

  /* ── Choosing what to cast ────────────────────────────────────────────────
   *
   * Agreed with the owner 2026-09-26: connecting to a television no longer
   * sends whatever happens to be playing. It opens a list — the ordinary
   * source list, narrowed to what can cast — and the user picks. Only then is
   * the source loaded here, started, and handed over.
   *
   * The reason is the receiver. A plain Chromecast plays a whole MP4 and
   * refuses HLS, and most sources hand out HLS, so "cast what is playing" was
   * a coin toss the user could not see. See `shared/castability.ts`.
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
    const live = scanDelivery[id]
    if (live === 'progressive') return 'yes'
    if (live === 'segmented' || live === 'other') return 'no'
    return sourceState.castability[id] ?? 'unknown'
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
    try {
      sourceState = await api.outcomes({ type: context.type, imdbId: context.imdbId, tmdbId: context.tmdbId })
    } catch {
      // No record is a fair answer: every dot is blank, every source unchecked.
      sourceState = NO_SOURCE_STATE
    }
  }

  /**
   * Cast from one source: load it here, start it, hand it over.
   *
   * The television is fed from this window, so a source not already playing
   * has to be loaded here first. A failure of any kind comes back to the list
   * rather than to the remote's "stuck" state: the question at that moment is
   * which source to try next, and the list is where that is answered.
   */
  async function castFrom(providerId: string, providerName: string): Promise<void> {
    if (context === null) return
    const token = ++switchToken
    castChoosing = false
    castFailureNote = null
    panel = 'none'

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
    castChoosing = true
    panel = 'cast'
    // The attempt was filed as a measurement; the list should reflect it.
    void refreshSourceState()
  }

  /** Close the list without choosing: let the television go rather than leave it held. */
  async function cancelCastChoice(): Promise<void> {
    castChoosing = false
    castFailureNote = null
    panel = 'none'
    await stopCasting()
  }


  /*
   * Scrubbing, and why the slider does not simply show `castStatus.seconds`.
   *
   * Two moments would fight with the once-a-second poll. While a thumb is being
   * dragged, every tick would yank it back to where the television still is;
   * and just after a seek is committed, the television keeps reporting the old
   * position for a beat, so the thumb would snap back and then jump forward —
   * which reads as the seek having been ignored, and invites a second one.
   *
   * So a locally-held value wins for as long as it is fresh, and the poll takes
   * over again once the television has caught up.
   */
  const SCRUB_HOLD_MS = 2500
  let scrubHeld = $state(0)
  let scrubHeldUntil = $state(0)
  /** Re-evaluated by the same tick that polls status, so the hold can expire. */
  let now = $state(Date.now())

  const scrubSeconds = $derived(
    now < scrubHeldUntil ? scrubHeld : (castStatus?.seconds ?? 0),
  )

  function onScrubInput(value: number): void {
    scrubHeld = value
    // Dragging is a stream of `input` events; the hold is refreshed by each so
    // it only starts expiring once the thumb is let go.
    scrubHeldUntil = Date.now() + SCRUB_HOLD_MS
    now = Date.now()
  }

  async function commitScrub(value: number): Promise<void> {
    onScrubInput(value)
    await send('seek', value)
  }

  /** Jump relative to where the television actually is, clamped to the film. */
  async function nudge(delta: number): Promise<void> {
    const duration = castStatus?.duration ?? 0
    const target = Math.max(0, Math.min(scrubSeconds + delta, duration > 0 ? duration : Infinity))
    await commitScrub(target)
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
   * Poll while connected, and only while connected.
   *
   * The position on the television is the one thing the phone cannot be told
   * about — `RemoteMediaClient` reports it to native code, and pushing every
   * tick across the bridge would cost more than reading it once a second. The
   * interval is torn down when the panel closes so a backgrounded player is not
   * waking the bridge forever.
   */
  $effect(() => {
    if (!castAvailable) return
    if (panel !== 'cast' && !castStatus?.connected) return

    const tick = (): void => {
      now = Date.now()
      void api?.cast.status().then((next) => (castStatus = next))
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  })

  function openCast(): void {
    if (panel === 'cast') {
      if (castChoosing) {
        void cancelCastChoice()
        return
      }
      panel = 'none'
      return
    }
    panel = 'cast'
    castError = null
  }

  /**
   * Sweep for televisions for as long as the panel is open.
   *
   * One query is not enough, and asking once was the second reason this button
   * appeared to do nothing. On the desktop `startDiscovery` *is* the mDNS
   * query — it takes three seconds and only then is there anything to read —
   * so firing it and reading `devices()` in the same breath reliably returns
   * the empty list from before it ran. Android's is a live scan that fills in
   * over the same sort of interval.
   *
   * So: ask, read, ask again, until the panel closes. `MIN_SWEEP_MS` is a floor
   * rather than a delay — it costs nothing on desktop, where the query already
   * takes longer, and stops the loop spinning on a platform that returns at
   * once.
   */
  const MIN_SWEEP_MS = 2500

  $effect(() => {
    if (!castAvailable || panel !== 'cast') return

    let sweeping = true

    const sweep = async (): Promise<void> => {
      while (sweeping) {
        const startedAt = Date.now()
        try {
          await api.cast.startDiscovery()
          if (!sweeping) return
          castDevices = await api.cast.devices()
        } catch {
          // A discovery that fails is not worth a message: the panel already
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
   * Connect, then ask what to cast.
   *
   * It used to connect and send whatever was playing in one action, because a
   * Chromecast connected with nothing on it shows its idle screen and reads
   * as a failure. Now the list of castable sources follows at once, in the
   * same panel, so the idle screen lasts only as long as the choice does.
   */
  async function castTo(deviceId: string): Promise<void> {
    castBusy = true
    castError = null
    try {
      const connected = await api.cast.connect(deviceId)
      if (!connected.ok) {
        castError = connected.error ?? 'Could not connect to that TV.'
        return
      }
      castFailures = {}
      castFailureNote = null
      castChoosing = true
      void refreshSourceState()
    } finally {
      castBusy = false
      castStatus = await api.cast.status()
    }
  }

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
    if (context === null) return
    void api
      .outcomes({ type: context.type, imdbId: context.imdbId, tmdbId: context.tmdbId })
      .then((result) => (sourceState = result))
      .catch(() => {
        // No record is a fair answer: every dot is simply blank, which is what
        // "never tried" looks like anyway.
        sourceState = NO_SOURCE_STATE
      })
  }

  /** Episodes of the season being browsed, which need not be the one playing. */
  let browsingSeason = $state<number | null>(null)
  let episodes = $state<Episode[]>([])
  let loadingEpisodes = $state(false)

  $effect(() => api?.onContext((next) => (context = next)))

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
  $effect(() => api?.onSuggestion((next) => (suggestion = next)))

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

    /**
     * The seconds live in a plain local and are only mirrored into state.
     * Reading `countdown` inside the effect would make the effect depend on a
     * value it writes every tick, so each tick would tear the interval down
     * and start another — which once produced two intervals and switched the
     * provider twice.
     */
    let left = untrack(() => countdown) ?? AUTOSWITCH_SECONDS
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
    // Nor may it close under the cast list: closing it lets the TV go.
    if (castChoosing) barVisible = true
  })

  $effect(() => {
    if (!barVisible) return
    if (touch) return
    if (suggestion) return
    if (castChoosing) return
    // Hovering the chrome holds it open — including hovering a panel, which is
    // a child of it. Nothing else does.
    if (hoveringChrome) return
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
   * The two fixed panels declare their own height in CSS, so a constant is
   * honest for them. The cast panel does not: it is a hint, or a list of
   * however many televisions are on the Wi-Fi, or a pair of transport buttons,
   * and each is a different size. So it is measured instead — which is also
   * what keeps the reserved strip from swallowing clicks on the video below a
   * panel that only needed a line of text.
   *
   * Leaving `cast` out of this is what made the button look dead: the panel
   * rendered into a view still only `BAR_HEIGHT` tall and was clipped away
   * entirely, so nothing appeared and nothing explained why.
   */
  const panelHeight = $derived(
    panel === 'episodes'
      ? EPISODE_PANEL_HEIGHT
      : panel === 'sources'
        ? SOURCE_PANEL_MAX
        : panel === 'cast'
          ? (castPanelHeight || CAST_PANEL_FALLBACK) + PANEL_GAP
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
        ? { height: AWAY_PILL.top + AWAY_PILL.height, width: AWAY_PILL.width }
        : {
            height: (barVisible ? BAR_HEIGHT + panelHeight : HOT_ZONE_PX) + suggestionHeight,
            width: null,
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
    try {
      const result = await api.season(context.tmdbId, season)
      // Guard against a slow answer for a season the user has since left.
      if (browsingSeason === season) episodes = result?.episodes ?? []
    } catch {
      // A failed fetch leaves the strip empty rather than breaking the chrome;
      // the player itself is unaffected by not knowing the episode list.
      if (browsingSeason === season) episodes = []
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

  /** "1h 2m", "52m", or nothing at all rather than a misleading "0m". */
  function runtimeLabel(minutes: number | null): string {
    if (minutes === null || minutes <= 0) return ''
    const hours = Math.floor(minutes / 60)
    return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
  }

  const positionLabel = $derived(
    context === null || context.season === null || context.episode === null
      ? ''
      : `S${String(context.season).padStart(2, '0')}E${String(context.episode).padStart(2, '0')}`,
  )

  /* ── The remote ───────────────────────────────────────────────────────────
   *
   * A connected television replaces the chrome rather than adding to it. The
   * picture is elsewhere, this window is blanked or muted, and a 56px bar over
   * a black rectangle is a control surface for nothing — so while a cast is
   * running this document draws one thing, full bleed. See `CastRemote.svelte`.
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

  $effect(() => {
    if (casting) return
    // Whatever the remote was in the middle of stopped mattering the moment
    // the television let go.
    switchToken += 1
    remoteHidden = false
    remotePhase = 'playing'
    remoteNote = ''
    castChoosing = false
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
  async function handOver(token: number): Promise<{ ok: true } | { ok: false; reason: string } | null> {
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
      if (result.final) return { ok: false, reason: result.error ?? 'The television could not play it.' }
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
  async function stepTo(step: EpisodeStep | null): Promise<void> {
    if (step === null || context === null) return
    const token = ++switchToken

    remotePhase = 'switching'
    remoteNote = `Loading S${String(step.season).padStart(2, '0')}E${String(step.episode).padStart(2, '0')} here first — the television is fed from this window.`
    api.goTo(step.season, step.episode)

    // Nothing is captured for a beat after a navigation; asking immediately
    // only burns the first attempt.
    await sleep(2000)
    if (token !== switchToken) return
    await handOverInRemote(token)
  }

  /** The season the television is playing, for `canNext` and the still. */
  const playingEpisodes = $derived(
    browsingSeason === context?.season ? episodes : [],
  )

  const remoteStep = $derived<EpisodeStep | null>(
    context?.season != null && context.episode != null
      ? { season: context.season, episode: context.episode }
      : null,
  )

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

  /**
   * Load the season the moment the remote comes up.
   *
   * For the still, and for the one thing `nextEpisode` cannot decide without
   * it: whether this is the last episode of the season.
   */
  $effect(() => {
    if (!showRemote) return
    if (context?.type !== 'tv' || context.season === null) return
    if (browsingSeason === context.season) return
    void loadSeason(context.season)
  })
</script>

{#snippet castRow(provider: { id: string; name: string }, castable: Castability)}
  {@const dot = providerDot(sourceState.outcomes[provider.id], verdicts[provider.id], reasons[provider.id])}
  {@const test = scanning ? scanTesting.find((t) => t.providerId === provider.id) : undefined}
  {@const failed = castFailures[provider.id]}
  <button
    class="source"
    class:playing={provider.id === context?.providerId}
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
      <span class="tag">{provider.id === context?.providerId ? 'playing · ' : ''}casts{measurement(provider.id)}</span>
    {:else if castable === 'likely'}
      <span class="tag">cast on another title</span>
    {:else if provider.id === context?.providerId}
      <span class="tag">playing</span>
    {:else if dot.label}
      <span class="tag" class:bad={dot.tone === 'bad'}>{dot.label}{measurement(provider.id)}</span>
    {/if}
  </button>
{/snippet}

<!--
  `onmouseenter`/`onmouseleave` on the chrome itself is what holds it open. The
  pointer merely being near the top is a trigger, handled above.
-->
{#if showRemote}
  <!--
    A television is attached, so this document is the remote and nothing else.

    Not stacked over the bar: the bar's four buttons are Back, reload, Episodes
    and the source picker, and reloading or changing source under a running cast
    is how you lose the stream. The remote carries the two that still mean
    something — Back, and Stop casting — and the rest come back with the
    picture.
  -->
  <CastRemote
    status={castStatus!}
    title={context?.title ?? ''}
    subtitle={[positionLabel, context?.providerName ?? ''].filter(Boolean).join(' · ')}
    artwork={remoteArtwork}
    phase={remotePhase}
    phaseLabel={remoteNote}
    canPrevious={previousEpisode(remoteStep) !== null}
    canNext={nextEpisode(remoteStep, playingEpisodes.length) !== null}
    onreveal={() => (remoteHidden = true)}
    onretry={() => void handOverInRemote(++switchToken)}
    onback={() => api.back()}
    onstop={() => void stopCasting()}
    ontoggle={() => void send(castStatus?.playing ? 'pause' : 'play')}
    onseek={(seconds) => void send('seek', seconds)}
    onnudge={(by) =>
      void send('seek', nudgeTarget(castStatus?.seconds ?? 0, by, castStatus?.duration ?? 0))}
    onprevious={() => void stepTo(previousEpisode(remoteStep))}
    onnext={() => void stepTo(nextEpisode(remoteStep, playingEpisodes.length))}
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
{:else if !barVisible && !touch}
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
    role="group"
    aria-label="Player controls"
    onmouseenter={() => (hoveringChrome = true)}
    onmouseleave={() => (hoveringChrome = false)}
  >
    <div class="bar" style="height: {BAR_HEIGHT}px">
      <button class="ghost" onclick={() => api.back()}>← Back</button>

      <span class="title">{context?.title ?? ''}</span>
      {#if positionLabel}<span class="position">{positionLabel}</span>{/if}

      <span class="spacer"></span>

      <button class="ghost" title="Reload this source" onclick={() => void api.reload()}>↻</button>

      <!-- Not on a phone: the bar never hides there, so it has no way back. -->
      {#if !touch}
        <button class="ghost" title="Hide these controls for 5 seconds" onclick={sendAway}>
          Hide
        </button>
      {/if}

      {#if context?.type === 'tv'}
        <button class="ghost" class:active={panel === 'episodes'} onclick={openEpisodes}>
          Episodes
        </button>
      {/if}

      {#if castAvailable}
        <!--
          Two states, not one. A cast that is running is the more important
          fact on this bar — the picture in front of the user is not where the
          film is any more — so it says the device's name rather than an icon
          that could mean either thing.

          The word is in its own span because on a phone it has to go. A series
          adds an Episodes button, and Back + ↻ + Episodes + Cast + source is
          five pixels wider than a 412px viewport — measured, with the source
          button hanging off the right edge. The symbol stays, the panel still
          names the device, and nothing is clipped.
        -->
        <button
          class="ghost cast"
          class:active={panel === 'cast'}
          class:casting={castStatus?.connected === true}
          title={castStatus?.connected ? `Playing on ${castStatus.deviceName}` : 'Play on a TV'}
          onclick={casting ? () => (remoteHidden = false) : openCast}
        >
          <span class="glyph" aria-hidden="true">▣</span>
          <span class="label">{castStatus?.connected ? castStatus.deviceName : 'Cast'}</span>
        </button>
      {/if}

      <button class="ghost" class:active={panel === 'sources'} onclick={openSources}>
        {context?.providerName ?? 'Source'} ▾
      </button>
    </div>

    {#if panel === 'episodes'}
      <!--
        A strip that floats over the picture rather than displacing it. Each
        card carries the same three facts the series detail view shows, because
        that is what makes an episode recognisable: the still, what it is
        called, and how long it runs.
      -->
      <div class="panel episodes">
        {#if loadingEpisodes}
          <p class="hint">Loading episodes…</p>
        {:else if episodes.length === 0}
          <p class="hint">No episode list for this season.</p>
        {:else}
          <div class="strip">
            {#each episodes as episode (episode.episode)}
              <button
                class="episode"
                class:playing={episode.episode === context?.episode &&
                  browsingSeason === context?.season}
                onclick={() => {
                  if (browsingSeason !== null) api.goTo(browsingSeason, episode.episode)
                  panel = 'none'
                }}
              >
                <span class="thumb">
                  {#if still(episode.stillPath)}
                    <img src={still(episode.stillPath)} alt="" loading="lazy" />
                  {/if}
                </span>
                <span class="meta">
                  <span class="ep-title">{episode.episode}. {episode.name}</span>
                  <span class="ep-runtime">{runtimeLabel(episode.runtime)}</span>
                </span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if panel === 'cast'}
      <div class="panel cast-panel" bind:clientHeight={castPanelHeight}>
        <!--
          `castBusy` is tested before `connected` on purpose. Connecting
          succeeds a second or two before the stream is found, and a TV that is
          attached with nothing playing reports exactly what a TV whose stream
          died reports — so testing `connected` first puts a red "stream ended"
          on screen for the whole of a perfectly normal beam.
        -->
        {#if castBusy}
          <p class="hint">Connecting…</p>
        {:else if castChoosing}
          <!--
            Choose what to cast. The ordinary source list, in its ordinary
            order, narrowed to what this television can play — see
            `castGroups`. The test button is here too: it is what turns
            "not checked" rows into answers, live.
          -->
          <p class="cast-head">
            Connected to <span class="name">{castStatus?.deviceName ?? 'the TV'}</span>. Choose a source to cast.
          </p>
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
              {castGroups.hidden === 1 ? '1 source only streams' : `${castGroups.hidden} sources only stream`} in a format
              this TV cannot play.
            </p>
          {/if}
          <button class="source stop" onclick={() => void cancelCastChoice()}>Cancel</button>
        {:else if castStatus?.connected}
          <div class="cast-now">
            <span class="name">Playing on {castStatus.deviceName}</span>
            {#if !castStatus.proxyRunning}
              <!--
                Connected but not serving. Worth its own words: the television
                is attached and the stream behind it has stopped, which looks
                identical to "paused" from the sofa.
              -->
              <span class="tag bad">stream ended</span>
            {/if}
          </div>
          <!--
            Transport for the television.
            
            The picture is on the other side of the room, so this is the only
            way to reach it — the provider's own controls drive the copy still
            running in this window, not the one on the TV.
          -->
          <div class="scrub">
            <span class="time">{clock(scrubSeconds)}</span>
            <input
              type="range"
              min="0"
              max={Math.max(castStatus.duration, 1)}
              step="1"
              value={scrubSeconds}
              disabled={castStatus.duration <= 0}
              aria-label="Position on the TV"
              oninput={(event) => onScrubInput(event.currentTarget.valueAsNumber)}
              onchange={(event) => void commitScrub(event.currentTarget.valueAsNumber)}
            />
            <span class="time">{clock(castStatus.duration)}</span>
          </div>

          <div class="cast-controls">
            <button class="tv" title="Back 30 seconds" onclick={() => void nudge(-30)}>-30s</button>
            <button
              class="tv wide"
              title={castStatus.playing ? 'Pause on the TV' : 'Play on the TV'}
              onclick={() => void send(castStatus?.playing ? 'pause' : 'play')}
            >
              {castStatus.playing ? '❚❚ Pause' : '▶ Play'}
            </button>
            <button class="tv" title="Forward 30 seconds" onclick={() => void nudge(30)}>+30s</button>
          </div>

          <button class="source stop" onclick={() => void stopCasting()}>Stop casting</button>
        {:else if castDevices.length === 0}
          <p class="hint">Looking for a TV on your Wi-Fi…</p>
        {:else}
          {#each castDevices as device (device.id)}
            <button class="source" onclick={() => void castTo(device.id)}>
              <span class="dot" style:background={RESUME_COLOUR}></span>
              <span class="name">{device.name}</span>
            </button>
          {/each}
        {/if}

        {#if castError}
          <p class="hint bad">{castError}</p>
        {/if}
      </div>
    {/if}

    {#if panel === 'sources'}
      <div class="panel sources">
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
          {@const dot = providerDot(sourceState.outcomes[provider.id], verdicts[provider.id], reasons[provider.id])}
          {@const test = scanning ? scanTesting.find((t) => t.providerId === provider.id) : undefined}
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
            {:else if dot.label}
              <span class="tag" class:bad={dot.tone === 'bad'}>{dot.label}{time}</span>
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
      <button class="wait" onclick={keepWaiting}>{suggestion.autoSwitch ? 'Keep waiting' : 'Stay'}</button>

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

  .chrome {
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

  /* Never shrinks: these are the controls the title is allowed to give way
     for, not the other way round. */
  .ghost {
    flex-shrink: 0;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 7px;
    color: inherit;
    cursor: pointer;
    font: inherit;
    padding: 7px 11px;
  }

  .ghost:hover {
    background: rgba(255, 255, 255, 0.16);
  }

  .ghost.active {
    background: rgba(240, 180, 90, 0.22);
    border-color: rgba(240, 180, 90, 0.5);
  }

  .panel {
    margin: 6px 14px 0;
    border-radius: 12px;
    background: rgba(8, 8, 12, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.1);
    overflow: hidden;
  }

  .episodes {
    height: 200px;
  }

  .hint {
    color: #9a9aa6;
    margin: 0;
    padding: 24px;
  }

  /* Horizontal, because a season is a sequence and scanning it sideways is how
     the detail view already presents it. */
  .strip {
    display: flex;
    gap: 12px;
    height: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 12px;
    scrollbar-width: thin;
  }

  .episode {
    background: none;
    border: 1px solid transparent;
    border-radius: 9px;
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    font: inherit;
    gap: 7px;
    padding: 6px;
    text-align: left;
    width: 208px;
  }

  .episode:hover {
    background: rgba(255, 255, 255, 0.07);
  }

  .episode.playing {
    border-color: rgba(240, 180, 90, 0.55);
  }

  .thumb {
    background: #17171d;
    border-radius: 6px;
    display: block;
    height: 110px;
    overflow: hidden;
    width: 100%;
  }

  .thumb img {
    height: 100%;
    object-fit: cover;
    width: 100%;
  }

  .meta {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .ep-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ep-runtime {
    color: #9a9aa6;
    font-size: 12px;
  }

  .sources {
    max-height: 288px;
    overflow-y: auto;
    padding: 6px;
    width: 260px;
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
    background: rgba(8, 8, 12, 0.98);
  }

  .sources-divider {
    height: 1px;
    margin: 4px 0;
    background: rgba(255, 255, 255, 0.1);
  }

  .source {
    align-items: center;
    background: none;
    border: none;
    border-radius: 7px;
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    gap: 9px;
    padding: 9px 10px;
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
    background: rgba(255, 255, 255, 0.08);
  }

  .source.playing {
    color: #f0b45a;
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

  .ghost.casting {
    background: rgba(91, 157, 250, 0.22);
    border-color: rgba(91, 157, 250, 0.55);
    color: #cfe0ff;
  }

  .ghost.cast {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  /* A television can be called anything at all, and some of them are called
     "Wohnzimmer Chromecast Ultra". Bounded here rather than trusted. */
  .ghost.cast .label {
    max-width: 110px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /*
    On a phone the word does not fit, and this is measured rather than guessed:
    with a series on screen the bar runs 417px wide inside a 412px viewport, so
    the source button — the one people reach for when a provider fails — hangs
    off the edge. The symbol carries the button on its own; the panel and the
    tooltip still name the device.
  */
  @media (max-width: 470px) {
    .ghost.cast .label {
      display: none;
    }

    /* Without the word, padding alone leaves a 35px target — under the 48dp
       Material minimum, and this is a button pressed with a thumb while the
       film is already playing. The width comes back out of the gaps rather
       than out of the source button, which must not be squeezed: it is the one
       people reach for when a provider has just failed them. */
    .ghost.cast {
      gap: 0;
      min-width: 44px;
      justify-content: center;
    }

    .bar {
      gap: 8px;
    }
  }

  /* Sized and placed like the source list, and for the same reason: it drops
     from a button at this end of the bar, and a panel is a strip of the picture
     the user cannot click through — so it takes the width it needs and no more.
     A house with a dozen Chromecasts scrolls rather than growing. */
  .cast-panel {
    padding: 6px;
    max-height: 380px;
    overflow-y: auto;
    width: 300px;
    margin-left: auto;
    margin-right: 14px;
  }

  .cast-head {
    margin: 0;
    padding: 10px 12px 6px;
    font-size: 13px;
    line-height: 1.4;
    color: rgba(255, 255, 255, 0.72);
  }

  .cast-head .name {
    color: #cfe0ff;
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

  .cast-now {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px 4px;
  }

  .cast-now .name {
    color: #cfe0ff;
  }

  .cast-controls {
    display: flex;
    gap: 6px;
    padding: 4px 6px 6px;
  }

  /* The scrubber. Wide thumb and a tall hit area, because this is reached for
     while looking at a television rather than at the slider. */
  .scrub {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px 2px;
  }

  .scrub .time {
    color: #9a9aa6;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    min-width: 34px;
  }

  .scrub .time:last-child {
    text-align: right;
  }

  .scrub input[type='range'] {
    flex: 1;
    min-width: 0;
    height: 20px;
    margin: 0;
    accent-color: #6ea8ff;
    cursor: pointer;
  }

  .scrub input[type='range']:disabled {
    cursor: default;
    opacity: 0.4;
  }

  .tv {
    flex: 1;
    min-height: 32px;
    padding: 0 6px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 7px;
    background: rgba(255, 255, 255, 0.05);
    color: #e8e8ef;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .tv.wide {
    flex: 1.6;
  }

  .tv:hover {
    background: rgba(255, 255, 255, 0.12);
  }

  .stop {
    width: calc(100% - 12px);
    margin: 0 6px 4px;
  }

  .hint.bad {
    color: #fb5c76;
    padding: 12px 16px;
  }
</style>
