<script module lang="ts">
  /** How long the film takes to fade in over whatever the hero showed before it. */
  export const STREAM_FADE_MS = 600
  /**
   * The player shown, a carried preview stays over it this long, silent,
   * then fades out. A player is not painted in the instant it is shown: the
   * phone showed ~150 ms of black between the two when the preview went at
   * once (screen recording, 2026-09-29). On the desktop the player's view
   * paints over the page, so there the preview simply goes unseen.
   */
  export const CARRY_HANDOVER_HOLD_MS = 300
  export const CARRY_HANDOVER_FADE_MS = 250
</script>

<script lang="ts">
  /**
   * The title itself, playing in the detail view's hero where the trailer
   * would (the owner, 2026-09-27).
   *
   * Nothing of a player is ever shown: no controls of ours, none of the
   * source's. The element stays invisible until the film is really playing
   * (`PreviewReport.started`), and a preview that does not get there within
   * `GIVE_UP_MS` gives up (`onfail`), leaving the trailer that plays beneath
   * it meanwhile. So the only thing this can put on screen is the film.
   *
   * The platform decides the element (`PreviewPlan.surface`):
   * - `webview` (desktop): the player shell in preview mode, which drives the
   *   film itself and reports with `sendToHost`; see `previewview.ts`.
   * - `iframe` (phone): the provider's page, driven from here with the same
   *   `PreviewFilm` the desktop's shell runs.
   */
  import { untrack } from 'svelte'
  import { PREVIEW_MUTED, PREVIEW_PAUSED, PREVIEW_SEEK, PREVIEW_STATE, type PreviewPlan, type PreviewReport } from '@shared/ipc'
  import { FilmLink } from '../player/filmlink'
  import { PreviewFilm } from '../player/previewfilm'

  interface Props {
    plan: PreviewPlan
    muted: boolean
    /**
     * Standing in for the player while it loads held (Resume carried over,
     * `shared/carryover.ts`): the film fills the window, and a tap on it asks
     * for the player (`ontap`).
     */
    carried?: boolean
    /**
     * Carried, and the player is showing now: the film stays over it for
     * `CARRY_HANDOVER_HOLD_MS`, then fades, and taps go to the player.
     */
    leaving?: boolean
    /** Paused at the viewer's word; only while carried. */
    paused?: boolean
    /**
     * Kept out of sight even once playing: the preview cache's copy is on
     * screen, and this takes over only when the page says (`hold` lifted).
     */
    hold?: boolean
    /** Move the film to this second; a new object each time asks again. */
    seek?: { seconds: number } | null
    onstate: (state: PreviewReport) => void
    onfail: () => void
    ontap?: () => void
  }

  const {
    plan,
    muted,
    carried = false,
    leaving = false,
    paused = false,
    hold = false,
    seek = null,
    onstate,
    onfail,
    ontap,
  }: Props = $props()

  /**
   * How long a preview may take to show a film. The plan only offers sources
   * that started streaming within 8 s in a test; the page load, the jump to
   * the saved place and the check that it is playing come on top of that.
   */
  const GIVE_UP_MS = 30_000
  /** As often as the player asks its frames for a report. */
  const HEARTBEAT_MS = 2_000

  let started = $state(false)

  function report(state: PreviewReport): void {
    if (state.started) started = true
    onstate(state)
  }

  $effect(() => {
    if (started) return
    const timer = setTimeout(onfail, GIVE_UP_MS)
    return () => clearTimeout(timer)
  })

  /* ── Desktop: a webview of the preview shell ─────────────────────────── */

  /** Electron's `<webview>`, as far as this component uses it. */
  interface WebviewElement extends HTMLElement {
    send(channel: string, ...args: unknown[]): void
    setAudioMuted(muted: boolean): void
    loadURL(url: string): Promise<void>
  }

  let webview = $state<WebviewElement | null>(null)
  let webviewReady = $state(false)

  $effect(() => {
    const view = webview
    if (view === null) return
    const onReady = (): void => {
      webviewReady = true
    }
    const onMessage = (event: Event): void => {
      const { channel, args } = event as Event & { channel: string; args: unknown[] }
      if (channel === PREVIEW_STATE && isReport(args[0])) report(args[0])
    }
    view.addEventListener('dom-ready', onReady)
    view.addEventListener('ipc-message', onMessage)
    return () => {
      view.removeEventListener('dom-ready', onReady)
      view.removeEventListener('ipc-message', onMessage)
      /*
       * Silence and unload the guest now. Removing the element destroys it
       * seconds later, not at once (measured: still playing 8 s after the
       * detail view closed), and a preview with its sound on would play
       * under the player that Resume just opened.
       */
      try {
        view.setAudioMuted(true)
        view.loadURL('about:blank')
      } catch {
        // Never attached, or already gone: nothing is playing.
      }
    }
  })

  // The sound button, at the source (`setAudioMuted`, which also silences an
  // advert the relay cannot see) and in the film (`PREVIEW_MUTED`). Re-sent
  // on every shell load, since each one starts muted.
  $effect(() => {
    const view = webview
    if (view === null || !webviewReady) return
    view.setAudioMuted(muted)
    view.send(PREVIEW_MUTED, muted)
  })
  $effect(() => {
    const view = webview
    if (view === null || !webviewReady) return
    view.send(PREVIEW_PAUSED, paused)
  })
  $effect(() => {
    const view = webview
    const to = seek
    if (view === null || !webviewReady || to === null) return
    view.send(PREVIEW_SEEK, to.seconds)
  })

  /* ── Phone: an iframe of the provider, driven from here ──────────────── */

  let frame = $state<HTMLIFrameElement | null>(null)
  let film: PreviewFilm | null = null

  $effect(() => {
    const target = frame
    if (target === null) return
    const link = new FilmLink((message) => target.contentWindow?.postMessage(message, '*'))
    // Read once: the sound button is applied by the effect below, and must
    // not rebuild the controller (and restart the film) when it changes.
    const driver = untrack(() => new PreviewFilm(link, plan.startSeconds, muted))
    film = driver
    const act = (): void => report(driver.step())
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== target.contentWindow) return
      if (link.receive(event.data)) act()
    }
    window.addEventListener('message', onMessage)
    link.watch()
    const heartbeat = setInterval(() => {
      link.watch()
      act()
    }, HEARTBEAT_MS)
    return () => {
      film = null
      clearInterval(heartbeat)
      window.removeEventListener('message', onMessage)
    }
  })

  $effect(() => {
    film?.setMuted(muted)
  })
  $effect(() => {
    film?.setPaused(paused)
  })
  $effect(() => {
    if (seek !== null) film?.seekTo(seek.seconds)
  })

  function isReport(value: unknown): value is PreviewReport {
    if (typeof value !== 'object' || value === null) return false
    const v = value as Record<string, unknown>
    return (
      typeof v.started === 'boolean' &&
      typeof v.seconds === 'number' &&
      typeof v.duration === 'number' &&
      typeof v.playing === 'boolean' &&
      typeof v.waiting === 'boolean' &&
      typeof v.muted === 'boolean' &&
      (v.streamedMs === null || typeof v.streamedMs === 'number')
    )
  }
