<script lang="ts">
  /**
   * The preview cache's copy of the stream, played by the app's own `<video>`
   * (the owner, 2026-09-29): on screen the moment the detail view opens,
   * while the source's own preview (`StreamPreview`) loads out of sight and
   * takes over at the same second. See `main/segmentwindow.ts` for what is
   * kept and why, and `DetailOverlay` for the handover.
   *
   * Everything it reports is in the kept video's own time (its 0 is the
   * window's first frame); the page adds the window's start to get film time.
   * At its end it holds the last frame, which is what the viewer sees if the
   * source has not taken over by then.
   */
  import { CARRY_HANDOVER_FADE_MS, CARRY_HANDOVER_HOLD_MS } from './StreamPreview.svelte'

  interface Props {
    src: string
    /** Where to start in the kept video's own time. */
    from: number
    muted: boolean
    /** Paused at the viewer's word (Space while standing in for the player). */
    paused?: boolean
    /** Standing in for the player: the whole window, letterboxed, as `StreamPreview` does. */
    carried?: boolean
    /**
     * Carried, and the player is showing now: stays over it a moment, silent,
     * then fades, exactly as `StreamPreview` does (`CARRY_HANDOVER_HOLD_MS`).
     */
    leaving?: boolean
    onstate: (state: { seconds: number; playing: boolean; waiting: boolean; ended: boolean }) => void
    /** The copy would not play at all: the page carries on without it. */
    onfail: () => void
    ontap?: () => void
  }

  const { src, from, muted, paused = false, carried = false, leaving = false, onstate, onfail, ontap }: Props = $props()

  /** How quickly it comes up: a local file is there at once, so only a softening. */
  const APPEAR_MS = 200

  let video = $state<HTMLVideoElement | null>(null)
  let shown = $state(false)
  let waiting = $state(false)

  function report(): void {
    if (video === null) return
    onstate({ seconds: video.currentTime, playing: !video.paused, waiting, ended: video.ended })
  }

  $effect(() => {
    const element = video
    if (element === null) return
    // Read once: a new `from` is a new copy, and is mounted afresh by the page.
    // Set when the length is known; before that a seek may simply be dropped.
    const start = Math.max(0, from)
    const onMetadata = (): void => {
      element.currentTime = start
    }
    const onPlaying = (): void => {
      waiting = false
      shown = true
      report()
    }
    const onWaiting = (): void => {
      waiting = true
      report()
    }
    element.addEventListener('loadedmetadata', onMetadata, { once: true })
    element.addEventListener('playing', onPlaying)
    element.addEventListener('waiting', onWaiting)
    element.addEventListener('timeupdate', report)
    element.addEventListener('pause', report)
    element.addEventListener('ended', report)
    element.addEventListener('error', onfail)
    return () => {
      element.removeEventListener('loadedmetadata', onMetadata)
      element.removeEventListener('playing', onPlaying)
      element.removeEventListener('waiting', onWaiting)
      element.removeEventListener('timeupdate', report)
      element.removeEventListener('pause', report)
      element.removeEventListener('ended', report)
      element.removeEventListener('error', onfail)
      element.pause()
      element.removeAttribute('src')
      element.load()
    }
  })

  $effect(() => {
    if (video !== null) video.muted = muted
  })
  $effect(() => {
    const element = video
    if (element === null) return
    if (paused) element.pause()
    else if (!element.ended) void element.play().catch(() => {})
  })
</script>

<!--
  The same frame as `StreamPreview`'s, so the copy and the source line up
  exactly when one crossfades into the other: covering the hero, and the
  whole window, letterboxed, while carried.
-->
<div
  class="cached-frame"
  class:shown
  class:carried
  class:leaving
  style:--appear="{APPEAR_MS}ms"
  style:--leave-hold="{CARRY_HANDOVER_HOLD_MS}ms"
  style:--leave-fade="{CARRY_HANDOVER_FADE_MS}ms"
  aria-hidden="true"
  onclick={() => carried && !leaving && ontap?.()}
>
  <!-- The hero's preview, hidden from assistive technology like the source's own; the player carries the subtitles. -->
  <!-- svelte-ignore a11y_media_has_caption -->
  <video bind:this={video} class="cached" {src} playsinline disablepictureinpicture preload="auto"></video>
</div>

<style>
  .cached-frame {
    position: absolute;
    inset: 0;
    overflow: hidden;
    container-type: size;
    pointer-events: none;
    opacity: 0;
    transition: opacity var(--appear) ease-out;
  }

  .cached-frame.shown {
    opacity: 1;
  }

  .cached-frame.carried {
    position: fixed;
    z-index: 1000;
    background: #000;
    pointer-events: auto;
    cursor: pointer;
  }

  .cached-frame.carried.leaving {
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--leave-fade) ease-in var(--leave-hold);
  }

  .cached {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: max(100cqw, calc(100cqh * 16 / 9));
    height: max(100cqh, calc(100cqw * 9 / 16));
    object-fit: cover;
    background: #000;
    pointer-events: none;
  }

  .carried .cached {
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    transform: none;
    object-fit: contain;
  }
</style>
