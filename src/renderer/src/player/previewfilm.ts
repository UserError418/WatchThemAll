/**
 * A source's film, played as the detail view's preview.
 *
 * The preview is the player with everything of ours taken away (the owner,
 * 2026-09-27: "without ever showing any player controls, just like the YouTube
 * implementation"). What is left is this: find the film, hide the source's
 * page around it, start it where the viewer is, keep it muted or not as the
 * sound button says, and say when it is really playing, so the page can show
 * it only then. Until then the page keeps its backdrop, and a preview that
 * never gets there simply never appears.
 *
 * Both apps use it. The desktop runs it in the player shell's preview mode
 * (`player.ts`, inside a `<webview>`); the phone runs it in the app's own
 * page, next to the preview iframe. Plain TypeScript over `FilmLink`, with the
 * clock passed in, so the rules are testable without a frame.
 */

import type { PreviewReport } from '@shared/ipc'
import type { FilmLink } from './filmlink'

/** When to press the source's own play control while it has no film yet (as the player does). */
export const PRESS_AT_MS = [2_500, 6_000, 11_000]

/**
 * The shortest thing taken for the film rather than an advert.
 *
 * A source may play an advert first, and one that starts playing must not be
 * what the preview shows. Two minutes is below any episode and above any
 * advert measured on these sources.
 */
export const MIN_FILM_SECONDS = 120

/**
 * How near the saved place counts as there. `shouldSeek` in `main/resume.ts`
 * is the player's rule and this is its core: go forward to the saved place
 * unless already within 30 s of it, and never backwards past a source that
 * has resumed further on by itself.
 */
export const RESUMED_TOLERANCE_SECONDS = 30
const SEEK_RETRY_MS = 2_500
const SEEK_ATTEMPTS = 4

/** The same report on both platforms; the desktop's travels as `PREVIEW_STATE`. */
export type PreviewFilmState = PreviewReport

export class PreviewFilm {
  private started = false
  /** When the film first reported itself, with a film's length: its media had arrived. */
  private filmSeenAt: number | null = null
  /** When the film was first seen playing, time moving, wherever it was. */
  private streamedAt: number | null = null
  private playingAt: number | null = null
  private seeks = 0
  private lastSeekAt = Number.NEGATIVE_INFINITY
  private presses = 0
  /** Paused by the viewer (Space, while the preview stands in for the player); it stays so. */
  private wantPaused = false
  private readonly openedAt: number

  constructor(
    private readonly link: FilmLink,
    private readonly startSeconds: number,
    private muted: boolean,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.openedAt = now()
    // Hidden from the first report: nothing of the source's page is ever
    // wanted here, and the page is not shown before the film plays anyway.
    link.setHidden(true)
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.link.setMuted(muted)
  }

  /**
   * Pause or play at the viewer's word. Only while the preview stands in for
   * the player (`shared/carryover.ts`); a preview is otherwise always playing.
   */
  setPaused(paused: boolean): void {
    this.wantPaused = paused
    this.link.setPaused(paused)
  }

  /**
   * Act on what the frames last reported. Called after every report and on a
   * heartbeat; each call does at most one of each thing, so calling it often
   * costs nothing.
   */
  step(): PreviewFilmState {
    const film = this.link.view().film
    const now = this.now()

    if (film === null || film.duration < MIN_FILM_SECONDS) {
      this.playingAt = null
      // Several sources fetch nothing until their own play control is
      // pressed; press it for them, a few times, as the player does.
      const due = PRESS_AT_MS[this.presses]
      if (due !== undefined && now - this.openedAt >= due) {
        this.presses += 1
        this.link.pressPlay()
      }
      return this.state()
    }

    this.filmSeenAt ??= now
    if (film.muted !== this.muted) this.link.setMuted(this.muted)

    const behind = this.startSeconds - film.seconds
    if (
      this.startSeconds > 0 &&
      behind > RESUMED_TOLERANCE_SECONDS &&
      this.seeks < SEEK_ATTEMPTS &&
      now - this.lastSeekAt >= SEEK_RETRY_MS
    ) {
      this.seeks += 1
      this.lastSeekAt = now
      this.link.seekTo(this.startSeconds)
    }

    // Kept as the viewer wants it, once the link has stopped holding the last word.
    if (this.link.wanted() === null && !film.ended && film.paused !== this.wantPaused) {
      this.link.setPaused(this.wantPaused)
    }

    // Started means two reports in a row, playing, the second further on:
    // a bare 'play' is not enough, because a source can abort that play at
    // once with a load of its own (the player's rule, for VidRock).
    if (film.paused) this.playingAt = null
    else {
      if (this.playingAt !== null && film.seconds > this.playingAt + 0.2) {
        // Playing, which is what a test calls streaming; shown only once it
        // is also at the saved place.
        this.streamedAt ??= now
        if (!this.seeking(film.seconds)) this.started = true
      }
      this.playingAt = film.seconds
    }
    return this.state()
  }

  /**
   * How long the stream took, once it is proven by playing: to the moment
   * the film first reported itself, which is when a test would have seen its
   * media arrive. Timed to the playing itself, it would carry the two
   * reports that proof takes (a heartbeat apart) and read slower than a test
   * of the same source.
   */
  private streamedMs(): number | null {
    if (this.streamedAt === null || this.filmSeenAt === null) return null
    return Math.round(this.filmSeenAt - this.openedAt)
  }

  /** Still on the way to the saved place: showing the film now would show the wrong minute. */
  private seeking(seconds: number): boolean {
    return (
      this.startSeconds > 0 &&
      this.startSeconds - seconds > RESUMED_TOLERANCE_SECONDS &&
      this.seeks < SEEK_ATTEMPTS
    )
  }

  state(): PreviewFilmState {
    const film = this.link.view().film
    const real = film !== null && film.duration >= MIN_FILM_SECONDS
    return {
      started: this.started,
      seconds: real ? film.seconds : 0,
      duration: real ? film.duration : 0,
      playing: real && !film.paused,
      waiting: real && film.waiting,
      muted: this.muted,
      streamedMs: this.streamedMs(),
    }
  }
}
