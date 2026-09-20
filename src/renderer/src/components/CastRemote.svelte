<script lang="ts">
  /**
   * The phone as a remote control.
   *
   * ## Why this is a surface and not a panel
   *
   * While a cast is running the device is **not showing a video**. The embed is
   * blanked deliberately — otherwise it pulls the same film it is simultaneously
   * serving to the television, and plays the audio in a second room. What is
   * behind this is therefore a blank frame, and the controls used to be a small
   * panel floating over it. That is the report: "the controls are in the popup
   * and the player becomes white".
   *
   * So this covers the lot. There is nothing behind it the user wants, which
   * makes covering it the correct answer rather than a cosmetic one.
   *
   * On the desktop that is load-bearing rather than figurative: the chrome is a
   * real `WebContentsView` sized by `setOverlayHeight`, and a view swallows
   * every mouse event inside its bounds. The caller reports a height large
   * enough to be clamped to the whole slot while this is mounted — the same
   * mechanism that makes the bar 56px tall, used at its limit.
   *
   * ## Not a skeuomorphic remote
   *
   * "Remote simulation" is the intent — a device whose entire screen is
   * controls for something happening elsewhere — and a d-pad would simulate the
   * wrong thing. There is no receiver menu to navigate here, only one stream to
   * transport. What is drawn is what can actually be commanded.
   *
   * ## No subtitle or quality control, and that is measured
   *
   * Both live in an HLS master playlist, and the Default Media Receiver refuses
   * HLS outright — measured 2026-09-13, `LOAD_FAILED` before it opens a single
   * TCP connection, even against textbook HLS generated locally by ffmpeg. A
   * cast therefore only ever carries a whole progressive file, which has one
   * rendition and no text tracks. Lifting that means registering a custom
   * receiver in the Cast Developer Console; the owner was asked on 2026-09-20 and
   * chose not to. Drawing the controls anyway would be drawing buttons that
   * cannot work.
   *
   * ## No design tokens in this file, on purpose
   *
   * This component is mounted into `chrome.html`, which has no stylesheet —
   * see the note beside `RESUME_COLOUR` in `PlayerChrome.svelte`. Literal
   * colours are the local convention, not an oversight, and they are the same
   * blues the cast button already uses so a running cast reads as one mode.
   */
  import type { CastStatus } from '@shared/ipc'
  import { clock } from '../lib/format'
  import { NUDGE_SECONDS, progressFraction, seekTarget, volumePercent } from '../lib/castremote'
  import type { RemotePhase } from '../lib/castremote'

  interface Props {
    status: CastStatus
    title: string
    /** "S02E22 · Videasy", or the provider alone for a film. */
    subtitle: string
    /** The episode still, when the chrome has loaded the season. */
    artwork: string | null
    phase: RemotePhase
    /** What is happening, whenever the phase is not `playing`. */
    phaseLabel: string
    canPrevious: boolean
    canNext: boolean
    /** Offered only while `stuck`; see the markup for why both exist. */
    onreveal: () => void
    onretry: () => void
    onback: () => void
    onstop: () => void
    ontoggle: () => void
    onseek: (seconds: number) => void
    onnudge: (by: number) => void
    onprevious: () => void
    onnext: () => void
    onvolume: (level: number) => void
    onmute: () => void
  }

  const {
    status,
    title,
    subtitle,
    artwork,
    phase,
    phaseLabel,
    canPrevious,
    canNext,
    onreveal,
    onretry,
    onback,
    onstop,
    ontoggle,
    onseek,
    onnudge,
    onprevious,
    onnext,
    onvolume,
    onmute,
  }: Props = $props()

  /**
   * A control being dragged wins over the poll for a moment after it is let go.
   *
   * The receiver is asked once a second and answers with where it *was*. Fed
   * straight into a slider somebody is holding, that yanks the handle back
   * under their finger; and after a seek it keeps yanking for as long as the
   * receiver takes to act, which on a Chromecast is up to a second — so the
   * seek reads as having been ignored, and invites a second one.
   *
   * `PlayerChrome` holds the same rule for the panel's scrubber. It is stated
   * twice rather than shared because the two are about to stop coexisting: the
   * panel's transport is what this replaces.
   */
  const HOLD_MS = 1_400

  let heldSeconds = $state<number | null>(null)
  let heldUntil = 0
  let heldVolume = $state<number | null>(null)
  let volumeHeldUntil = 0

  /** Ticks so a hold expires on its own, without needing an event to end it. */
  let now = $state(Date.now())
  $effect(() => {
    const tick = setInterval(() => (now = Date.now()), 250)
    return () => clearInterval(tick)
  })

  const seconds = $derived(
    heldSeconds !== null && now < heldUntil ? heldSeconds : (status.seconds ?? 0),
  )
  const level = $derived(
    heldVolume !== null && now < volumeHeldUntil ? heldVolume : (status.volume ?? 0),
  )
  const fraction = $derived(progressFraction(seconds, status.duration))
  const remaining = $derived(Math.max(0, (status.duration || 0) - seconds))
  const busy = $derived(phase !== 'playing')

  function hold(value: number): void {
    heldSeconds = value
    heldUntil = Date.now() + HOLD_MS
    now = Date.now()
  }

  function commitScrub(value: number): void {
    hold(value)
    onseek(seekTarget(status.duration > 0 ? value / status.duration : 0, status.duration))
  }

  function setVolume(percent: number): void {
    heldVolume = percent / 100
    volumeHeldUntil = Date.now() + HOLD_MS
    now = Date.now()
    onvolume(percent / 100)
  }
