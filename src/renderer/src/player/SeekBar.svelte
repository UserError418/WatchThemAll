<script lang="ts">
  /**
   * The overlay's seek bar.
   *
   * The pointer previews: hovering shows the time under it, and dragging
   * moves the thumb with the pointer. The film is only told on release,
   * because a stream seeked on every pointer move fetches a segment per move,
   * and HLS players stall doing it.
   */
  import { clock } from '../lib/format'

  interface Props {
    /** Where the film is, in seconds; smoothed by the overlay between reports. */
    current: number
    duration: number
    /** How far the stream is loaded, in seconds of the film. */
    buffered: number
    onseek: (seconds: number) => void
    /** True while a drag is under way, so the controls stay up. */
    onscrub: (scrubbing: boolean) => void
  }

  const { current, duration, buffered, onseek, onscrub }: Props = $props()

  let track = $state<HTMLDivElement | null>(null)
  let hovering = $state(false)
  let dragging = $state(false)
  /** The pointer's place along the bar, 0..1. */
  let pointer = $state(0)

  const fraction = (seconds: number): number => (duration > 0 ? Math.min(1, Math.max(0, seconds / duration)) : 0)
  const shown = $derived(dragging ? pointer : fraction(current))
  const percent = (value: number): string => `${(value * 100).toFixed(3)}%`

  function place(event: PointerEvent): void {
    if (!track) return
    const rect = track.getBoundingClientRect()
    pointer = rect.width > 0 ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0
  }

  function down(event: PointerEvent): void {
    if (event.button !== 0 || duration <= 0) return
    event.stopPropagation()
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    place(event)
    dragging = true
    onscrub(true)
  }

  function move(event: PointerEvent): void {
    place(event)
  }

  function up(event: PointerEvent): void {
    if (!dragging) return
    event.stopPropagation()
    place(event)
    dragging = false
    onscrub(false)
    onseek(pointer * duration)
  }

  /** The time bubble stays inside the bar, however close to an end it is. */
  const bubbleLeft = $derived(`clamp(28px, ${percent(pointer)}, calc(100% - 28px))`)
</script>

<div
  class="seek"
  class:active={hovering || dragging}
  role="slider"
  tabindex="-1"
  aria-label="Seek"
  aria-valuemin={0}
  aria-valuemax={Math.round(duration)}
  aria-valuenow={Math.round(current)}
  aria-valuetext={`${clock(current)} of ${clock(duration)}`}
  onpointerenter={() => (hovering = true)}
  onpointerleave={() => (hovering = false)}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
>
  <div class="track" bind:this={track}>
    <div class="fill buffered" style:width={percent(fraction(buffered))}></div>
    {#if hovering && !dragging}
      <div class="fill preview" style:width={percent(pointer)}></div>
    {/if}
    <div class="fill played" style:width={percent(shown)}></div>
  </div>
  <div class="thumb" style:left={percent(shown)}></div>
  {#if hovering || dragging}
    <div class="bubble" style:left={bubbleLeft}>{clock(pointer * duration)}</div>
  {/if}
</div>

<style>
  .seek {
    position: relative;
    height: 22px;
    display: flex;
    align-items: center;
    cursor: pointer;
    touch-action: none;
  }

  .track {
    position: relative;
    width: 100%;
    height: 4px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.22);
    overflow: hidden;
    transform-origin: center;
    transition: transform 160ms ease;
  }

  /* Thicker under the pointer: easier to aim at, and says "this is live". */
  .active .track {
    transform: scaleY(1.6);
  }

  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: inherit;
  }

  .buffered {
    background: rgba(255, 255, 255, 0.32);
    transition: width 400ms ease;
  }

  .preview {
    background: rgba(255, 255, 255, 0.22);
  }

  .played {
    background: linear-gradient(90deg, #e9a13b, #f6c56f);
  }

  .thumb {
    position: absolute;
    top: 50%;
    width: 14px;
    height: 14px;
    margin-left: -7px;
    border-radius: 50%;
    background: #f6c56f;
    box-shadow: 0 0 0 4px rgba(240, 180, 90, 0.25);
    transform: translateY(-50%) scale(0);
    transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1.2);
    pointer-events: none;
  }

  .active .thumb {
    transform: translateY(-50%) scale(1);
  }

  .bubble {
    position: absolute;
    bottom: 24px;
    transform: translateX(-50%);
    padding: 5px 9px;
    border-radius: 8px;
    background: rgba(10, 10, 14, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.12);
    font-size: 12.5px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    pointer-events: none;
    animation: rise 140ms ease-out;
  }

  @keyframes rise {
    from {
      opacity: 0;
      transform: translate(-50%, 4px);
    }
  }
</style>
