<script lang="ts">
  /**
   * A YouTube trailer, shown as soon as it exists.
   *
   * ## What this used to do, and why it stopped
   *
   * YouTube paints a start-up overlay over the first seconds of an embed —
   * transport buttons dead centre, title top-left, wordmark bottom-right — and
   * `controls=0&modestbranding=1&rel=0` does not remove it. This component
   * previously held the video back behind an opaque still of the artwork until
   * YouTube's iframe API reported PLAYING, then cross-faded.
   *
   * It worked, and the cost was the whole point of a preview. Nothing appeared
   * until the embed had loaded *and* started playing *and* served out a fade —
   * seconds, over a network fetch of unknown length — so the feature that
   * exists to make browsing feel alive was the slowest thing on the page. It
   * was removed deliberately, not lost: the trade was one that only made sense
   * if it actually removed the chrome, and the chrome came back anyway.
   *
   * The overlay is now attacked where it lives instead. `main/embedchrome.ts`
   * injects a stylesheet into the embed's own document, which an Electron main
   * process can do to a cross-origin frame and a web page cannot. That costs no
   * time at all, so the video simply plays from the first frame it has.
   *
   * What remains here is the crop in `.embed-cover`, which overscans the iframe
   * so anything drawn at the very edges falls outside the visible box. It is a
   * backstop for whatever the stylesheet misses.
   *
   * ## Why the postMessage handshake is still here
   *
   * Not for revealing anything any more — for sound. `muted` is deliberately
   * not part of the URL: it used to be, and that made the sound state part of
   * the document's identity, so every change reloaded the iframe and restarted
   * the video. Previews hand the sound between themselves as the pointer moves,
   * so that fired constantly. The frame now always starts muted — the only kind
   * of autoplay every engine permits without a gesture — and the sound is
   * applied afterwards over the iframe API.
   */

  interface Props {
    /** The YouTube video id. */
    videoKey: string
    /** Whether this preview should be silent. */
    muted: boolean
    /** For the iframe's accessible name. */
    title: string
  }

  const { videoKey, muted, title }: Props = $props()

  /**
   * The embed URL, built here rather than by each caller.
   *
   * Both surfaces were composing the same string, so `enablejsapi=1` would have
   * had to be added in two places and the handshake below would have silently
   * done nothing wherever it was missed.
   *
   * `origin` is required for the API to accept our messages. The renderer is
   * served over http rather than file:// precisely so embeds have a real origin
   * to name.
   */
  const src = $derived(
    `https://www.youtube-nocookie.com/embed/${videoKey}` +
      `?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0` +
      `&loop=1&playlist=${videoKey}&playsinline=1&iv_load_policy=3&disablekb=1` +
      `&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`,
  )

  const YOUTUBE_ORIGIN = 'https://www.youtube-nocookie.com'

  let frame = $state<HTMLIFrameElement | null>(null)
  /**
   * Whether the player has reported anything at all.
   *
   * Commands sent before it exists are dropped, so the sound is applied only
   * once something has answered — and re-applied on every change after that.
   */
  let playerLive = $state(false)

  /** Send one IFrame-API command to this embed's player. */
  function command(func: string): void {
    frame?.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func, args: [], id: 1, channel: 'widget' }),
      YOUTUBE_ORIGIN,
    )
  }

  /**
   * Apply the sound state, without touching the document.
   *
   * Re-runs on every `muted` change and once the player first answers, which
   * covers both the user pressing the nav button and one preview surface taking
   * the sound from another mid-playback.
   */
  $effect(() => {
    if (!playerLive) return
    command(muted ? 'mute' : 'unMute')
  })

  /**
   * Ask the player to report its state.
   *
   * Posted repeatedly for a short while rather than once on `load`: an iframe
   * fires `load` for the empty `about:blank` document it starts with, before it
   * has navigated to the embed, and a listener registered against that document
   * is thrown away. Retrying costs nothing — the API tolerates a repeated
   * `listening` — and removes the ordering problem entirely.
   */
  $effect(() => {
    const iframe = frame
    if (!iframe) return
    void src
    playerLive = false

    const post = (message: object): void => {
      iframe.contentWindow?.postMessage(JSON.stringify(message), YOUTUBE_ORIGIN)
    }

    const handshake = (): void => {
      post({ event: 'listening', id: 1, channel: 'widget' })
      post({
        event: 'command',
        func: 'addEventListener',
        args: ['onStateChange'],
        id: 1,
        channel: 'widget',
      })
    }

    const retry = setInterval(handshake, 400)
    const giveUpRetrying = setTimeout(() => clearInterval(retry), 6_000)
    handshake()

    const onMessage = (event: MessageEvent): void => {
      // Only this frame's player. Several previews can be alive at once — a
      // hovered card over an open detail overlay — and one answering must not
      // be taken as an answer from another.
      if (event.origin !== YOUTUBE_ORIGIN) return
      if (event.source !== iframe.contentWindow) return
      if (typeof event.data !== 'string') return

      let payload: unknown
      try {
        payload = JSON.parse(event.data)
      } catch {
        // The API also emits non-JSON frames; they are not for us.
        return
      }

      // Two shapes carry the state: the event we subscribed to, and the
      // periodic `infoDelivery` the player sends anyway. Accepting both means a
      // missed subscription still leaves the sound controllable.
      const message = payload as { event?: string; info?: number | { playerState?: number } }
      const state =
        typeof message.info === 'number'
          ? message.info
          : typeof message.info === 'object' && message.info !== null
            ? message.info.playerState
            : undefined

      if (state === undefined) return
      // Any state at all means the player exists and will accept commands.
      playerLive = true
    }

    window.addEventListener('message', onMessage)

    return () => {
      clearInterval(retry)
      clearTimeout(giveUpRetrying)
      window.removeEventListener('message', onMessage)
    }
  })
</script>

<div class="embed-cover-frame">
  <iframe
    bind:this={frame}
    class="embed-cover"
    {src}
    {title}
    allow="autoplay; encrypted-media"
    referrerpolicy="strict-origin"
    tabindex="-1"
  ></iframe>
</div>
