<script lang="ts">
  /**
   * A YouTube trailer, shown as soon as it exists.
   *
   * ## What this used to do, and why it stopped
   *
   * YouTube paints a start-up overlay over the first seconds of an embed —
   * transport buttons dead centre, title and channel top-left, wordmark and a
   * "More videos" strip along the bottom — and `controls=0&modestbranding=1&rel=0`
   * does not remove it. This component previously held the video back behind an
   * opaque still of the artwork until YouTube's iframe API reported PLAYING,
   * then cross-faded.
   *
   * It worked, and the cost was the whole point of a preview. Nothing appeared
   * until the embed had loaded *and* started playing *and* served out a fade —
   * seconds, over a network fetch of unknown length — so the feature that
   * exists to make browsing feel alive was the slowest thing on the page. It
   * was removed deliberately, not lost.
   *
   * ## Where the chrome is dealt with now
   *
   * Inside the embed's own document. `main/embedchrome.ts` injects a stylesheet
   * into it, which an Electron main process can do to a cross-origin frame and
   * a web page cannot. That stylesheet hides YouTube's whole control layer and
   * its captions, and makes the embed's page background transparent — so until
   * the first video frame arrives, whatever sits behind the iframe (the card's
   * artwork, the overlay's backdrop) shows through instead of a black box. The
   * video then simply plays from the first frame it has; nothing here waits.
   *
   * Captions are also switched off over the iframe API (see `onPlayerState`).
   * YouTube turns them on by itself for muted autoplay, which is exactly how
   * every preview starts, and `cc_load_policy=0` does not stop it — measured,
   * it changes nothing. The stylesheet alone would hide them; unloading the
   * module means they are never fetched or laid out either.
   *
   * What remains here is the crop in `.embed-cover`, which overscans the iframe
   * so anything drawn at the very edges falls outside the visible box. It is a
   * backstop for whatever the stylesheet misses.
   *
   * ## Why the postMessage handshake is here
   *
   * Three jobs, none of which can go in the URL:
   *
   * - **Sound.** `muted` is deliberately not part of the URL: it used to be,
   *   and that made the sound state part of the document's identity, so every
   *   change reloaded the iframe and restarted the video. Previews hand the
   *   sound between themselves as the pointer moves, so that fired constantly.
   *   The frame always starts muted — the only kind of autoplay every engine
   *   permits without a gesture — and the sound is applied afterwards.
   * - **Captions**, as above.
   * - **Where the video got to.** The player reports `currentTime` about four
   *   times a second. Those reports go into `lib/trailerposition.ts`, and the
   *   next preview of the same video within a minute starts from there — the
   *   detail overlay continues the card's trailer instead of replaying its
   *   opening seconds.
   *
   * ## How a preview resumes
   *
   * With the `start` URL parameter, read once when the embed is created. The
   * alternative, a `seekTo` once the player answers, would show the first
   * frames from 0 and then jump — the very repetition this exists to avoid —
   * and pay a second buffering stall for the seek. `start` only applies to the
   * first play: measured with `loop=1&playlist=`, the loop still goes back to
   * 0, which is what a trailer that has run out should do.
   */

  import { positionNow, startParameter, trailerPositions } from '../lib/trailerposition'

  interface Props {
    /** The YouTube video id. */
    videoKey: string
    /** Whether this preview should be silent. */
    muted: boolean
    /** For the iframe's accessible name. */
    title: string
  }

  const { videoKey, muted, title }: Props = $props()

  /** YouTube's player states, as reported over the iframe API. */
  const PLAYING = 1

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
   *
   * The resume lookup sits inside the derivation on purpose: it runs once per
   * video id, when the iframe is created, and never again for the life of the
   * frame — a changing `start` would change the URL and reload the video.
   */
  const src = $derived.by(() => {
    const start = startParameter(trailerPositions.lookup(videoKey))
    return (
      `https://www.youtube-nocookie.com/embed/${videoKey}` +
      `?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0` +
      `&loop=1&playlist=${videoKey}&playsinline=1&iv_load_policy=3&disablekb=1` +
      (start === null ? '' : `&start=${start}`) +
      `&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`
    )
  })

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
  function command(func: string, args: unknown[] = []): void {
    frame?.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func, args, id: 1, channel: 'widget' }),
      YOUTUBE_ORIGIN,
    )
  }

  /**
   * Apply the sound state, without touching the document.
   *
   * Re-runs on every `muted` change and once the player first answers, which
   * covers both the user pressing a sound button and one preview surface taking
   * the sound from another mid-playback.
   */
  $effect(() => {
    if (!playerLive) return
    command(muted ? 'mute' : 'unMute')
  })

  /**
   * Talk to the player: ask it to report, and act on what it reports.
   *
   * The handshake is posted repeatedly for a short while rather than once on
   * `load`: an iframe fires `load` for the empty `about:blank` document it
   * starts with, before it has navigated to the embed, and a listener
   * registered against that document is thrown away. Retrying costs nothing —
   * the API tolerates a repeated `listening` — and removes the ordering problem
   * entirely.
   */
  $effect(() => {
    const iframe = frame
    if (!iframe) return
    void src
    // Captured, so the teardown below files the position under the video that
    // was actually playing even if the prop has already moved on.
    const key = videoKey
    playerLive = false

    /** The latest `currentTime` the player reported, and when it arrived. */
    let reported: { seconds: number; at: number } | null = null
    let playing = false
    /**
     * Whether playback has actually begun. Reports before that describe where
     * the player *intends* to start, not anything the user saw, so they are
     * not worth remembering.
     */
    let started = false

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

    /**
     * Called for every state the player reports.
     *
     * The captions module is unloaded on *each* report rather than once,
     * because the player loads it lazily: measured, a single unload sent on the
     * first report (BUFFERING) arrived before the module existed and captions
     * appeared anyway, while repeating it on the next report (PLAYING) kept
     * them away for good. States change a handful of times per play, so this
     * is a few messages, not a stream.
     */
    const onPlayerState = (state: number): void => {
      // Any state at all means the player exists and will accept commands.
      playerLive = true
      playing = state === PLAYING
      if (playing) started = true
      command('unloadModule', ['captions'])
    }

    const onPosition = (seconds: number): void => {
      reported = { seconds, at: Date.now() }
      // Recorded live, not only on teardown: see `TrailerPositions.record`.
      if (started) trailerPositions.record(key, seconds)
    }

    const onMessage = (event: MessageEvent): void => {
      // Only this frame's player. Several previews can be alive at once — a
      // hovered card under an open detail overlay — and one answering must not
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

      // Two shapes carry the state: the `onStateChange` event we subscribed
      // to, whose `info` is the bare state number, and the periodic
      // `infoDelivery`, whose `info` object carries `playerState` only when it
      // changed and `currentTime` on every tick. Accepting both means a missed
      // subscription still leaves the sound and captions controllable.
      const message = payload as {
        info?: number | { playerState?: number; currentTime?: number }
      }
      const info = message.info
      if (typeof info === 'number') {
        onPlayerState(info)
        return
      }
      if (typeof info !== 'object' || info === null) return
      if (typeof info.playerState === 'number') onPlayerState(info.playerState)
      if (typeof info.currentTime === 'number') onPosition(info.currentTime)
    }

    window.addEventListener('message', onMessage)

    return () => {
      clearInterval(retry)
      clearTimeout(giveUpRetrying)
      window.removeEventListener('message', onMessage)
      // The preview is going away — the pointer left the card, the overlay
      // closed, or real playback began. Where it stopped is what the next
      // preview of this video resumes from.
      if (started && reported) trailerPositions.record(key, positionNow(reported, playing, Date.now()))
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
