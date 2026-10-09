<script lang="ts">
  /**
   * v2's own player controls, drawn in the `/__player` shell over the source.
   *
   * The source plays in the shell's iframe (`#provider`). This layer sits on
   * top of it and does one of two things with the pointer:
   *
   * - **passes it through** (`pointer-events: none`) while the source still
   *   needs its own page: its poster, an advert gate, a server picker, an
   *   error screen. Also when our controls are switched off, when the user
   *   asked for the source's own ("Source controls"), and when the film stops
   *   reporting.
   * - **takes it** once the film plays. The source's interface is then hidden
   *   in every one of its frames (`hide`), and this is the player: one look,
   *   one set of keys, whatever the source.
   *
   * The film is moved through the film relay (`FilmLink`, `@shared/filmrelay`).
   * Keys, the top bar and the window go through main (`window.wtaPlayer`).
   * The design is in `docs/internal/v2-player.md`.
   */
  import { fade } from 'svelte/transition'
  import type { BarState, PlayerContext, PlayerOverlayConfig, WtaPlayerApi } from '@shared/ipc'
  import type { FilmTrack } from '@shared/filmrelay'
  import { actionForEvent, SEEK_STEP_SECONDS, VOLUME_STEP, type TransportAction } from '@shared/playerkeys'
  import { clock } from '../lib/format'
  import { cuesAt, type Cue, type SubtitleLanguage } from '@shared/subtitles'
  import { qualityClass } from '@shared/streamquality'
  import { formatQuality } from '@shared/scanrank'
  import { FilmLink, type FilmView } from './filmlink'
  import SeekBar from './SeekBar.svelte'
  import { ICONS } from './icons'

  interface Props {
    /** The desktop's shell has `window.wtaPlayer`; the phone's bridge passes its own. */
    api?: WtaPlayerApi
    /** The source's iframe: the shell's `#provider`, or the phone's surface. */
    frame?: HTMLIFrameElement | null
    /** A phone: taps rather than a pointer (see "Taps on the picture"). */
    touch?: boolean
  }
  const {
    api = window.wtaPlayer,
    frame = document.getElementById('provider') as HTMLIFrameElement | null,
    touch = false,
  }: Props = $props()

  // The frame is fixed for this mount: the phone mounts a new overlay per load (`overlayhub.ts`).
  const link = new FilmLink((message) => frame?.contentWindow?.postMessage(message, '*'))

  /*
    Our controls are assumed on until main says otherwise, so the cover is up
    from this component's first frame rather than from the config's arrival.
  */
  let config = $state<PlayerOverlayConfig>({
    ownControls: true,
    fullscreen: false,
    mini: false,
    subtitleLanguage: null,
    held: null,
  })
  let bar = $state<BarState>({ visible: true, away: false })
  let view = $state<FilmView>(link.view())

  let context = $state<PlayerContext | null>(null)

  /** The film's time has moved in this load: it is playing, not just loaded. */
  let started = $state(false)
  /**
   * The source's own page is showing, because we could not play it without the
   * viewer: nothing playable after `REVEAL_AFTER_MS` (a captcha, a gate, an
   * error of its own), or the film gone for `LOST_REVEAL_MS`. Undone as soon
   * as the film moves again.
   */
  let revealed = $state(false)

  const film = $derived(view.film)
  /**
   * Our controls rather than the source's. Only the Settings switch turns
   * them off: the bar's "Use the source's own controls" button went at the
   * owner's request (2026-09-27), with the pill that led back.
   */
  const playerMode = $derived(config.ownControls)
  const engaged = $derived(playerMode && started && film !== null && !revealed)
  /**
   * Our cover over the source's page, from its first frame (the owner,
   * 2026-09-27: never the source's own elements in player mode). It is up
   * while the source loads, and while a playing film is briefly gone
   * (a quality change, a new element, a stall).
   */
  const curtain = $derived(playerMode && !revealed && (!started || film === null))

  /**
   * A fade's length, or none while the player is held (Resume carried over).
   * Held on the desktop, this page is out of sight and gets no frames, so a
   * fade started then only runs once the player is shown: the curtain lifted
   * over the film for ~0.6 s after the swap (screen recording, 2026-09-29).
   */
  const fadeMs = (ms: number): number => (config.held ? 0 : ms)

  const REVEAL_AFTER_MS = 25_000
  const LOST_REVEAL_MS = 10_000
  /** When to press the source's own play control while it has no film yet. */
  const PRESS_AT_MS = [2_500, 6_000, 11_000, 17_000]

  /**
   * Last resort: our own play button, over the cover, for a film that is there
   * and has refused every automatic start. Space does the same.
   */
  let autoplayGaveUp = $state(false)
  const offerPlay = $derived(
    playerMode && !started && !revealed && film !== null && film.paused && !film.ended && autoplayGaveUp,
  )

  /* ── The film ──────────────────────────────────────────────────────────── */

  /**
   * Started means the film's time has moved while it played: two reports in a
   * row, playing, the second further on. A bare 'play' event is not enough,
   * because a source can abort that play at once with a load of its own
   * (VidRock does), and hiding its page over a film that then stops would
   * leave nothing to click.
   */
  let playingAt: number | null = null
  function refresh(): void {
    view = link.view()
    // The smoothing clock starts from this report; it is not ticking while
    // the controls are away, and a stale one would put the time behind it.
    now = performance.now()
    const f = view.film
    if (f === null || f.paused) {
      playingAt = null
      return
    }
    if (playingAt !== null && f.seconds > playingAt + 0.2) {
      started = true
      revealed = false
    }
    playingAt = f.seconds
  }

  /* ── Starting without being asked ─────────────────────────────────────── */

  const openedAt = performance.now()

  /**
   * Start the film the moment it is there (the owner, 2026-09-27: no second
   * press of Play). While there is no film yet, press the source's own play
   * control for it, in its frames, a few times (main does the pressing:
   * `pressPlay`). While there is still nothing after `REVEAL_AFTER_MS`, the
   * source needs the viewer, and its page is shown.
   */
  $effect(() => {
    if (!playerMode) return
    // How many of PRESS_AT_MS (ascending) are done: at most one press a tick.
    let presses = 0
    const tick = setInterval(() => {
      const elapsed = performance.now() - openedAt
      if (started) return
      if (view.film === null && presses < PRESS_AT_MS.length && elapsed >= PRESS_AT_MS[presses]!) {
        presses += 1
        api?.pressPlay()
      }
      if (elapsed >= REVEAL_AFTER_MS && !revealed) revealed = true
    }, 500)
    return () => clearInterval(tick)
  })

  // Autoplay: every time the film is there, paused, and nobody has asked for anything.
  $effect(() => {
    if (!playerMode || started || film === null || !film.paused || film.ended || view.wanted !== null) return
    if (performance.now() - openedAt > REVEAL_AFTER_MS / 2) autoplayGaveUp = true
    link.setPaused(false)
    refresh()
  })

  /*
   * Sound, the way autoplay above is pictures: a film the source started
   * muted is unmuted, once per load, unless the viewer has chosen the sound
   * themselves. 111Movies starts its film by itself with the element muted
   * (the browser's muted autoplay) and turns the sound on only after a click
   * on its player. Our presses land only while no film exists yet, so when
   * its muted film came first it stayed silent, and with the source's own
   * controls hidden under ours the viewer had no way to its unmute button
   * (the owner, 2026-10-04: "no sound in our player"). Not while held: the
   * carry-over decides the sound then (`heldMuted`). Adverts stay as they
   * are, because the relay aims its commands at the film by its length.
   */
  let soundChosen = false
  let unmutedOnce = false
  $effect(() => {
    if (!playerMode || film === null || !film.muted || unmutedOnce || soundChosen) return
    if (config.held !== null || heldMuted !== null) return
    unmutedOnce = true
    link.setMuted(false)
  })

  // A playing film that has gone: our cover for a while, then the source's page.
  $effect(() => {
    if (!playerMode || !started || film !== null || revealed) return
    const timer = setTimeout(() => (revealed = true), LOST_REVEAL_MS)
    return () => clearTimeout(timer)
  })

  $effect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (frame === null || event.source !== frame.contentWindow) return
      if (link.receive(event.data)) refresh()
    }
    window.addEventListener('message', onMessage)
    // A heartbeat as well as a request: every frame's relay answers `watch`
    // with a report, so a paused film still reports, and a frame that stops
    // answering drops out of the view.
    link.watch()
    const heartbeat = setInterval(() => {
      link.watch()
      refresh()
    }, 2_000)
    return () => {
      window.removeEventListener('message', onMessage)
      clearInterval(heartbeat)
    }
  })

  /*
   * Held: the detail view's preview is standing in for this player while it
   * loads out of sight (Resume carried over, `shared/carryover.ts`). The film
   * stays silent however often the source unmutes it, and takes the preview's
   * sound when the hold ends. Whether our controls are on or not: this is
   * about two soundtracks at once, not about controls.
   */
  let heldMuted: boolean | null = null
  $effect(() => {
    const held = config.held
    if (held !== null) {
      heldMuted = held.muted
      if (film !== null && !film.muted) link.setMuted(true)
      return
    }
    if (heldMuted === null) return
    const muted = heldMuted
    heldMuted = null
    link.setMuted(muted)
  })

  // The source's interface is hidden while ours is in charge, and through a
  // brief loss of the film, when our cover is up anyway.
  $effect(() => {
    link.setHidden(playerMode && started && !revealed)
  })

  /**
   * The keyboard is ours while our controls are. A source that needed a click
   * on its own poster has the focus in its frame after that click, and its
   * player then takes the keys: on VidSrc → became VidSrc's own +2 s. So the
   * focus comes back here on taking over, and again whenever the source's
   * frame takes it. It is left alone when it goes anywhere else, such as the
   * top bar, and whenever the source's controls are the ones in use.
   */
  let root = $state<HTMLDivElement | null>(null)
  $effect(() => {
    if (!engaged) return
    root?.focus({ preventScroll: true })
    const onBlur = (): void => {
      setTimeout(() => {
        if (document.activeElement === frame) root?.focus({ preventScroll: true })
      }, 0)
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  })

  /**
   * The play head, smoothed. Reports arrive four times a second at most; in
   * between, the time moves on at the film's rate from the last report, one
   * step per animation frame, while the controls are there to be seen.
   */
  let now = $state(performance.now())
  /** Paused as shown: what the viewer just asked for, until the source catches up. */
  const paused = $derived(film === null ? true : (view.wanted ?? film.paused))
  const playing = $derived(film !== null && !film.paused && !film.ended && !film.waiting)
  const shownSeconds = $derived(
    film === null
      ? 0
      : Math.min(film.duration, film.seconds + (playing ? (Math.max(0, now - view.at) / 1000) * film.rate : 0)),
  )

  /* ── Showing the controls ──────────────────────────────────────────────── */

  let hoverControls = $state(false)
  let scrubbing = $state(false)
  let menu = $state<'none' | 'subtitles' | 'quality'>('none')
  /** A move just now, before the bar's own state has come back from main. */
  let recentMove = $state(false)
  let moveTimer: ReturnType<typeof setTimeout> | undefined

  const hold = $derived((film !== null && paused) || scrubbing || hoverControls || menu !== 'none')
  const controlsVisible = $derived(engaged && !config.mini && !bar.away && (bar.visible || hold || recentMove))

  // Frames for the clock while it is seen: the seek bar, or subtitles we draw.
  $effect(() => {
    if (!(controlsVisible || subtitle.kind === 'file') || !playing) return
    let handle = requestAnimationFrame(function tick(time) {
      now = time
      handle = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(handle)
  })

  let lastActivity = 0
  function onPointerMove(): void {
    recentMove = true
    clearTimeout(moveTimer)
    moveTimer = setTimeout(() => (recentMove = false), 600)
    const time = performance.now()
    if (time - lastActivity < 150) return
    lastActivity = time
    api?.activity(hold)
  }

  // The top bar is held while ours is, and let go when ours is.
  $effect(() => {
    if (engaged) api?.activity(hold)
  })

  /* ── Clicks on the picture ─────────────────────────────────────────────── */

  /**
   * One click plays or pauses, two go fullscreen. The single click waits
   * a moment to be sure it is not the first of two, so a double-click does
   * not also stutter the film.
   */
  let clickTimer: ReturnType<typeof setTimeout> | undefined
  function onStageClick(): void {
    if (menu !== 'none') {
      menu = 'none'
      return
    }
    clearTimeout(clickTimer)
    clickTimer = setTimeout(() => perform('togglePlay'), 220)
  }
  function onStageDoubleClick(): void {
    // In the corner the picture is a thumbnail: two clicks are two clicks.
    if (config.mini) return
    clearTimeout(clickTimer)
    api?.action('fullscreen')
  }

  /* ── Taps, on a phone ──────────────────────────────────────────────────── */

  /**
   * A tap shows or hides the controls, and the top bar with them. Two quick
   * taps on the left or right third jump back or forward, and every further
   * tap there jumps again while the ripple shows, as on YouTube and Netflix
   * (the owner, 2026-09-27). Our layer takes every tap on the picture, so the
   * source's own gestures are gone; that was agreed with it.
   */
  const DOUBLE_TAP_MS = 300
  let lastTap: { at: number; side: 'back' | 'forward' | null } | null = null
  let tapTimer: ReturnType<typeof setTimeout> | undefined
  function onStageTap(event: MouseEvent): void {
    if (menu !== 'none') {
      menu = 'none'
      return
    }
    const x = event.clientX / Math.max(1, root?.clientWidth ?? 1)
    const side = x < 1 / 3 ? 'back' : x > 2 / 3 ? 'forward' : null
    const time = performance.now()
    const quick = lastTap !== null && lastTap.side === side && time - lastTap.at < DOUBLE_TAP_MS
    const stillJumping = side !== null && nudge !== null && nudge.side === side
    lastTap = { at: time, side }
    clearTimeout(tapTimer)
    if (side !== null && (quick || stillJumping)) {
      perform(side === 'back' ? 'seekBack' : 'seekForward')
      return
    }
    tapTimer = setTimeout(toggleControls, DOUBLE_TAP_MS)
  }
  function toggleControls(): void {
    if (controlsVisible) {
      recentMove = false
      api?.dismiss?.()
      return
    }
    recentMove = true
    clearTimeout(moveTimer)
    moveTimer = setTimeout(() => (recentMove = false), 600)
    api?.activity(hold)
  }

  /* ── Doing things, with something to see ───────────────────────────────── */

  /** The big icon that pops in the middle on play and pause. */
  let flash = $state<{ id: number; icon: 'play' | 'pause' } | null>(null)
  /** The ripple at a side on a jump; repeated presses add up (−10, −20, …). */
  let nudge = $state<{ id: number; side: 'back' | 'forward'; seconds: number } | null>(null)
  let nudgeTimer: ReturnType<typeof setTimeout> | undefined
  /** The volume readout, shown for a moment after a change. */
  let hud = $state<{ id: number; level: number; muted: boolean } | null>(null)
  let hudTimer: ReturnType<typeof setTimeout> | undefined
  let ids = 0

  function showNudge(side: 'back' | 'forward'): void {
    const seconds = nudge !== null && nudge.side === side ? nudge.seconds + SEEK_STEP_SECONDS : SEEK_STEP_SECONDS
    nudge = { id: ++ids, side, seconds }
    clearTimeout(nudgeTimer)
    nudgeTimer = setTimeout(() => (nudge = null), 700)
  }

  function showHud(level: number, muted: boolean): void {
    hud = { id: ++ids, level, muted }
    clearTimeout(hudTimer)
    hudTimer = setTimeout(() => (hud = null), 900)
  }

  function setVolume(level: number): void {
    soundChosen = true
    const next = Math.round(Math.min(1, Math.max(0, level)) * 100) / 100
    link.setVolume(next)
    showHud(next, false)
  }

  function perform(action: TransportAction): void {
    if (film === null) return
    switch (action) {
      case 'togglePlay':
        flash = { id: ++ids, icon: paused ? 'play' : 'pause' }
        link.setPaused(!paused)
        refresh()
        break
      case 'seekBack':
        link.seekBy(-SEEK_STEP_SECONDS)
        showNudge('back')
        break
      case 'seekForward':
        link.seekBy(SEEK_STEP_SECONDS)
        showNudge('forward')
        break
      case 'volumeUp':
        setVolume((film.muted ? 0 : film.volume) + VOLUME_STEP)
        break
      case 'volumeDown':
        setVolume((film.muted ? 0 : film.volume) - VOLUME_STEP)
        break
      case 'mute':
        soundChosen = true
        link.setMuted(!film.muted)
        showHud(film.volume, !film.muted)
        break
    }
  }

  $effect(() => api?.onTransport((action) => perform(action)))
  $effect(() =>
    api?.onConfig((next) => {
      config = next
    }),
  )

  // The page's own first-frame cover (`player.html`), handed over to ours.
  $effect(() => {
    document.getElementById('cover')?.remove()
  })
  $effect(() =>
    api?.onContext((next) => {
      context = next
    }),
  )
  $effect(() =>
    api?.onBarState((next) => {
      bar = next
    }),
  )

  function onKeydown(event: KeyboardEvent): void {
    // On the phone this document is the whole app: a key belongs to it, not to
    // the film. Escape, which the bridge sends for Back, closes our menu.
    if (touch) {
      if (event.key === 'Escape' && menu !== 'none') {
        event.preventDefault()
        event.stopImmediatePropagation()
        menu = 'none'
      }
      return
    }
    const action = actionForEvent(event)
    if (action === null) return
    event.preventDefault()
    api?.action(action)
  }

  /* ── Volume ────────────────────────────────────────────────────────────── */

  const volumeIcon = $derived(
    film === null || film.muted || film.volume === 0
      ? ICONS.volumeOff
      : film.volume < 0.5
        ? ICONS.volumeLow
        : ICONS.volumeHigh,
  )
  const volumeLevel = $derived(film === null || film.muted ? 0 : film.volume)

  function onVolumeInput(event: Event): void {
    setVolume(Number((event.currentTarget as HTMLInputElement).value))
  }

  /* ── Subtitles ─────────────────────────────────────────────────────────── */

  /**
   * Which subtitles are shown: none, one of the source's own tracks (its cues
   * come through the relay), or a file from OpenSubtitles that we time
   * ourselves against the film (`cuesAt`).
   */
  type Subtitle =
    | { kind: 'off' }
    | { kind: 'track'; index: number }
    | { kind: 'file'; code: string; label: string; cues: Cue[] }
  let subtitle = $state<Subtitle>({ kind: 'off' })

  /** OpenSubtitles' languages for this title: null until first asked, which is when the menu opens. */
  let languages = $state<SubtitleLanguage[] | null>(null)
  let languagesLoading = $state(false)
  /** The language being fetched, for its row's "Loading" label. */
  let loadingCode = $state<string | null>(null)
  let subtitleError = $state<string | null>(null)

  /** One question per load, however many ask: the menu, the auto-load, a track being remembered. */
  let languagesAsked: Promise<void> | null = null
  function askLanguages(): Promise<void> {
    languagesAsked ??= (async () => {
      languagesLoading = true
      languages = (await api?.subtitles.languages().catch(() => [])) ?? []
      languagesLoading = false
    })()
    return languagesAsked
  }

  /** Whether a source's own track is in an OpenSubtitles language: by ISO code, else by name. */
  const sameLanguage = (language: SubtitleLanguage, track: FilmTrack): boolean =>
    (language.iso !== '' && track.language.toLowerCase().startsWith(language.iso)) ||
    (language.name !== '' && track.label.toLowerCase().includes(language.name.toLowerCase()))

  function toggleSubtitlesMenu(): void {
    menu = menu === 'subtitles' ? 'none' : 'subtitles'
    if (menu === 'subtitles') void askLanguages()
  }

  /** `remember`: the viewer chose it, so the next title starts in its language too. */
  function chooseTrack(index: number, remember: boolean): void {
    subtitle = { kind: 'track', index }
    link.chooseTrack(index)
    menu = 'none'
    if (remember) void rememberTrackLanguage(index)
  }

  /**
   * A source's own track carries no OpenSubtitles code, and the next title
   * may play on a source without that track. So the track's language is
   * remembered as the OpenSubtitles language it matches, which the next
   * title finds either way. A track in no language OpenSubtitles has for
   * this title changes nothing.
   */
  async function rememberTrackLanguage(index: number): Promise<void> {
    const track = view.tracks.find((t) => t.index === index)
    if (!track) return
    await askLanguages()
    const language = languages?.find((l) => sameLanguage(l, track))
    if (language) await api?.subtitles.remember(language.code)
  }

  async function chooseFile(code: string): Promise<void> {
    if (!api) return
    loadingCode = code
    subtitleError = null
    const loaded = await api.subtitles.load(code, film?.duration ?? null).catch(() => null)
    loadingCode = null
    if (loaded === null) {
      subtitleError = 'No subtitles could be loaded in that language'
      return
    }
    link.chooseTrack(-1)
    subtitle = { kind: 'file', code, label: loaded.label, cues: loaded.cues }
    menu = 'none'
  }

  function subtitlesOff(): void {
    subtitle = { kind: 'off' }
    link.chooseTrack(-1)
    void api?.subtitles.remember(null)
    menu = 'none'
  }

  /**
   * The languages in the order a viewer looks for them: the one they chose
   * before, then English, then the ones with the most files.
   */
  const orderedLanguages = $derived.by(() => {
    const list = languages ?? []
    const rank = (language: SubtitleLanguage): number =>
      language.code === config.subtitleLanguage ? 0 : language.code === 'eng' ? 1 : 2
    return [...list].sort((a, b) => rank(a) - rank(b) || b.count - a.count || a.name.localeCompare(b.name))
  })

  /**
   * A language chosen once starts every later title. A source's own track in
   * that language is taken first: it is timed to this very stream. Otherwise
   * the file comes from OpenSubtitles. Tried once per load, once the film
   * plays.
   */
  let autoSubtitlesTried = false
  $effect(() => {
    const code = config.subtitleLanguage
    if (!engaged || autoSubtitlesTried || code === null || subtitle.kind !== 'off') return
    autoSubtitlesTried = true
    void (async () => {
      await askLanguages()
      const language = languages?.find((l) => l.code === code)
      const own = language && view.tracks.find((track) => sameLanguage(language, track))
      if (own) chooseTrack(own.index, false)
      else await chooseFile(code)
    })()
  })

  const cues = $derived.by(() => {
    if (!engaged) return []
    if (subtitle.kind === 'track') return view.cues
    if (subtitle.kind === 'file') return cuesAt(subtitle.cues, shownSeconds)
    return []
  })

  /* ── Quality ───────────────────────────────────────────────────────────── */

  /**
   * Qualities are named by `qualityClass`, the rule the source tests use, so
   * the menu and the source list never disagree. Films are rarely 16:9: Silo
   * plays at 1913×800, which is 1080p, and its height alone read "800p".
   */
  const classOf = (width: number, height: number): number => qualityClass({ width: width > 0 ? width : null, height })

  /**
   * The source's own quality ladder, where its engine can be reached
   * (`findEngine` in the relay): one rung per class, the best bitrate of
   * each, highest first. Asked for when the film starts and when the menu
   * opens; the picture's own size comes with it either way.
   */
  const rungs = $derived.by(() => {
    const byBitrate = (view.quality?.levels ?? [])
      .map((level) => ({ index: level.index, quality: classOf(level.width, level.height), bitrate: level.bitrate }))
      .sort((a, b) => b.bitrate - a.bitrate)
    // The first of each class, by bitrate, is its best. A ladder has a handful of rungs.
    const best = byBitrate.filter((rung, i) => byBitrate.findIndex((r) => r.quality === rung.quality) === i)
    return best.sort((a, b) => b.quality - a.quality)
  })

  /** What is on screen now; null before the first frame. */
  const playingQuality = $derived(
    view.quality && view.quality.height > 0 ? classOf(view.quality.width, view.quality.height) : null,
  )

  /**
   * The class chosen, or null for automatic: two encodes of one class are one
   * choice. A list of whole streams has no automatic mode, so one of them is
   * always the choice.
   */
  const chosenQuality = $derived.by(() => {
    const quality = view.quality
    if (!quality || (quality.canAuto && quality.auto)) return null
    const level = quality.levels.find((l) => l.index === quality.current)
    return level ? classOf(level.width, level.height) : null
  })

  /**
   * The button's label: a choice the viewer made, in the menu's own terms,
   * or else what is on screen. A stream named in a source's own list keeps
   * that name, so the menu and the button agree even where a picture's size
   * would round differently. (Videasy's 1148×480 "480p" was the case that
   * found this; `qualityClass` now names that size 480p as well.)
   */
  const shownQuality = $derived(chosenQuality ?? playingQuality)

  $effect(() => {
    if (engaged) link.askQuality()
  })

  function toggleQualityMenu(): void {
    menu = menu === 'quality' ? 'none' : 'quality'
    if (menu === 'quality') link.askQuality()
  }

  function chooseLevel(index: number): void {
    link.setLevel(index)
    menu = 'none'
  }

  /**
   * The chrome lays its bar out by whether we have the film: while we do, its
   * source list and episode strip open from the buttons in our bar instead.
   */
  $effect(() => {
    api?.owned(engaged)
  })

  /* ── A source change the player made by itself ─────────────────────────── */

  let toast = $state<{ id: number; text: string } | null>(null)
  $effect(() =>
    api?.onProviderChanged((change) => {
      toast = { id: ++ids, text: `Switched to ${change.providerName}: the previous source failed (${change.reason})` }
      setTimeout(() => (toast = null), 4_500)
    }),
  )
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="overlay"
  class:engaged
  class:mini={config.mini}
  class:show={controlsVisible}
  class:touch
  role="presentation"
  tabindex="-1"
  bind:this={root}
  onpointermove={engaged ? onPointerMove : undefined}
>
  {#if engaged}
    <!-- The picture itself: a click plays or pauses, a double-click goes
         fullscreen; on a phone, a tap shows the controls (`onStageTap`). -->
    <button
      class="stage"
      aria-label={touch ? 'Show the controls' : paused ? 'Play' : 'Pause'}
      tabindex="-1"
      onclick={touch ? onStageTap : onStageClick}
      ondblclick={touch ? undefined : onStageDoubleClick}
    ></button>

    {#if film !== null && film.waiting && !paused}
      <div class="spinner" transition:fade={{ duration: fadeMs(200) }} aria-hidden="true"></div>
    {/if}
  {/if}

  {#if curtain}
    <div class="curtain" transition:fade={{ duration: fadeMs(350) }} aria-live="polite">
      <div class="curtain-spinner" aria-hidden="true"></div>
      <p class="curtain-label">
        {started ? 'Reconnecting' : `Starting ${context?.providerName ?? 'the source'}`}
      </p>
    </div>
  {/if}

  {#if playerMode && revealed}
    <!-- Says what happened, not why: a page waiting for a click and a source
         failing to stream (VidLux's "Switching server…") look the same from here. -->
    <div class="note" transition:fade={{ duration: 200 }}>
      {context?.providerName ?? 'The source'}
      {started ? 'lost its video' : 'has not started'} · showing its own page
    </div>
  {/if}

  {#if offerPlay}
    <button
      class="big-play"
      aria-label="Play"
      title="Play (Space)"
      transition:fade={{ duration: 200 }}
      onclick={() => perform('togglePlay')}
    >
      <svg viewBox="0 0 24 24"><path d={ICONS.play} /></svg>
    </button>
  {/if}

  {#if flash}
    {#key flash.id}
      <div class="flash" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d={flash.icon === 'play' ? ICONS.play : ICONS.pause} /></svg>
      </div>
    {/key}
  {/if}

  {#if nudge}
    {#key nudge.id}
      <div class="nudge {nudge.side}" aria-hidden="true">
        <div class="ripple"></div>
        <div class="nudge-label">
          <span class="chevrons">{nudge.side === 'back' ? '‹‹' : '››'}</span>
          {nudge.seconds} seconds
        </div>
      </div>
    {/key}
  {/if}

  {#if hud}
    {#key hud.id}
      <div class="hud" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d={hud.muted || hud.level === 0 ? ICONS.volumeOff : hud.level < 0.5 ? ICONS.volumeLow : ICONS.volumeHigh} />
        </svg>
        <div class="hud-bar"><span style:width="{(hud.muted ? 0 : hud.level) * 100}%"></span></div>
        <span class="hud-value">{hud.muted ? 'Muted' : `${Math.round(hud.level * 100)}%`}</span>
      </div>
    {/key}
  {/if}

  {#if cues.length > 0}
    <div class="cues" class:lifted={controlsVisible}>
      {#each cues as line, index (index)}
        <span>{line}</span>
      {/each}
    </div>
  {/if}

  {#if engaged && film !== null && touch}
    <!-- A phone's row has no room for these: they sit in the middle of the
         picture, where a thumb finds them, as in every phone player. -->
    <div class="centre" class:shown={controlsVisible}>
      <button class="centre-button" aria-label="Back 10 seconds" onclick={() => perform('seekBack')}>
        <svg viewBox="0 0 24 24"><path d={ICONS.replay} /><text x="12" y="15.9" text-anchor="middle">10</text></svg>
      </button>
      <button class="centre-button play-big" aria-label={paused ? 'Play' : 'Pause'} onclick={() => perform('togglePlay')}>
        <svg viewBox="0 0 24 24"><path d={paused ? ICONS.play : ICONS.pause} /></svg>
      </button>
      <button class="centre-button" aria-label="Forward 10 seconds" onclick={() => perform('seekForward')}>
        <svg viewBox="0 0 24 24"
          ><path d={ICONS.replay} transform="matrix(-1 0 0 1 24 0)" /><text x="12" y="15.9" text-anchor="middle">10</text></svg
        >
      </button>
    </div>
  {/if}

  {#if engaged && film !== null}
    <div class="scrim" aria-hidden="true"></div>
    <div
      class="controls"
      role="group"
      aria-label="Player controls"
      onpointerenter={() => (hoverControls = true)}
      onpointerleave={() => (hoverControls = false)}
    >
      <SeekBar
        current={shownSeconds}
        duration={film.duration}
        buffered={film.buffered}
        onseek={(seconds) => link.seekTo(seconds)}
        onscrub={(on) => (scrubbing = on)}
      />

      <div class="row">
        {#if !touch}
        <button class="control play" aria-label={paused ? 'Play' : 'Pause'} title={paused ? 'Play (Space)' : 'Pause (Space)'} onclick={() => perform('togglePlay')}>
          <svg viewBox="0 0 24 24" class="morph" class:on={paused}><path d={ICONS.play} /></svg>
          <svg viewBox="0 0 24 24" class="morph" class:on={!paused}><path d={ICONS.pause} /></svg>
        </button>

        <button class="control jump" aria-label="Back 10 seconds" title="Back 10 seconds (←)" onclick={() => perform('seekBack')}>
          <svg viewBox="0 0 24 24">
            <path d={ICONS.replay} />
            <text x="12" y="15.9" text-anchor="middle">10</text>
          </svg>
        </button>

        <button class="control jump" aria-label="Forward 10 seconds" title="Forward 10 seconds (→)" onclick={() => perform('seekForward')}>
          <svg viewBox="0 0 24 24">
            <path d={ICONS.replay} transform="matrix(-1 0 0 1 24 0)" />
            <text x="12" y="15.9" text-anchor="middle">10</text>
          </svg>
        </button>

        <div class="volume">
          <button class="control" aria-label={film.muted ? 'Unmute' : 'Mute'} title={film.muted ? 'Unmute (M)' : 'Mute (M)'} onclick={() => perform('mute')}>
            <svg viewBox="0 0 24 24"><path d={volumeIcon} /></svg>
          </button>
          <input
            class="volume-slider"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volumeLevel}
            style:--level="{volumeLevel * 100}%"
            aria-label="Volume"
            oninput={onVolumeInput}
          />
        </div>
        {/if}

        <span class="time">
          {clock(shownSeconds)}<span class="of">&nbsp;/&nbsp;{clock(film.duration)}</span>
        </span>

        <span class="spacer"></span>

        <!-- The source list and the episodes, moved down from the top bar (the
             owner, 2026-09-27). The chrome draws both, above this row. -->
        <button class="control source" aria-label="Choose the source" title="Choose the source" onclick={() => api?.action('sources')}>
          <span class="source-name">{context?.providerName ?? 'Source'}</span>
          <svg viewBox="0 0 24 24"><path d={ICONS.expandLess} /></svg>
        </button>

        {#if context?.type === 'tv'}
          <button class="control" aria-label="Episodes" title="Episodes (Enter)" onclick={() => api?.action('episodes')}>
            <svg viewBox="0 0 24 24"><path d={ICONS.episodes} /></svg>
          </button>
        {/if}

        <div class="menu-anchor">
          <button
            class="control"
            class:active={subtitle.kind !== 'off' || menu === 'subtitles'}
            aria-label="Subtitles"
            title="Subtitles"
            onclick={toggleSubtitlesMenu}
          >
            <svg viewBox="0 0 24 24"><path d={ICONS.subtitles} /></svg>
          </button>
          {#if menu === 'subtitles'}
            <div class="menu" transition:fade={{ duration: 140 }}>
              <button class="item" class:chosen={subtitle.kind === 'off'} onclick={subtitlesOff}>
                <svg viewBox="0 0 24 24"><path d={ICONS.check} /></svg>Off
              </button>
              {#if view.tracks.length > 0}
                <p class="menu-group">From {context?.providerName ?? 'the source'}</p>
                {#each view.tracks as track (track.index)}
                  <button
                    class="item"
                    class:chosen={subtitle.kind === 'track' && subtitle.index === track.index}
                    onclick={() => chooseTrack(track.index, true)}
                  >
                    <svg viewBox="0 0 24 24"><path d={ICONS.check} /></svg>{track.label || track.language || `Track ${track.index + 1}`}
                  </button>
                {/each}
              {/if}
              <p class="menu-group">From OpenSubtitles</p>
              {#if languagesLoading}
                <p class="menu-hint">Looking for subtitles…</p>
              {:else if languages !== null && languages.length === 0}
                <p class="menu-hint">None found for this title</p>
              {/if}
              {#each orderedLanguages as language (language.code)}
                <button
                  class="item"
                  class:chosen={subtitle.kind === 'file' && subtitle.code === language.code}
                  onclick={() => void chooseFile(language.code)}
                >
                  <svg viewBox="0 0 24 24"><path d={ICONS.check} /></svg>
                  <span class="item-name">{language.name}</span>
                  {#if loadingCode === language.code}<span class="item-note">Loading…</span>{/if}
                </button>
              {/each}
              {#if subtitleError}<p class="menu-hint bad">{subtitleError}</p>{/if}
            </div>
          {/if}
        </div>

        <div class="menu-anchor">
          <button
            class="control quality"
            class:active={menu === 'quality'}
            aria-label="Quality"
            title="Quality"
            onclick={toggleQualityMenu}
          >
            <span class="quality-label">{shownQuality === null ? 'Auto' : formatQuality(shownQuality)}</span>
          </button>
          {#if menu === 'quality'}
            <div class="menu" transition:fade={{ duration: 140 }}>
              {#if rungs.length > 1}
                {#if view.quality?.canAuto}
                  <button class="item" class:chosen={chosenQuality === null} onclick={() => chooseLevel(-1)}>
                    <svg viewBox="0 0 24 24"><path d={ICONS.check} /></svg>
                    <span class="item-name">Auto</span>
                    {#if chosenQuality === null && playingQuality !== null}
                      <span class="item-note">{formatQuality(playingQuality)}</span>
                    {/if}
                  </button>
                {/if}
                {#each rungs as rung (rung.index)}
                  <button class="item" class:chosen={chosenQuality === rung.quality} onclick={() => chooseLevel(rung.index)}>
                    <svg viewBox="0 0 24 24"><path d={ICONS.check} /></svg>
                    <span class="item-name">{formatQuality(rung.quality)}</span>
                  </button>
                {/each}
              {:else if rungs.length === 1}
                <p class="menu-hint">{context?.providerName ?? 'This source'} offers only {formatQuality(rungs[0]!.quality)}</p>
              {:else}
                <!-- No engine within reach: say so, rather than claim there is nothing to choose. -->
                <p class="menu-hint">{context?.providerName ?? 'This source'} chooses the quality itself</p>
              {/if}
            </div>
          {/if}
        </div>

        <button
          class="control"
          aria-label={config.fullscreen ? 'Leave fullscreen' : 'Fullscreen'}
          title={config.fullscreen ? 'Leave fullscreen (F)' : 'Fullscreen (F)'}
          onclick={() => api?.action('fullscreen')}
        >
          <svg viewBox="0 0 24 24"><path d={config.fullscreen ? ICONS.fullscreenExit : ICONS.fullscreen} /></svg>
        </button>
      </div>
    </div>
  {/if}

  {#if toast}
    {#key toast.id}
      <div class="toast" transition:fade={{ duration: 220 }}>{toast.text}</div>
    {/key}
  {/if}
</div>

<style>
  /*
    The layer over the source. It passes the pointer through unless engaged,
    and each thing it draws while not engaged (the way back, the toast) takes
    only its own clicks.
  */
  .overlay {
    --accent: #f0b45a;
    position: fixed;
    inset: 0;
    z-index: 10;
    pointer-events: none;
    color: #f4f4f6;
    font:
      500 14px/1.2 Inter,
      system-ui,
      sans-serif;
    user-select: none;
    -webkit-user-select: none;
  }

  .overlay.engaged {
    pointer-events: auto;
  }

  /* Focus sits here so the keys are ours; it is not a control to outline. */
  .overlay:focus {
    outline: none;
  }

  /* No pointer over the picture while the controls are away, as in any
     player; but always one over the small picture in the corner. */
  .overlay.engaged:not(.show):not(.mini) {
    cursor: none;
  }

  .stage {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    background: transparent;
    cursor: inherit;
  }

  .stage:focus {
    outline: none;
  }

  /* ── The bottom bar ───────────────────────────────────────────────────── */

  .scrim {
    position: absolute;
    inset: auto 0 0 0;
    height: 190px;
    background: linear-gradient(to top, rgba(4, 4, 8, 0.82), rgba(4, 4, 8, 0.35) 55%, rgba(4, 4, 8, 0));
    pointer-events: none;
    opacity: 0;
    transition: opacity 260ms ease;
  }

  .controls {
    position: absolute;
    inset: auto 0 0 0;
    padding: 0 22px 14px;
    opacity: 0;
    transform: translateY(14px);
    transition:
      opacity 220ms ease,
      transform 300ms cubic-bezier(0.2, 0.8, 0.2, 1);
    pointer-events: none;
  }

  .show .scrim {
    opacity: 1;
  }

  .show .controls {
    opacity: 1;
    transform: none;
    pointer-events: auto;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
  }

  .spacer {
    flex: 1;
  }

  .control {
    position: relative;
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: inherit;
    cursor: pointer;
    transition: transform 140ms ease;
  }

  /* A soft disc grows in behind the icon on hover. */
  .control::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.14);
    transform: scale(0.6);
    opacity: 0;
    transition:
      transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
      opacity 180ms ease;
  }

  .control:hover::before,
  .control.active::before {
    transform: scale(1);
    opacity: 1;
  }

  .control.active {
    color: var(--accent);
  }

  .control:active {
    transform: scale(0.9);
  }

  .control:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .control svg {
    position: relative;
    width: 30px;
    height: 30px;
    fill: currentColor;
    overflow: visible;
  }

  .control text {
    font:
      800 7.2px/1 Inter,
      system-ui,
      sans-serif;
    letter-spacing: -0.3px;
    fill: currentColor;
  }

  .jump svg {
    width: 34px;
    height: 34px;
  }

  /* Play and pause turn into each other rather than swapping. */
  .play {
    width: 58px;
    height: 58px;
  }

  .play .morph {
    position: absolute;
    width: 36px;
    height: 36px;
    opacity: 0;
    transform: scale(0.5) rotate(-90deg);
    transition:
      opacity 180ms ease,
      transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1.2);
  }

  .play .morph.on {
    opacity: 1;
    transform: none;
  }

  .time {
    margin-left: 8px;
    font-size: 16px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .time .of {
    color: rgba(244, 244, 246, 0.6);
  }

  /* ── Volume: the slider slides out of the button ───────────────────────── */

  .volume {
    display: flex;
    align-items: center;
  }

  .volume-slider {
    width: 0;
    height: 18px;
    margin: 0;
    opacity: 0;
    appearance: none;
    -webkit-appearance: none;
    background: transparent;
    cursor: pointer;
    transition:
      width 240ms cubic-bezier(0.2, 0.8, 0.2, 1),
      opacity 200ms ease,
      margin 240ms ease;
  }

  .volume:hover .volume-slider,
  .volume-slider:focus-visible {
    width: 88px;
    margin: 0 6px 0 2px;
    opacity: 1;
  }

  .volume-slider::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 999px;
    background: linear-gradient(90deg, #f4f4f6 var(--level), rgba(255, 255, 255, 0.25) var(--level));
  }

  .volume-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    margin-top: -4px;
    border-radius: 50%;
    background: #f4f4f6;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  }

  /* ── Subtitles ────────────────────────────────────────────────────────── */

  .menu-anchor {
    position: relative;
  }

  .menu {
    position: absolute;
    right: 0;
    bottom: 52px;
    min-width: 180px;
    max-height: 280px;
    overflow-y: auto;
    padding: 6px;
    border-radius: 12px;
    background: rgba(10, 10, 14, 0.94);
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    scrollbar-color: rgba(255, 255, 255, 0.22) transparent;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 9px 10px;
    border: 0;
    border-radius: 8px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .item:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .item svg {
    width: 18px;
    height: 18px;
    fill: var(--accent);
    visibility: hidden;
  }

  .item.chosen {
    color: var(--accent);
  }

  .item-name {
    flex: 1;
  }

  /* The resolution itself is the icon: what is playing, at a glance. */
  /* The source's name is information, not a label, so it stays words (as on
     the top bar it came from): a pill rather than a disc. */
  .control.source {
    display: flex;
    align-items: center;
    gap: 2px;
    width: auto;
    padding: 0 8px 0 16px;
    border-radius: 999px;
    font: inherit;
    font-size: 15px;
    font-weight: 600;
  }

  .control.source::before {
    border-radius: 999px;
  }

  .control.source svg {
    width: 24px;
    height: 24px;
  }

  .source-name {
    position: relative;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .control.quality {
    width: auto;
    min-width: 52px;
    padding: 0 10px;
    border-radius: 26px;
  }

  .control.quality::before {
    border-radius: 22px;
  }

  .quality-label {
    position: relative;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
  }

  .item-note {
    color: rgba(244, 244, 246, 0.55);
    font-size: 12px;
  }

  .menu-group {
    margin: 8px 10px 4px;
    color: rgba(244, 244, 246, 0.45);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .menu-hint {
    margin: 4px 10px 8px;
    color: rgba(244, 244, 246, 0.6);
    font-size: 13px;
  }

  .menu-hint.bad {
    color: #fb8a9c;
  }

  .item.chosen svg {
    visibility: visible;
  }

  .cues {
    position: absolute;
    left: 50%;
    bottom: 56px;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    max-width: 80%;
    text-align: center;
    pointer-events: none;
    transition: bottom 300ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .cues.lifted {
    bottom: 118px;
  }

  .cues span {
    padding: 3px 10px;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.62);
    font-size: clamp(16px, 2.6vw, 30px);
    font-weight: 600;
    line-height: 1.3;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
  }

  /* The corner card is about 320px wide: at the full size, one line of dialogue filled it. */
  .overlay.mini .cues {
    bottom: 8px;
    max-width: 94%;
    gap: 2px;
  }

  .overlay.mini .cues span {
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 12px;
  }

  /* ── Feedback in the middle of the picture ────────────────────────────── */

  .flash {
    position: absolute;
    left: 50%;
    top: 50%;
    display: grid;
    place-items: center;
    width: 96px;
    height: 96px;
    margin: -48px 0 0 -48px;
    border-radius: 50%;
    background: rgba(10, 10, 14, 0.55);
    animation: pop 620ms cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    pointer-events: none;
  }

  .flash svg {
    width: 44px;
    height: 44px;
    fill: #fff;
  }

  @keyframes pop {
    0% {
      opacity: 0;
      transform: scale(0.6);
    }
    25% {
      opacity: 1;
      transform: scale(1);
    }
    100% {
      opacity: 0;
      transform: scale(1.35);
    }
  }

  .nudge {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 32%;
    display: grid;
    place-items: center;
    overflow: hidden;
    pointer-events: none;
  }

  .nudge.back {
    left: 0;
  }

  .nudge.forward {
    right: 0;
  }

  /* A half-disc of light sweeping in from the side that was jumped towards. */
  .ripple {
    position: absolute;
    top: 50%;
    width: 160%;
    aspect-ratio: 1;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.1);
    transform: translateY(-50%);
    animation: sweep 700ms ease-out forwards;
  }

  .back .ripple {
    right: 10%;
  }

  .forward .ripple {
    left: 10%;
  }

  @keyframes sweep {
    0% {
      opacity: 0;
    }
    30% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }

  .nudge-label {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    font-size: 15px;
    font-weight: 600;
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.7);
    animation: drift 700ms ease-out forwards;
  }

  .chevrons {
    font-size: 30px;
    letter-spacing: -4px;
    line-height: 1;
  }

  @keyframes drift {
    0% {
      opacity: 0;
      transform: scale(0.85);
    }
    25% {
      opacity: 1;
      transform: scale(1);
    }
    100% {
      opacity: 0;
    }
  }

  .hud {
    position: absolute;
    left: 50%;
    top: 18%;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 18px;
    border-radius: 14px;
    background: rgba(10, 10, 14, 0.82);
    border: 1px solid rgba(255, 255, 255, 0.1);
    transform: translateX(-50%);
    animation: hud 900ms ease forwards;
    pointer-events: none;
  }

  .hud svg {
    width: 24px;
    height: 24px;
    fill: #fff;
  }

  .hud-bar {
    width: 140px;
    height: 5px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.22);
    overflow: hidden;
  }

  .hud-bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
    transition: width 120ms ease;
  }

  .hud-value {
    min-width: 48px;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  @keyframes hud {
    0% {
      opacity: 0;
      transform: translate(-50%, -6px);
    }
    15%,
    75% {
      opacity: 1;
      transform: translate(-50%, 0);
    }
    100% {
      opacity: 0;
    }
  }

  .spinner {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 54px;
    height: 54px;
    margin: -27px 0 0 -27px;
    border-radius: 50%;
    border: 4px solid rgba(255, 255, 255, 0.18);
    border-top-color: var(--accent);
    animation: spin 900ms linear infinite;
    pointer-events: none;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* ── Before the film has played ───────────────────────────────────────── */

  /* Opaque: the source's page is loading behind it, adverts and all. */
  .curtain {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 18px;
    background: radial-gradient(circle at 50% 45%, #15151c, #050507 70%);
    pointer-events: auto;
  }

  .curtain-spinner {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    border: 3px solid rgba(255, 255, 255, 0.12);
    border-top-color: var(--accent);
    animation: spin 900ms linear infinite;
  }

  .curtain-label {
    margin: 0;
    color: rgba(244, 244, 246, 0.72);
    font-size: 14px;
    letter-spacing: 0.02em;
    animation: breatheText 2.4s ease-in-out infinite;
  }

  @keyframes breatheText {
    50% {
      opacity: 0.55;
    }
  }

  .note {
    position: absolute;
    left: 16px;
    top: 64px;
    padding: 8px 14px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(10, 10, 14, 0.82);
    font-size: 13px;
    pointer-events: none;
  }

  .big-play {
    /* Shown while the overlay passes taps through (the film is not ours yet),
       so it takes its own: inherited, `none` left it unclickable. */
    pointer-events: auto;
    position: absolute;
    left: 50%;
    top: 50%;
    display: grid;
    place-items: center;
    width: 92px;
    height: 92px;
    margin: -46px 0 0 -46px;
    border: 0;
    border-radius: 50%;
    background: rgba(10, 10, 14, 0.72);
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
    color: #fff;
    cursor: pointer;
    pointer-events: auto;
    transition:
      transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1.2),
      background 180ms ease;
  }

  /* A slow ring breathing out of it: this is where to press. */
  .big-play::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 2px solid rgba(240, 180, 90, 0.7);
    animation: breathe 2.2s ease-out infinite;
  }

  .big-play:hover {
    transform: scale(1.08);
    background: rgba(240, 180, 90, 0.9);
    color: #17110a;
  }

  .big-play:active {
    transform: scale(0.96);
  }

  .big-play svg {
    width: 44px;
    height: 44px;
    margin-left: 5px;
    fill: currentColor;
  }

  @keyframes breathe {
    0% {
      opacity: 0.9;
      transform: scale(1);
    }
    100% {
      opacity: 0;
      transform: scale(1.5);
    }
  }

  .toast {
    position: absolute;
    left: 50%;
    bottom: 120px;
    max-width: min(640px, 80%);
    padding: 10px 16px;
    border-radius: 12px;
    background: rgba(10, 10, 14, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.12);
    font-size: 13px;
    font-weight: 600;
    text-align: center;
    transform: translateX(-50%);
    pointer-events: none;
  }
  /* ── A phone (`touch`) ───────────────────────────────────────────────────
     The picture runs under the status bar and any cutout, so the controls
     keep clear of them (`--safe-*` come from the phone's own sheet). The row
     is 44px buttons, the size of the phone's top bar; play and the jumps sit
     in the middle of the picture instead (`.centre`). */

  .touch .controls {
    padding: 0 max(12px, env(safe-area-inset-right, 0px)) calc(8px + var(--safe-bottom, 0px))
      max(12px, env(safe-area-inset-left, 0px));
  }

  .touch .control {
    width: 44px;
    height: 44px;
  }

  .touch .control svg {
    width: 26px;
    height: 26px;
  }

  /* The two that carry words size to them, as on the desktop. */
  .touch .control.source,
  .touch .control.quality {
    width: auto;
  }

  .touch .control.source {
    padding: 0 4px 0 12px;
    font-size: 14px;
  }

  .touch .source-name {
    max-width: 96px;
  }

  .touch .time {
    margin-left: 4px;
    font-size: 13px;
  }

  .touch .note {
    top: calc(var(--safe-top, 0px) + 64px);
  }

  .centre {
    position: absolute;
    left: 50%;
    top: 50%;
    display: flex;
    align-items: center;
    gap: 36px;
    transform: translate(-50%, -50%) scale(0.92);
    opacity: 0;
    pointer-events: none;
    transition:
      opacity 200ms ease,
      transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .centre.shown {
    opacity: 1;
    transform: translate(-50%, -50%);
    pointer-events: auto;
  }

  .centre-button {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: rgba(10, 10, 14, 0.5);
    color: inherit;
  }

  .centre-button:active {
    transform: scale(0.92);
  }

  .centre-button svg {
    width: 32px;
    height: 32px;
    fill: currentColor;
    overflow: visible;
  }

  .centre-button text {
    font:
      800 7.2px/1 Inter,
      system-ui,
      sans-serif;
    fill: currentColor;
  }

  .centre-button.play-big {
    width: 72px;
    height: 72px;
  }

  .centre-button.play-big svg {
    width: 40px;
    height: 40px;
  }
</style>