</script>

<div class="remote">
  <header>
    <button class="ghost" onclick={onback}>← Back</button>
    <span class="device">
      <span class="glyph" aria-hidden="true">▣</span>
      <span class="name">{status.deviceName || 'Television'}</span>
    </span>
    <button class="ghost stop" onclick={onstop}>Stop casting</button>
  </header>

  <div class="stage">
    <div class="art">
      {#if artwork}
        <img src={artwork} alt="" />
      {:else}
        <span class="glyph big" aria-hidden="true">▣</span>
      {/if}
    </div>

    <h1>{title}</h1>
    {#if subtitle}<p class="sub">{subtitle}</p>{/if}

    <!--
      What is happening, whenever it is not simply playing.

      Moving the television to another episode takes several seconds — the embed
      has to load it here first, because that is the only thing that fetches a
      stream — and with some providers it needs a tap this app cannot make on
      the user's behalf. So it is narrated rather than hidden behind a spinner
      that says nothing.
    -->
    {#if busy}
      <p class="phase" class:stuck={phase === 'stuck'} role="status">{phaseLabel}</p>
      <!--
        The one place the remote has to let go of the screen.

        Several providers fetch nothing at all until their own play button is
        pressed, and that button is on the page this is covering. A remote that
        says "press play over there" while making "over there" unreachable is
        worse than no remote — so being stuck comes with the way out, and the
        cast button in the bar brings this back.
      -->
      {#if phase === 'stuck'}
        <div class="escape">
          <button class="ghost" onclick={onreveal}>Show the player</button>
          <button class="ghost" onclick={onretry}>Try again</button>
        </div>
      {/if}
    {:else if !status.proxyRunning}
      <!-- Connected and serving nothing: the television is still attached and
           the stream behind it has stopped, which looks exactly like "paused"
           from the sofa. -->
      <p class="phase stuck" role="status">The stream ended — the television has nothing left to play.</p>
    {/if}
  </div>

  <div class="controls" class:dim={busy}>
    <div class="row">
      <span class="t">{clock(seconds)}</span>
      <input
        type="range"
        min="0"
        max={Math.max(1, Math.round(status.duration))}
        step="1"
        value={Math.round(seconds)}
        disabled={status.duration <= 0 || busy}
        aria-label="Position"
        style="--filled: {Math.round(fraction * 100)}%"
        oninput={(e) => hold(Number(e.currentTarget.value))}
        onchange={(e) => commitScrub(Number(e.currentTarget.value))}
      />
      <span class="t right">-{clock(remaining)}</span>
    </div>

    <!--
      Transport. The primary key is twice the size of the rest, because this is
      the one surface in the app used at arm's length without being looked at —
      that is the argument for the sizes here, not generosity.
    -->
    <div class="transport">
      <button
        class="key"
        onclick={onprevious}
        disabled={!canPrevious || busy}
        title="Previous episode"
        aria-label="Previous episode">⏮</button
      >
      <button
        class="key"
        onclick={() => onnudge(-NUDGE_SECONDS)}
        disabled={busy}
        title="Back {NUDGE_SECONDS} seconds"
        aria-label="Back {NUDGE_SECONDS} seconds">−{NUDGE_SECONDS}s</button
      >
      <button
        class="key primary"
        onclick={ontoggle}
        disabled={busy}
        title={status.playing ? 'Pause on the TV' : 'Play on the TV'}
        aria-label={status.playing ? 'Pause' : 'Play'}>{status.playing ? '❚❚' : '▶'}</button
      >
      <button
        class="key"
        onclick={() => onnudge(NUDGE_SECONDS)}
        disabled={busy}
        title="Forward {NUDGE_SECONDS} seconds"
        aria-label="Forward {NUDGE_SECONDS} seconds">+{NUDGE_SECONDS}s</button
      >
      <button
        class="key"
        onclick={onnext}
        disabled={!canNext || busy}
        title="Next episode"
        aria-label="Next episode">⏭</button
      >
    </div>

    <!--
      Volume, and it is the receiver's own — `SET_VOLUME` on the receiver
      namespace, not a media-session command. Said out loud underneath, because
      on any television doing HDMI-CEC this is the set's volume: a user
      expecting an app slider would find it has changed what the news plays at
      too. The slider stays live while the phase is busy, unlike the transport —
      volume is the one command that works with nothing playing.
    -->
    <div class="row volume">
      <button
        class="key small"
        onclick={onmute}
        title={status.muted ? 'Unmute the television' : 'Mute the television'}
        aria-label={status.muted ? 'Unmute the television' : 'Mute the television'}
        >{status.muted ? '🔇' : '🔊'}</button
      >
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={volumePercent(level)}
        aria-label="Television volume"
        style="--filled: {status.muted ? 0 : volumePercent(level)}%"
        oninput={(e) => setVolume(Number(e.currentTarget.value))}
      />
      <span class="t right">{status.muted ? 'muted' : `${volumePercent(level)}%`}</span>
    </div>
    <p class="note">Volume is the television's own.</p>
  </div>
</div>

<style>
  /*
    Opaque and edge to edge. Everything else in this document is deliberately
    transparent so the picture reads through it; this one is the exception,
    because while it is up there is no picture to read through.
  */
  .remote {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 12px 16px 22px;
    box-sizing: border-box;
    background: radial-gradient(120% 90% at 50% 0%, #15161d, #050508 72%);
    color: #e9e9ee;
    font:
      500 13px/1.35 Inter,
      system-ui,
      sans-serif;
    overflow: hidden;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex: none;
  }

  .device {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: #cfe0ff;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ghost {
    flex-shrink: 0;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 7px;
    color: inherit;
    cursor: pointer;
    font: inherit;
    padding: 8px 12px;
    white-space: nowrap;
  }

  .ghost:hover {
    background: rgba(255, 255, 255, 0.16);
  }

  .ghost.stop:hover {
    background: rgba(251, 92, 118, 0.22);
    border-color: rgba(251, 92, 118, 0.5);
  }

  /*
    The middle takes whatever is left and centres inside it, so the controls
    stay a constant distance from the bottom edge — the same buttons in the
    same place whether this is a 915px phone or a 1080p window.
  */
  .stage {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    text-align: center;
  }

  .art {
    width: min(42vh, 55%);
    aspect-ratio: 16 / 9;
    border-radius: 12px;
    overflow: hidden;
    background: #17171d;
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55);
    display: grid;
    place-items: center;
    margin-bottom: 8px;
  }

  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .glyph.big {
    font-size: 34px;
    color: #4a4a57;
  }

  h1 {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
    line-height: 1.25;
  }

  .sub {
    margin: 0;
    font-size: 12px;
    color: #9a9aa6;
  }

  .phase {
    margin: 6px 0 0;
    padding: 7px 14px;
    border-radius: 999px;
    max-width: 92%;
    font-size: 12px;
    background: rgba(91, 157, 250, 0.18);
    color: #cfe0ff;
  }

  .phase.stuck {
    background: rgba(255, 255, 255, 0.07);
    color: #9a9aa6;
  }

  .escape {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }

  /* Centred and bounded: stretched across a 1080p window the time bar becomes
     a scrub with pixel-per-minute precision and the keys drift apart. */
  .controls {
    flex: none;
    width: 100%;
    max-width: 460px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  /* Dimmed rather than removed while the television is being moved to another
     episode: the transport below is about a position about to be discarded,
     but taking it off screen would make the remote jump. */
  .controls.dim {
    opacity: 0.45;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .t {
    font-size: 11px;
    color: #9a9aa6;
    font-variant-numeric: tabular-nums;
    min-width: 46px;
    flex: none;
  }

  .t.right {
    text-align: right;
  }

  /*
    One slider style for both bars.

    `--filled` is set inline and painted into the track's own gradient rather
    than with a pseudo-element, because the fill has to sit *behind* the native
    thumb — and a gradient stop is the only way to do that which works both in
    a `WebContentsView` and in an Android WebView without two separate hacks.
  */
  input[type='range'] {
    flex: 1;
    min-width: 0;
    height: 30px;
    margin: 0;
    appearance: none;
    background: transparent;
    cursor: pointer;
  }

  input[type='range']::-webkit-slider-runnable-track {
    height: 6px;
    border-radius: 999px;
    background: linear-gradient(
      to right,
      #6ea8ff 0 var(--filled),
      rgba(255, 255, 255, 0.16) var(--filled) 100%
    );
  }

  input[type='range']::-webkit-slider-thumb {
    appearance: none;
    width: 18px;
    height: 18px;
    margin-top: -6px;
    border-radius: 50%;
    background: #e9e9ee;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5);
  }

  input[type='range']:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .transport {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
  }

  /* Fifty-six pixels minimum, well past the 48dp Material floor, because this
     is pressed with a thumb while the user is looking at a television. */
  .key {
    min-width: 56px;
    height: 56px;
    padding: 0 10px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.07);
    color: #e9e9ee;
    font: inherit;
    font-size: 14px;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition:
      background 120ms ease-out,
      transform 120ms ease-out;
  }

  .key:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.14);
  }

  .key:active:not(:disabled) {
    transform: scale(0.94);
  }

  .key:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .key.primary {
    min-width: 88px;
    height: 70px;
    border-radius: 20px;
    background: #5b9dfa;
    border-color: #6ea8ff;
    color: #071021;
    font-size: 20px;
  }

  .key.primary:hover:not(:disabled) {
    background: #6ea8ff;
  }

  .key.small {
    min-width: 44px;
    height: 44px;
    border-radius: 12px;
    font-size: 15px;
  }

  .note {
    margin: -8px 0 0;
    text-align: center;
    font-size: 11px;
    color: #6f6f7c;
  }

  /*
    Short and wide — a desktop window, or a phone the user has not turned back
    upright. The artwork is the first thing to go: it is the only element here
    that is decoration rather than a control.

    Declared last, because a `@media` block carries no extra specificity and
    only wins on source order.
  */
  @media (max-height: 520px) {
    .art {
      display: none;
    }

    .remote {
      gap: 10px;
      padding-bottom: 14px;
    }

    .key {
      height: 48px;
    }

    .key.primary {
      height: 56px;
    }
  }
</style>
