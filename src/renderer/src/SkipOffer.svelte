<script lang="ts">
  /**
   * The skip button — "Skip intro", "Skip recap", or "Next episode" over the
   * credits (`main/skipwatch.ts`) — in its own overlay view.
   *
   * Separate from `PlayerChrome.svelte` for a geometric reason, not a
   * stylistic one. A `WebContentsView` swallows every mouse event inside its
   * bounds, so a view is sized to exactly what it draws — and this button
   * belongs in the bottom-right corner, where every player the user has ever
   * used puts it, while the bar belongs across the top. One view cannot hold
   * both without making the whole picture between them unclickable.
   *
   * It knows only what to say. Which database the timestamp came from,
   * whether the answer survived being checked against the stream, and what a
   * press does, are decided in the main process where they can be tested.
   *
   * The phone mounts it over its own controls (`touch`), where no view has to
   * be sized to it and it places itself in the corner.
   */

  import type { SkipOffer } from '@shared/ipc'

  interface Props {
    touch?: boolean
  }

  const { touch = false }: Props = $props()

  const api = window.wtaChrome

  const LABELS: Record<SkipOffer['kind'], string> = {
    intro: 'Skip intro',
    recap: 'Skip recap',
    next: 'Next episode',
  }

  let offer = $state<SkipOffer | null>(null)
  let button = $state<HTMLButtonElement | null>(null)

  $effect(() =>
    api?.onSkipOffer((next) => {
      offer = next
    }),
  )

  /**
   * Report the size so the view can be trimmed to it.
   *
   * Measured rather than assumed, because the label's width depends on the
   * font the system actually resolved, and an overlay one pixel wider than
   * the button is one pixel of video nobody can click.
   */
  $effect(() => {
    const node = button
    if (!node) {
      api?.setSkipSize(0, 0)
      return
    }
    const report = (): void => api.setSkipSize(node.offsetWidth, node.offsetHeight)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(node)
    return () => observer.disconnect()
  })

  function skip(): void {
    if (!offer) return
    api.skip()
    // Cleared locally as well as by the main process: the position poll only
    // runs every few seconds, and a button that lingers after being pressed
    // invites a second press that jumps forward again.
    offer = null
  }
</script>

{#if offer}
  <button class="skip" class:touch bind:this={button} onclick={skip}>{LABELS[offer.kind]}</button>
{/if}

<style>
  /*
    Deliberately plain and deliberately conventional. This button appears over
    somebody's film for a few seconds and then leaves; anything expressive
    here is a distraction from the picture it is sitting on.
  */
  .skip {
    background: rgba(18, 18, 22, 0.86);
    border: 1px solid rgba(255, 255, 255, 0.5);
    border-radius: 6px;
    color: #f4f4f6;
    cursor: pointer;
    font:
      600 14px/1 Inter,
      system-ui,
      sans-serif;
    letter-spacing: 0.02em;
    padding: 13px 26px;
    white-space: nowrap;
  }

  .skip:hover {
    background: #f4f4f6;
    color: #17171c;
  }

  /* The phone: above our own controls' two rows at the bottom of the screen,
     clear of the cutout and the gesture bar. */
  .skip.touch {
    position: fixed;
    right: max(16px, env(safe-area-inset-right, 0px));
    bottom: calc(104px + var(--safe-bottom, 0px));
    pointer-events: auto;
  }

  .skip.touch:hover {
    background: rgba(18, 18, 22, 0.86);
    color: #f4f4f6;
  }
</style>
