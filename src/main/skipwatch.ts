/**
 * Which skip button is on screen, reading by reading, for one loaded episode.
 *
 * Shared by the desktop's player (`playerview.ts`) and the phone's bridge,
 * which each feed it the film's position and act on a press. Until 2.0.6 the
 * desktop alone had a Skip Intro button, and it rarely appeared (the owner,
 * 2026-09-29: "very flakey"). Three causes, each fixed here:
 *
 * - The databases were asked at the first reading and the answer vetted
 *   against that reading's length, once. The first reading is often an
 *   advert, or a length that has not settled, so the vetting refused
 *   everything and the episode kept "nothing" for good. Now the databases are
 *   asked only once the length fits the episode, and the answers are vetted
 *   again on every reading, which costs nothing.
 * - A failed request counted as "no data" for the rest of the episode. It is
 *   asked again, a few times; clean answers are cached (`skipsources.ts`), so
 *   only the failures go back to the network.
 * - The phone had no button at all: vetting needs the film's length, which a
 *   cross-origin frame kept from it until the film relay.
 *
 * It also offers more than the intro: "Skip recap" over a "previously on",
 * and "Next episode" over the credits of a series that has one.
 */

import type { SkipOffer } from '@shared/ipc'
import { lengthVerdict } from './runtimecheck'
import { chooseEachKind, isWithinOffer, skipTarget, vetSegment, type SkipSegment } from './skiptimes'

/** Asked again after a lookup found nothing, in case that was a failure. */
export const SKIP_RETRY_MS = 30_000
/** How many times a lookup is made for one episode, the first included. */
const SKIP_LOOKUPS = 3

export interface SkipReading {
  seconds: number
  duration: number | null
}

export interface SkipWatchDeps {
  /** The owner's switch, read at every reading: turning it off stops the lookups at once. */
  enabled(): boolean
  /** TMDB's runtime of the episode loaded, for telling an advert from it. */
  expectedMinutes(): number | null
  /** Every segment the databases have for the episode loaded (`findSegments`). */
  lookup(streamSeconds: number): Promise<SkipSegment[]>
  /** Whether there is an aired episode after this one; asked once, when credits are found. */
  hasNext(): Promise<boolean>
  /** Put this button up, or take it down with null. Called only on a change. */
  announce(offer: SkipOffer | null): void
  log?(line: string): void
  now?(): number
}

/** What a press asks the host to do. */
export type SkipAction = { kind: 'seek'; seconds: number } | { kind: 'next' }

export class SkipWatch {
  /** The databases' answers for this episode, unvetted; null until one arrives. */
  private segments: SkipSegment[] | null = null
  private asking = false
  private lookups = 0
  private lastLookupAt = 0
  /** Null until asked; asked only when credits survive vetting. */
  private next: boolean | null = null
  private askingNext = false
  /** The segment behind the button on screen. */
  private shown: SkipSegment | null = null
  /** Pressed segments, not offered again this episode. */
  private readonly pressed = new Set<SkipSegment>()
  /** Verdicts already logged, so each is logged once. */
  private readonly logged = new Set<string>()
  /** Bumped by `reset`, so an answer about the episode left is dropped. */
  private generation = 0
  private readonly now: () => number

  constructor(private readonly deps: SkipWatchDeps) {
    this.now = deps.now ?? Date.now
  }

  /** One reading of the film; null when there is none (the element has gone). */
  reading(reading: SkipReading | null): void {
    if (reading === null || !this.deps.enabled()) {
      this.show(null)
      return
    }
    const duration = reading.duration
    // Nothing is asked or vetted against a length that is not the episode's:
    // an advert's, or one still settling.
    if (duration === null || !Number.isFinite(duration) || duration <= 0) return
    if (lengthVerdict(duration, this.deps.expectedMinutes()) === 'implausible') {
      this.show(null)
      return
    }
    this.lookUp(duration)
    this.show(this.segmentAt(reading.seconds, duration))
  }

  /** The button was pressed: what to do, or null if it had already gone. */
  press(): SkipAction | null {
    const segment = this.shown
    if (segment === null) return null
    this.pressed.add(segment)
    this.show(null)
    return segment.kind === 'outro' ? { kind: 'next' } : { kind: 'seek', seconds: skipTarget(segment) }
  }

  /** Another episode, or another source's cut of it: nothing known carries over. */
  reset(): void {
    this.generation += 1
    this.segments = null
    this.asking = false
    this.lookups = 0
    this.lastLookupAt = 0
    this.next = null
    this.askingNext = false
    this.pressed.clear()
    this.logged.clear()
    this.show(null)
  }

  private lookUp(duration: number): void {
    if (this.asking || this.lookups >= SKIP_LOOKUPS) return
    if (this.segments !== null && this.segments.length > 0) return
    if (this.lookups > 0 && this.now() - this.lastLookupAt < SKIP_RETRY_MS) return
    this.asking = true
    this.lookups += 1
    this.lastLookupAt = this.now()
    const generation = this.generation
    void this.deps
      .lookup(duration)
      .catch(() => [])
      .then((found) => {
        if (generation !== this.generation) return
        this.asking = false
        this.segments = found
      })
  }

  /** The vetted segment whose button belongs on screen at `seconds`, if any. */
  private segmentAt(seconds: number, duration: number): SkipSegment | null {
    if (this.segments === null) return null
    const vetted = this.segments.filter((segment) => {
      const vet = vetSegment({ segment, streamSeconds: duration, expectedMinutes: this.deps.expectedMinutes() })
      this.logOnce(segment, vet.ok, vet.reason)
      return vet.ok
    })
    const chosen = chooseEachKind(vetted)
    if (chosen.some((s) => s.kind === 'outro')) this.askNext()
    return (
      chosen.find(
        (s) => !this.pressed.has(s) && isWithinOffer(s, seconds) && (s.kind !== 'outro' || this.next === true),
      ) ?? null
    )
  }

  private askNext(): void {
    if (this.next !== null || this.askingNext) return
    this.askingNext = true
    const generation = this.generation
    void this.deps
      .hasNext()
      .catch(() => false)
      .then((next) => {
        if (generation !== this.generation) return
        this.askingNext = false
        this.next = next
      })
  }

  private show(segment: SkipSegment | null): void {
    if (segment === this.shown) return
    this.shown = segment
    this.deps.announce(segment === null ? null : { kind: segment.kind === 'outro' ? 'next' : segment.kind })
  }

  private logOnce(segment: SkipSegment, ok: boolean, reason: string): void {
    const key = `${segment.source}:${segment.kind}:${ok}`
    if (this.logged.has(key)) return
    this.logged.add(key)
    this.deps.log?.(`[skip] ${segment.source} ${segment.kind} ${ok ? 'accepted' : 'rejected'}: ${reason}`)
  }
}