</script>

<!--
  Sized like the trailer (`.embed-cover-frame` in global.css): at least as
  wide as the hero and at least 16:9-tall for that width, centred and
  clipped, so a 16:9 film covers the hero without bars. No overscan: unlike
  YouTube there is no foreign chrome to crop, because none is ever drawn.
-->
<div
  class="stream-frame"
  class:shown={started && !hold}
  class:carried
  class:leaving
  style:--fade="{STREAM_FADE_MS}ms"
  style:--leave-hold="{CARRY_HANDOVER_HOLD_MS}ms"
  style:--leave-fade="{CARRY_HANDOVER_FADE_MS}ms"
  aria-hidden="true"
  onclick={() => carried && !leaving && ontap?.()}
>
  {#if plan.surface === 'webview'}
    <webview bind:this={webview} class="stream" src={plan.src} tabindex="-1"></webview>
  {:else}
    <iframe
      bind:this={frame}
      class="stream"
      src={plan.src}
      title=""
      allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
      referrerpolicy="origin"
      tabindex="-1"
    ></iframe>
  {/if}
</div>

<style>
  .stream-frame {
    position: absolute;
    inset: 0;
    overflow: hidden;
    container-type: size;
    pointer-events: none;
    opacity: 0;
    transition: opacity var(--fade) ease-out;
  }

  .stream-frame.shown {
    opacity: 1;
  }

  /*
    Standing in for the player: the whole window, above the rest of the
    detail view, as the player itself would be. The film is letterboxed by
    the source's own page, as in the player, rather than cropped to cover.
    A tap anywhere on it asks for the player.
  */
  .stream-frame.carried {
    position: fixed;
    z-index: 1000;
    background: #000;
    pointer-events: auto;
    cursor: pointer;
  }

  .stream-frame.carried.leaving {
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--leave-fade) ease-in var(--leave-hold);
  }

  .stream-frame.carried .stream {
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    transform: none;
  }

  .stream {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: max(100cqw, calc(100cqh * 16 / 9));
    height: max(100cqh, calc(100cqw * 9 / 16));
    border: 0;
    pointer-events: none;
    background: #000;
  }
</style>
