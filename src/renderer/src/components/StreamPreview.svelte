<script lang="ts">
  /**
   * The title itself, playing in the detail view's hero where the trailer
   * would (the owner, 2026-09-27).
   *
   * Nothing of a player is ever shown: no controls of ours, none of the
   * source's. The element stays invisible until the film is really playing
   * (`PreviewReport.started`), and a preview that does not get there within
   * `GIVE_UP_MS` hands the hero back to the trailer (`onfail`). So the only
   * things this can put on screen are the backdrop it replaces, and the film.
   *
   * The platform decides the element (`PreviewPlan.surface`):
   * - `webview` (desktop): the player shell in preview mode, which drives the
   *   film itself and reports with `sendToHost`; see `previewview.ts`.
   * - `iframe` (phone): the provider's page, driven from here with the same
   *   `PreviewFilm` the desktop's shell runs.
   */
  import { untrack } from 'svelte'
  import { PREVIEW_MUTED, PREVIEW_STATE, type PreviewPlan, type PreviewReport } from '@shared/ipc'
  import { FilmLink } from '../player/filmlink'
  import { PreviewFilm } from '../player/previewfilm'

  interface Props {
    plan: PreviewPlan
    muted: boolean
    onstate: (state: PreviewReport) => void
    onfail: () => void
  }

  const { plan, muted, onstate, onfail }: Props = $props()

  /**
   * How long a preview may take to show a film. The plan only offers sources
   * that started streaming within 4 s in a test; the page load, the jump to
   * the saved place and the check that it is playing come on top of that.
   */
  const GIVE_UP_MS = 20_000
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

  function isReport(value: unknown): value is PreviewReport {
    if (typeof value !== 'object' || value === null) return false
    const v = value as Record<string, unknown>
    return (
      typeof v.started === 'boolean' &&
      typeof v.seconds === 'number' &&
      typeof v.duration === 'number' &&
      typeof v.playing === 'boolean' &&
      typeof v.muted === 'boolean'
    )
  }
</script>

<!--
  Sized like the trailer (`.embed-cover-frame` in global.css): at least as
  wide as the hero and at least 16:9-tall for that width, centred and
  clipped, so a 16:9 film covers the hero without bars. No overscan: unlike
  YouTube there is no foreign chrome to crop, because none is ever drawn.
-->
<div class="stream-frame" class:shown={started} aria-hidden="true">
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
    transition: opacity 600ms ease-out;
  }

  .stream-frame.shown {
    opacity: 1;
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
