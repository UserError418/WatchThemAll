<script lang="ts">
  /**
   * The global preview-sound switch: one round, flat button, used twice.
   *
   * It governs every preview surface — hovered cards, the browse billboard,
   * the detail hero — so it is `settings.previewAudio`, never a local mute.
   * The nav carries it because that is where the previews are; the detail
   * view carries the same control because a trailer playing there is the
   * moment the user wants it, and reaching past the overlay to the nav is not
   * possible while it is open.
   *
   * One component rather than two copies, because the detail view once had
   * its own local switch that looked different and meant something slightly
   * different, and the pair confused more than either helped. Two places are
   * fine; two controls are not.
   */
  import { library } from '../lib/library.svelte'

  const on = $derived(library.settings.previewAudio)
</script>

<button
  class="sound-btn"
  onclick={() => library.setPreviewAudio(!on)}
  aria-pressed={on}
  aria-label="Preview sound"
  title={on
    ? 'Preview sound is on — click to mute previews'
    : 'Preview sound is off — click to unmute previews'}
>
  <!--
    A stroked SVG, not an emoji. Emoji render as full-colour bitmap glyphs from
    the system font — they carry their own palette and their own idea of
    weight, so they never match a flat monochrome UI and they look different
    on every platform the app ships to.
  -->
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" />
    {#if on}
      <path d="M16 9.2a4 4 0 0 1 0 5.6" />
      <path d="M18.6 6.6a7.6 7.6 0 0 1 0 10.8" />
    {:else}
      <line x1="16.5" y1="9.5" x2="21" y2="14.5" />
      <line x1="21" y1="9.5" x2="16.5" y2="14.5" />
    {/if}
  </svg>
</button>

<style>
  .sound-btn {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: var(--radius-full);
    border: 1px solid var(--border-subtle);
    background: transparent;
    color: var(--text-secondary);
    transition:
      color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }

  .sound-btn svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* The speaker cone is a solid shape; only the waves and the cross are lines. */
  .sound-btn svg path:first-child {
    fill: currentColor;
    stroke-width: 1;
  }

  .sound-btn:hover {
    color: var(--text-primary);
    border-color: var(--border-strong);
    background: var(--bg-elevated);
  }

  /*
    Sound on is the default and the louder state, so it is the one that gets
    the accent; muted is a plain outline rather than a dimmed version of the
    same thing, because a control at 50% opacity reads as disabled.
  */
  .sound-btn[aria-pressed='true'] {
    color: var(--accent);
    border-color: var(--accent);
  }
</style>
