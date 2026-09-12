<script lang="ts">
  /**
   * The app's chrome around the inline player.
   *
   * The video itself is **not in this component**. It is a native
   * `WebContentsView` the main process layers over the window, and it always
   * paints on top of the page — so this component's job is to reserve a
   * rectangle, report where that rectangle is, and draw everything *around* it.
   *
   * That constraint is the whole design. Nothing here may overlap the video:
   * a menu dropped over it would render underneath and look like it failed to
   * open.
   *
   * Every control lives in this bar — episode and season stepping, reload, and
   * the source switcher. They used to be injected into the provider's own page
   * by the player preload, which put them on top of the picture at the cost of
   * living inside a hostile document that repaints them away. The bar is
   * ordinary DOM and outside the video's rectangle, so it has neither problem.
   *
   * The source *menu* is the one thing that would have to overlap, and it does
   * not: it opens as another band of chrome below the bar, so the video gives
   * up the space rather than being covered. The slot's ResizeObserver already
   * reports that, so it costs no new plumbing.
   */
  import type { PlayerState } from '@shared/ipc'

  interface Props {
    /**
     * Named `player`, not `state`: a local binding called `state` makes every
     * `$state(...)` in this file parse as a store subscription on it.
     */
    player: PlayerState
    onclose: () => void
  }

  const { onclose }: Props = $props()

  let slot = $state<HTMLDivElement | null>(null)

  /**
   * Tell main where the video goes, whenever that changes.
   *
   * A `ResizeObserver` on the slot catches the window resizing, the chrome
   * changing height, and the initial mount. `getBoundingClientRect` is in CSS
   * pixels relative to the viewport, which is the same coordinate space the
   * window's content area uses, so it needs no conversion.
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
    // The slot also changes size when the bar hides, and a ResizeObserver does
    // see that — but the transition means the final size arrives a frame later
    // than the class change, which is why the observer is what reports rather
    // than the visibility effect.
    observer.observe(node)
    // The observer fires on size but not on the slot *moving*, which happens
    // when the window itself moves between displays with different scaling.
    window.addEventListener('resize', report)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  })

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') onclose()
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="player">
  <!--
    `role="group"` because the bar now carries mouse handlers, and an element
    that reacts to the pointer has to say what it is. Not `toolbar`, which
    promises arrow-key navigation between the controls that this does not
    implement; `group` claims only what is true — these belong together.
  -->
  <!--
    No chrome here any more.

    The bar and the source menu moved into their own transparent view,
    stacked above the video — see `PlayerChrome.svelte`. They had to: this
    page is the window's own content and always paints *beneath* the native
    player view, so a menu drawn here rendered behind the picture. Reserving a
    band of layout was the only way to make one visible, and that reservation
    is exactly what pushed the video down whenever a menu opened.

    What stays is the slot, its bounds reporting, and the switch offer below.
    The slot is the rectangle the video is laid into, and it is now the whole
    of this component.
  -->

  <!-- The reserved rectangle. Deliberately empty: the video is layered over it. -->
  <div class="slot" bind:this={slot}></div>
</div>

<style>
  .player {
    position: fixed;
    inset: 0;
    z-index: 300;
    display: flex;
    flex-direction: column;
    background: #000;
  }

  .slot {
    flex: 1 1 auto;
    /* Nothing renders here; the native view covers it exactly. Black so the
       moment before the view is positioned is not a bright flash. */
    background: #000;
  }
</style>
