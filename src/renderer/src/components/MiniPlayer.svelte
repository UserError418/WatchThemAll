<script lang="ts">
  /**
   * The player, shrunk into the corner so the app can be browsed around it.
   *
   * Asked for on 2026-09-27, "just like YouTube or Netflix": Back in the
   * player no longer stops the video, it lands here. The ✕ on this card
   * stops it; ↗ or a tap on the picture brings the full player back.
   *
   * The video is not in this component, just as it is not in `PlayerFrame`.
   * The slot below is a reserved rectangle whose bounds are reported to the
   * platform. On the desktop, a native view is laid over it. On the phone, the
   * surface iframe is moved behind it. Either way nothing may be drawn over
   * the slot, so the controls sit *beneath* the picture, in the card's own
   * bar, rather than over it the way the full player's chrome does.
   *
   * ## Two shapes
   *
   * A floating card in a wide window: the picture on top, a row of controls
   * under it, bottom-right. In a narrow one (a phone held upright) it becomes
   * a strip docked above the tab bar, a small picture beside the controls,
   * which is the arrangement people know from YouTube's app. The difference is
   * the width of the window, not the platform; `mobile.css` only moves it
   * clear of the tab bar (`--mini-bottom`).
   */
  import type { CastStatus, PlayerState } from '@shared/ipc'
  import { episodeCode } from '../lib/format'

  interface Props {
    player: PlayerState
    /**
     * Whether the video is paused, as the video itself last said. The
     * platform sends the current state the moment the player shrinks, then
     * every change, so a pause made with the provider's own controls reads
     * the same as one made with this button. `App` holds it; see there for
     * why the card cannot listen for it itself.
     */
    paused: boolean
    /**
     * A source-switch offer is waiting. The full player's chrome shows it
     * with a countdown, and that chrome is out of sight while the player is
     * small. So the countdown is held (see `PlayerChrome`) and this card says
     * why the picture has stopped instead of letting the app switch unseen.
     * `App` holds it, like `paused`.
     */
    stalled: boolean
  }

  const { player, paused: videoPaused, stalled }: Props = $props()

  let slot = $state<HTMLButtonElement | null>(null)

  /**
   * The button's state: the video's, until the button is pressed.
   *
   * A press flips it at once so the button feels instant; the video's own
   * answer then arrives through the prop and replaces it. If the page refuses
   * and says nothing, the pressed state stays, as it would with no event.
   */
  let paused = $derived(videoPaused)

  /** A television, when the picture is on one rather than here. */
  let cast = $state<CastStatus | null>(null)


  /**
   * Tell the platform where the video goes, the same way `PlayerFrame` does.
   *
   * The resize listener is not optional here. The card is anchored to the
   * bottom of the window, so a window that only grows taller moves the slot
   * without resizing it, and a `ResizeObserver` reports sizes, not
   * positions.
   */
  $effect(() => {
    const node = slot
    if (!node) return
    const report = (): void => {
      const rect = node.getBoundingClientRect()
      void window.wta.player.setBounds({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(node)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  })

  /**
   * Follow a cast while the card is up.
   *
   * Polled rather than subscribed, because cast status has no event in the
   * app window's contract. That is fine at this rate, and only while the
   * card exists. With a TV attached, this card becomes its remote in
   * miniature: the button pauses the TV, not the muted page here.
   */
  $effect(() => {
    let alive = true
    let timer: ReturnType<typeof setInterval> | undefined
    const read = (): void => {
      window.wta.cast
        .status()
        .then((status) => {
          if (alive) cast = status
        })
        .catch(() => {})
    }
    void window.wta.cast
      .available()
      .then((available) => {
        if (!available || !alive) return
        read()
        timer = setInterval(read, 2_000)
      })
      .catch(() => {})
    return () => {
      alive = false
      clearInterval(timer)
    }
  })

  const tv = $derived(cast?.connected ? cast.deviceName : null)
  /** What the button acts on: the TV's state while casting, the page's otherwise. */
  const showingPaused = $derived(tv ? !(cast?.playing ?? false) : paused)

  const heading = $derived(
    player.season !== null && player.episode !== null
      ? `${player.title} · ${episodeCode(player.season, player.episode)}`
      : player.title,
  )

  const detail = $derived(
    tv
      ? `Playing on ${tv}`
      : stalled
        ? 'This source stopped. Open the player to switch.'
        : (player.providerName ?? ''),
  )

  function togglePlayback(): void {
    if (tv) {
      void window.wta.cast.control(showingPaused ? 'play' : 'pause')
      return
    }
    paused = !paused
    void window.wta.player.setPaused(paused)
  }

  const expand = (): void => void window.wta.player.setMini(false)
  const stop = (): void => void window.wta.player.close()
</script>

<!-- `data-stays-live`: usable while a modal overlay is open (lib/modal.ts). -->
<div class="mini" role="group" aria-label="Mini player" data-stays-live>
  <!--
    The picture's rectangle. A button, because on the phone a tap on the small
    picture lands here (the video is behind this transparent box) and should
    bring the full player back, as it does in every app with a mini player. On
    the desktop the native view covers it, and clicks reach the provider's own
    controls instead.
  -->
  <button class="slot" bind:this={slot} onclick={expand} aria-label="Open the full player"></button>

  <div class="bar">
    <button class="info" onclick={expand} title="Open the full player">
      <span class="heading">{heading}</span>
      {#if detail}<span class="detail" class:warn={stalled && !tv}>{detail}</span>{/if}
    </button>
    <button
      class="control"
      onclick={togglePlayback}
      aria-label={showingPaused ? 'Play' : 'Pause'}
      title={showingPaused ? 'Play' : 'Pause'}
    >
      {#if showingPaused}
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
      {:else}
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
      {/if}
    </button>
    <button class="control" onclick={expand} aria-label="Open the full player" title="Open the full player">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M14 4h6v6h-2V7.4l-4.3 4.3-1.4-1.4L16.6 6H14zM4 14h2v2.6l4.3-4.3 1.4 1.4L7.4 18H10v2H4z" />
      </svg>
    </button>
    <button class="control" onclick={stop} aria-label="Stop playing" title="Stop playing">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z" />
      </svg>
    </button>
  </div>
</div>

<style>
  /*
    No background on the card itself, only on the bar. On the phone the
    video is an iframe *behind* this card (the surface sits at 299, this at
    300, like PlayerFrame), so a card background would paint over the picture.
  */
  .mini {
    position: fixed;
    right: var(--space-5);
    bottom: var(--mini-bottom, var(--space-5));
    z-index: 300;
    width: clamp(320px, 26vw, 460px);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-lg);
  }

  .slot {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
    background: var(--bg-raised);
    border-radius: 0 0 var(--radius-md) var(--radius-md);
  }

  .info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .heading,
  .detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .heading {
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .detail {
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .detail.warn {
    color: var(--accent);
  }

  .control {
    display: grid;
    flex-shrink: 0;
    place-items: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-full);
    background: none;
    color: var(--text-primary);
    cursor: pointer;
  }

  .control:hover {
    background: var(--bg-hover);
  }

  .control svg {
    width: 20px;
    height: 20px;
    fill: currentColor;
  }

  /*
    A narrow window: a strip across the bottom, picture on the left. 128px
    wide keeps the picture recognisable and leaves the controls a thumb's
    width each on a 412px phone.
  */
  @media (max-width: 600px) {
    .mini {
      left: var(--space-2);
      right: var(--space-2);
      bottom: var(--mini-bottom, var(--space-2));
      width: auto;
      display: grid;
      grid-template-columns: 128px minmax(0, 1fr);
    }

    .bar {
      height: 100%;
      border-radius: 0 var(--radius-md) var(--radius-md) 0;
    }

    .control {
      width: 44px;
      height: 44px;
    }
  }
</style>
